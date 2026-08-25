import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ComputeBudgetProgram } from "@solana/web3.js";
import BN from "bn.js";
import { SolanaCoreContracts } from "../../target/types/solana_core_contracts.js";
import { expect, AssertionError } from "chai";
import * as bitcoin from "bitcoinjs-lib";
import { secp256k1 } from "@noble/curves/secp256k1";
import { ethers } from "ethers";
import { contracts, utils as signetUtils } from "signet.js";
import * as varuint from "varuint-bitcoin";
import { Hex, hexToBytes } from "viem";
import {
  ChainSignatureServer,
  BitcoinAdapterFactory,
  IBitcoinAdapter,
  CryptoUtils,
} from "fakenet-signer";

const { getRequestIdBidirectional } = contracts.solana;
import { CONFIG, SERVER_CONFIG } from "../../utils/envConfig";
import { randomBytes } from "crypto";

export interface UTXO {
  txid: string;
  vout: number;
  value: number;
  status?: {
    confirmed: boolean;
    block_height?: number;
  };
}
export interface BtcInput {
  txid: number[];
  vout: number;
  scriptPubkey: Buffer;
  value: BN;
}

export interface BtcOutput {
  scriptPubkey: Buffer;
  value: BN;
}

export interface BtcDepositParams {
  lockTime: number;
  caip2Id: string;
  vaultScriptPubkey: Buffer;
}

export interface BtcWithdrawParams extends BtcDepositParams {
  recipientScriptPubkey: Buffer;
  fee: BN;
}

export type AffinePoint = {
  x: number[];
  y: number[];
};

export type ChainSignaturePayload = {
  bigR: AffinePoint;
  s: number[];
  recoveryId: number;
};

export type ProcessedSignature = {
  r: string;
  s: string;
  v: bigint;
};

let provider: anchor.AnchorProvider;
let program: Program<SolanaCoreContracts>;
let btcUtils: BitcoinUtils;
let server: ChainSignatureServer | null = null;
let bitcoinAdapter: IBitcoinAdapter;
let chainSignatureContract: InstanceType<
  typeof contracts.solana.ChainSignatureContract
>;

export type BitcoinTestContext = {
  provider: anchor.AnchorProvider;
  program: Program<SolanaCoreContracts>;
  btcUtils: BitcoinUtils;
  bitcoinAdapter: IBitcoinAdapter;
  server: ChainSignatureServer | null;
  chainSignatureContract: InstanceType<
    typeof contracts.solana.ChainSignatureContract
  >;
};

let contextRefCount = 0;

const requireContext = (): BitcoinTestContext => {
  if (
    !provider ||
    !program ||
    !btcUtils ||
    !bitcoinAdapter ||
    !chainSignatureContract
  ) {
    throw new Error(
      "Bitcoin test context not initialized. Call setupBitcoinTestContext first."
    );
  }
  return {
    provider,
    program,
    btcUtils,
    bitcoinAdapter,
    server,
    chainSignatureContract,
  };
};

// Bitcoin conversion
export const SATS_PER_BTC = 100_000_000;

// Compute budget for on-chain address derivation
export const COMPUTE_UNITS = 1_400_000;

// Bitcoin transaction constants
const BTC_TX_VERSION = 2;
const BTC_SEQUENCE_FINAL = 0xffffffff;
const DEFAULT_LOCK_TIME = 0;

// Deposit/withdrawal amounts and fees
export const DEFAULT_DEPOSIT_AMOUNT = 5_000;
export const WITHDRAW_FEE_BUDGET = 500;
export const SYNTHETIC_TX_FEE = 200;
const MIN_WITHDRAW_CHANGE_SATS = 600;

// Multi-input deposit configuration
const MULTI_INPUT_TARGET = 4;
const MULTI_INPUT_BASE_FEE = 400;
const MULTI_INPUT_CHANGE_DIVISOR = 4;

// Mock transaction defaults
const DEFAULT_MOCK_FEE = 25;

// UTXO funding configuration
const DEFAULT_FUNDING_SATS = 60_000;
const FUNDING_INCREMENT_SATS = 10_000;
const MIN_FUNDING_SATS = 10_000;
const MAX_UTXO_FUNDING_ATTEMPTS = 5;
const UTXO_POLL_INTERVAL_MS = 2_000;

// Authority funding configuration
const FUNDED_AUTHORITY_SOL = 0.005;
const MAX_FUNDING_ATTEMPTS = 3;
const FUNDING_RETRY_DELAY_MS = 500;

// Public key format constants
const UNCOMPRESSED_PUBKEY_LENGTH = 65;
const UNCOMPRESSED_PUBKEY_PREFIX = 0x04;
const COMPRESSED_PUBKEY_EVEN_PREFIX = 0x02;
const COMPRESSED_PUBKEY_ODD_PREFIX = 0x03;

export const getBitcoinTestContext = (): BitcoinTestContext => requireContext();

/**
 * Lazily boots the shared Bitcoin test harness (Anchor provider, program, BTC utils, adapter, optional local Chain Signatures server).
 * Reference counted so multiple suites can call setup/teardown without double-initializing or early shutdown.
 */
export async function setupBitcoinTestContext(): Promise<BitcoinTestContext> {
  if (contextRefCount === 0) {
    provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    program = anchor.workspace
      .SolanaCoreContracts as Program<SolanaCoreContracts>;

    await ensureVaultConfigInitialized(program, provider);

    btcUtils = new BitcoinUtils(CONFIG.BITCOIN_NETWORK);
    bitcoinAdapter = await BitcoinAdapterFactory.create(CONFIG.BITCOIN_NETWORK);

    chainSignatureContract = new contracts.solana.ChainSignatureContract({
      provider,
      programId: CONFIG.CHAIN_SIGNATURES_PROGRAM_ID,
      config: {
        rootPublicKey: CONFIG.MPC_ROOT_PUBLIC_KEY as `04${string}`,
      },
    });

    if (!SERVER_CONFIG.DISABLE_LOCAL_CHAIN_SIGNATURE_SERVER) {
      // Fetch the latest program signature so the server skips historical backfill
      const programPubkey = new anchor.web3.PublicKey(
        CONFIG.CHAIN_SIGNATURES_PROGRAM_ID
      );
      const recentSigs = await provider.connection.getSignaturesForAddress(
        programPubkey,
        { limit: 1 },
        "confirmed"
      );
      const lastBackfillSignature = recentSigs[0]?.signature;

      const serverConfig = {
        solanaRpcUrl: SERVER_CONFIG.SOLANA_RPC_URL,
        solanaPrivateKey: SERVER_CONFIG.SOLANA_PRIVATE_KEY,
        mpcRootKey: CONFIG.MPC_ROOT_PRIVATE_KEY,
        infuraApiKey: CONFIG.INFURA_API_KEY,
        programId: CONFIG.CHAIN_SIGNATURES_PROGRAM_ID,
        isDevnet: true,
        verbose: true,
        bitcoinNetwork: CONFIG.BITCOIN_NETWORK,
        lastBackfillSignature,
      };

      server = new ChainSignatureServer(serverConfig);
      await server.start();
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  contextRefCount += 1;
  return requireContext();
}

/**
 * Decrements the shared test harness refcount and shuts down the local Chain Signatures server once the last suite finishes.
 */
export async function teardownBitcoinTestContext(): Promise<void> {
  if (contextRefCount === 0) {
    return;
  }

  contextRefCount -= 1;
  if (contextRefCount > 0) {
    return;
  }

  if (server) {
    await server.shutdown();
    server = null;
  }
}

type SimpleOutputPlan = {
  script: Buffer;
  value: number;
};

export type BtcTarget = {
  pda: anchor.web3.PublicKey;
  address: string;
  script: Buffer;
  compressedPubkey: Buffer;
};

export type BtcDestination = {
  address: string;
  script: Buffer;
};

export type DepositPlan = {
  requester: anchor.web3.PublicKey;
  btcInputs: BtcInput[];
  btcOutputs: BtcOutput[];
  txParams: BtcDepositParams;
  path: string;
  txidExplorerHex: string;
  requestIdHex: Hex;
  creditedAmount: BN;
  vaultAuthority: BtcTarget;
  globalVault: BtcTarget;
  changeScript?: Buffer;
};

export type WithdrawalPlan = {
  btcInputs: BtcInput[];
  btcOutputs: BtcOutput[];
  amount: BN;
  fee: BN;
  recipient: BtcDestination;
  txParams: BtcWithdrawParams;
  txidExplorerHex: string;
  requestIdHex: Hex;
  globalVault: BtcTarget;
  selectedUtxos: UTXO[];
  feeBudget: number;
};

// Deposit plan flavors used across integration tests:
// - live_single: consumes one funded UTXO on regtest; requester defaults to provider wallet; amount/fee are explicit.
// - live_multi: builds a multi-UTXO deposit from a provided keypair requester.
// - mock: fully off-chain fabricated tx (no RPC calls) to validate on-chain checks and failures.
type DepositBuildOptions =
  | {
      mode: "live_single";
      requester: anchor.web3.PublicKey;
      amount: number;
      fee: number;
    }
  | {
      mode: "live_multi";
      requester: anchor.web3.Keypair;
    }
  | {
      mode: "mock";
      requester?: anchor.web3.PublicKey;
      amount?: number;
      includeVaultOutput?: boolean;
      inputValue?: number;
      extraOutputs?: SimpleOutputPlan[];
    };

// Withdrawal plan flavors:
// - live: withdraws real UTXOs from the on-chain global vault (regtest adapter funding).
// - mock: fabricates a withdrawal PSBT for validation/error paths without Bitcoin RPC.
type WithdrawalBuildOptions =
  | {
      mode: "live";
      authority: anchor.web3.Keypair;
      feeBudget?: number;
    }
  | {
      mode: "mock";
      amount?: number;
      fee?: number;
      inputValue?: number;
    };

type GlobalVaultContext = {
  // globalVault refers to the PDA derived from the static b"global_vault_authority" seed.
  globalVault: BtcTarget;
};

type VaultContext = GlobalVaultContext & {
  path: string;
  // vaultAuthority refers to the user-specific PDA derived from b"vault_authority" + requester.
  vaultAuthority: BtcTarget;
};

export const bnToBigInt = (value: BN | number | bigint): bigint =>
  BN.isBN(value) ? BigInt(value.toString()) : BigInt(value);

const bufferFromBytes = (value: Buffer | number[] | Uint8Array): Buffer =>
  Buffer.isBuffer(value) ? value : Buffer.from(value);

/**
 * Builds a bitcoinjs-lib Transaction from provided inputs/outputs and computes the aggregate request id used by Chain Signatures.
 * @param inputs Already-valued inputs (little-endian txid bytes expected)
 * @param outputs Outputs with script/value pairs
 * @param lockTime Optional locktime (defaults to 0)
 * @param requestIdParams Signing metadata used to derive the request id
 */
const buildTransaction = (
  inputs: BtcInput[],
  outputs: BtcOutput[],
  lockTime = DEFAULT_LOCK_TIME,
  requestIdParams: {
    sender: string;
    caip2Id: string;
    path: string;
  }
): {
  tx: bitcoin.Transaction;
  txidExplorerHex: string;
  requestIdHex: Hex;
} => {
  const tx = new bitcoin.Transaction();
  tx.version = BTC_TX_VERSION;
  tx.locktime = lockTime;
  inputs.forEach((input) => {
    const txidBytes = bufferFromBytes(input.txid);
    tx.addInput(
      Buffer.from(txidBytes).reverse(),
      input.vout,
      BTC_SEQUENCE_FINAL
    );
  });
  outputs.forEach((output) => {
    tx.addOutput(output.scriptPubkey, bnToBigInt(output.value));
  });

  const txidExplorerHex = tx.getId();
  const requestIdHex = getRequestIdBidirectional({
    sender: requestIdParams.sender,
    payload: Array.from(Buffer.from(txidExplorerHex, "hex")),
    caip2Id: requestIdParams.caip2Id,
    keyVersion: CONFIG.KEY_VERSION,
    path: requestIdParams.path,
    algo: "ECDSA",
    dest: "bitcoin",
    params: "",
  }) as Hex;

  return { tx, txidExplorerHex, requestIdHex };
};

// Convert 0x-prefixed request id hex to byte array
export const requestIdToBytes = (hexId: Hex): number[] =>
  Array.from(hexToBytes(hexId));

export const planRequestIdBytes = (plan: { requestIdHex: string }): number[] =>
  requestIdToBytes(plan.requestIdHex as Hex);

/**
 * Builds a fully-resolved deposit plan: tx params, request id, credited amount, and destination metadata used by tests.
 * Throws if the request id cannot be deterministically recomputed.
 * Note: lockTime is always 0 and caip2Id is always CONFIG.BITCOIN_CAIP2_ID for Bitcoin deposits.
 */
export const composeDepositPlan = (params: {
  requester: anchor.web3.PublicKey;
  btcInputs: BtcInput[];
  btcOutputs: BtcOutput[];
  path: string;
  vaultAuthority: BtcTarget;
  globalVault: BtcTarget;
  changeScript?: Buffer;
}): DepositPlan => {
  const { txidExplorerHex, requestIdHex } = buildTransaction(
    params.btcInputs,
    params.btcOutputs,
    0, // lockTime is always 0
    {
      sender: params.vaultAuthority.pda.toString(),
      caip2Id: CONFIG.BITCOIN_CAIP2_ID,
      path: params.path,
    }
  );

  if (!requestIdHex) {
    throw new Error("Failed to compute deposit request id");
  }

  const vaultScriptHex = params.globalVault.script.toString("hex");
  const creditedAmount = params.btcOutputs.reduce((acc, output) => {
    const scriptHex = Buffer.from(output.scriptPubkey).toString("hex");
    return scriptHex === vaultScriptHex ? acc.add(output.value) : acc;
  }, new BN(0));

  const txParams: BtcDepositParams = {
    lockTime: 0,
    caip2Id: CONFIG.BITCOIN_CAIP2_ID,
    vaultScriptPubkey: params.globalVault.script,
  };

  return {
    requester: params.requester,
    btcInputs: params.btcInputs,
    btcOutputs: params.btcOutputs,
    txParams,
    path: params.path,
    txidExplorerHex,
    requestIdHex,
    creditedAmount,
    vaultAuthority: params.vaultAuthority,
    globalVault: params.globalVault,
    changeScript: params.changeScript,
  };
};

/**
 * Compose a withdrawal plan with derived change, request id, and tx params validated against provided inputs.
 * Computes the deterministic request id for signature collection.
 * Note: lockTime is always 0 and caip2Id is always CONFIG.BITCOIN_CAIP2_ID for Bitcoin withdrawals.
 */
export const composeWithdrawalPlan = (params: {
  btcInputs: BtcInput[];
  amount: BN;
  fee: BN;
  recipient: BtcDestination;
  globalVault: BtcTarget;
  selectedUtxos: UTXO[];
  feeBudget: number;
}): WithdrawalPlan => {
  const totalInputValue = params.btcInputs.reduce(
    (acc, cur) => acc.add(cur.value),
    new BN(0)
  );
  const changeValue = totalInputValue.sub(params.amount).sub(params.fee);
  if (changeValue.isNeg()) {
    throw new Error("Provided inputs do not cover amount + fee");
  }

  const btcOutputs: BtcOutput[] = [
    { scriptPubkey: params.recipient.script, value: params.amount },
  ];
  if (changeValue.gt(new BN(0))) {
    btcOutputs.push({
      scriptPubkey: params.globalVault.script,
      value: changeValue,
    });
  }

  const { txidExplorerHex, requestIdHex } = buildTransaction(
    params.btcInputs,
    btcOutputs,
    0, // lockTime is always 0
    {
      sender: params.globalVault.pda.toString(),
      caip2Id: CONFIG.BITCOIN_CAIP2_ID,
      path: CONFIG.BITCOIN_WITHDRAW_PATH,
    }
  );

  if (!requestIdHex) {
    throw new Error("Failed to compute withdrawal request id");
  }

  const txParams: BtcWithdrawParams = {
    lockTime: 0,
    caip2Id: CONFIG.BITCOIN_CAIP2_ID,
    vaultScriptPubkey: params.globalVault.script,
    recipientScriptPubkey: params.recipient.script,
    fee: params.fee,
  };

  return {
    btcInputs: params.btcInputs,
    btcOutputs,
    amount: params.amount,
    fee: params.fee,
    recipient: params.recipient,
    txParams,
    txidExplorerHex,
    requestIdHex,
    globalVault: params.globalVault,
    selectedUtxos: params.selectedUtxos,
    feeBudget: params.feeBudget,
  };
};

// Constants for Bitcoin Chain Signatures
const CHAIN_SIG_ALGO = "ECDSA";
const CHAIN_SIG_DEST = "bitcoin";
const CHAIN_SIG_PARAMS = "";

type RequestIdComputationParams = {
  sender: string;
  txidExplorerHex: string;
  inputCount: number;
  caip2Id: string;
  path: string;
};

const computePerInputRequestIds = ({
  sender,
  txidExplorerHex,
  inputCount,
  caip2Id,
  path,
}: RequestIdComputationParams): string[] => {
  const txidBytes = Buffer.from(txidExplorerHex, "hex");
  const ids: string[] = [];

  for (let i = 0; i < inputCount; i++) {
    const indexLe = Buffer.alloc(4);
    indexLe.writeUInt32LE(i, 0);
    const txData = Buffer.concat([txidBytes, indexLe]);

    const requestId = getRequestIdBidirectional({
      sender,
      payload: Array.from(txData),
      caip2Id,
      keyVersion: CONFIG.KEY_VERSION,
      path,
      algo: CHAIN_SIG_ALGO,
      dest: CHAIN_SIG_DEST,
      params: CHAIN_SIG_PARAMS,
    });

    ids.push(requestId);
  }

  return ids;
};

/**
 * Computes per-input request ids expected from Chain Signatures for the given deposit or withdrawal plan.
 */
export function computeSignatureRequestIds(
  plan: DepositPlan | WithdrawalPlan
): string[] {
  const isDeposit = "vaultAuthority" in plan;
  const sender = isDeposit
    ? plan.vaultAuthority.pda.toString()
    : plan.globalVault.pda.toString();
  const path = isDeposit ? plan.path : CONFIG.BITCOIN_WITHDRAW_PATH;
  const inputCount = plan.btcInputs.length;

  return computePerInputRequestIds({
    sender,
    txidExplorerHex: plan.txidExplorerHex,
    inputCount,
    caip2Id: plan.txParams.caip2Id,
    path,
  });
}

/**
 * Builds a deposit plan for live or mock modes: sources UTXOs, determines change, computes request id, and prepares vault metadata.
 */
export const buildDepositPlan = async (
  options: DepositBuildOptions
): Promise<DepositPlan> => {
  const { provider, bitcoinAdapter } = requireContext();

  // Notes on requester selection:
  // - live_single always takes an explicit requester and amount/fee.
  // - live_multi requires an explicit requester Keypair so tests can exercise
  //   the “requester != fee payer” flow (multi-input happy path).
  // - mock paths accept optional requester overrides for failure-path coverage.
  switch (options.mode) {
    case "live_single": {
      const requester = options.requester;
      const { path, vaultAuthority, globalVault } =
        deriveVaultContext(requester);
      const { amount, fee } = options;
      const minValue = amount + fee;

      const utxos = await ensureUtxos(bitcoinAdapter, vaultAuthority.address, {
        minCount: 1,
        minValue,
      });

      const utxo = utxos.find((u) => u.value >= minValue) ?? utxos[0];
      const btcInputs: BtcInput[] = [toBtcInput(utxo, vaultAuthority.script)];
      const btcOutputs: BtcOutput[] = [];

      const changeValue = utxo.value - amount - fee;
      if (changeValue < 0) {
        throw new Error(
          `UTXO value ${utxo.value} sats cannot cover amount ${amount} + fee ${fee}`
        );
      }
      btcOutputs.push({
        scriptPubkey: globalVault.script,
        value: new BN(amount),
      });
      if (changeValue > 0) {
        btcOutputs.push({
          scriptPubkey: vaultAuthority.script,
          value: new BN(changeValue),
        });
      }

      return composeDepositPlan({
        requester,
        btcInputs,
        btcOutputs,
        path,
        vaultAuthority,
        globalVault,
      });
    }
    case "live_multi": {
      const requester = options.requester;
      const { path, vaultAuthority, globalVault } = deriveVaultContext(
        requester.publicKey
      );

      const changeScript = deriveChangeScript(vaultAuthority, path);

      const inventory = await ensureUtxos(
        bitcoinAdapter,
        vaultAuthority.address,
        {
          minCount: MULTI_INPUT_TARGET,
        }
      );

      const selectedUtxos = [...inventory]
        .sort((a, b) => b.value - a.value)
        .slice(0, MULTI_INPUT_TARGET);

      const totalInputValue = selectedUtxos.reduce(
        (acc, utxo) => acc + utxo.value,
        0
      );
      const changeValue = Math.floor(
        totalInputValue / MULTI_INPUT_CHANGE_DIVISOR
      );
      const vaultValue = totalInputValue - MULTI_INPUT_BASE_FEE - changeValue;

      if (vaultValue <= 0) {
        throw new Error("Computed vault value is non-positive");
      }

      const btcInputs = selectedUtxos.map((utxo) =>
        toBtcInput(utxo, vaultAuthority.script)
      );

      const btcOutputs: BtcOutput[] = [
        {
          scriptPubkey: globalVault.script,
          value: new BN(vaultValue),
        },
      ];

      if (changeValue > 0) {
        btcOutputs.push({
          scriptPubkey: changeScript,
          value: new BN(changeValue),
        });
      }

      return composeDepositPlan({
        requester: requester.publicKey,
        btcInputs,
        btcOutputs,
        path,
        vaultAuthority,
        globalVault,
        changeScript,
      });
    }
    case "mock": {
      const requester = options.requester ?? provider.wallet.publicKey;
      const amount = options.amount ?? DEFAULT_DEPOSIT_AMOUNT;
      const inputValue = options.inputValue ?? amount + WITHDRAW_FEE_BUDGET;

      const { path, vaultAuthority, globalVault } =
        deriveVaultContext(requester);

      const primaryOutputScript =
        options.includeVaultOutput === false
          ? vaultAuthority.script
          : globalVault.script;

      const plannedOutputs: SimpleOutputPlan[] = [
        {
          script: primaryOutputScript,
          value: amount,
        },
        ...(options.extraOutputs ?? []),
      ];

      const mockTxid = randomBytes(32);
      const btcInputs: BtcInput[] = [
        {
          txid: Array.from(mockTxid),
          vout: 0,
          scriptPubkey: vaultAuthority.script,
          value: new BN(inputValue),
        },
      ];

      const btcOutputs: BtcOutput[] = plannedOutputs.map((output) => ({
        scriptPubkey: output.script,
        value: new BN(output.value),
      }));

      return composeDepositPlan({
        requester,
        btcInputs,
        btcOutputs,
        path,
        vaultAuthority,
        globalVault,
      });
    }
  }
};

/**
 * Builds a withdrawal plan for live or mock paths, selecting vault UTXOs and computing deterministic request/signing metadata.
 */
export const buildWithdrawalPlan = async (
  options: WithdrawalBuildOptions
): Promise<WithdrawalPlan> => {
  const { bitcoinAdapter } = requireContext();

  switch (options.mode) {
    case "live": {
      const feeBudget = options.feeBudget ?? WITHDRAW_FEE_BUDGET;
      const balanceInfo = await fetchUserBalance(options.authority.publicKey);
      if (balanceInfo.amount.lte(new BN(feeBudget))) {
        throw new Error("Insufficient balance to cover withdrawal fee");
      }

      const withdrawAmountBn = balanceInfo.amount.sub(new BN(feeBudget));

      const { globalVault } = deriveGlobalVaultContext();

      const globalVaultUtxos =
        (await bitcoinAdapter.getAddressUtxos(globalVault.address)) ?? [];
      const targetTotal = withdrawAmountBn.toNumber() + feeBudget;
      const { selected: selectedUtxos, total } = selectUtxosForTarget(
        globalVaultUtxos,
        targetTotal,
        { minChange: MIN_WITHDRAW_CHANGE_SATS }
      );

      if (selectedUtxos.length === 0 || total < targetTotal) {
        throw new Error(
          `Unable to collect sufficient global vault liquidity for ${targetTotal} sats`
        );
      }

      const changeValue = total - targetTotal;
      if (changeValue > 0 && changeValue < MIN_WITHDRAW_CHANGE_SATS) {
        throw new Error(
          `Unable to construct withdrawal with non-dust change (change=${changeValue} sats). Add liquidity or increase fee budget.`
        );
      }

      const recipient = buildExternalDestination();

      const btcInputs = selectedUtxos.map((utxo) =>
        toBtcInput(utxo, globalVault.script)
      );

      // Change is guaranteed to be zero or above the dust threshold.
      return composeWithdrawalPlan({
        btcInputs,
        amount: withdrawAmountBn,
        fee: new BN(feeBudget),
        recipient,
        globalVault,
        selectedUtxos,
        feeBudget,
      });
    }
    case "mock": {
      const amountValue = options.amount ?? 2_000;
      const feeValue = options.fee ?? DEFAULT_MOCK_FEE;
      const inputValue =
        options.inputValue ?? amountValue + feeValue + DEFAULT_MOCK_FEE;

      const { globalVault } = deriveGlobalVaultContext();

      const recipient = buildExternalDestination();

      const mockTxid = randomBytes(32);
      const btcInputs: BtcInput[] = [
        {
          txid: Array.from(mockTxid),
          vout: 0,
          scriptPubkey: globalVault.script,
          value: new BN(inputValue),
        },
      ];

      return composeWithdrawalPlan({
        btcInputs,
        amount: new BN(amountValue),
        fee: new BN(feeValue),
        recipient,
        globalVault,
        selectedUtxos: [],
        feeBudget: feeValue,
      });
    }
  }
};

export const computeMessageHash = (
  requestIdBytes: number[],
  serializedOutput: Buffer
): Buffer => {
  const payload = ethers.concat([
    Uint8Array.from(requestIdBytes),
    serializedOutput,
  ]);
  return Buffer.from(ethers.keccak256(payload).slice(2), "hex");
};

export const signHashWithMpc = (hash: Buffer): ChainSignaturePayload => {
  const signingKey = new ethers.SigningKey(CONFIG.MPC_ROOT_PRIVATE_KEY);
  const signature = signingKey.sign(hash);
  const rBytes = Buffer.from(ethers.getBytes(signature.r));
  const sBytes = Buffer.from(ethers.getBytes(signature.s));
  const recoveryId =
    Number(signature.v) >= 27 ? Number(signature.v) - 27 : Number(signature.v);

  return {
    bigR: {
      x: Array.from(rBytes),
      y: Array(32).fill(0),
    },
    s: Array.from(sBytes),
    recoveryId,
  };
};

/**
 * Signs a hash using the derived MPC key for deposit claims.
 * Uses vault_authority PDA (derived from requester) + SOLANA_RESPOND_BIDIRECTIONAL_PATH.
 */
export const signHashWithMpcForDeposit = async (
  hash: Buffer,
  requester: anchor.web3.PublicKey
): Promise<ChainSignaturePayload> => {
  const { program } = requireContext();
  const [vaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault_authority"), requester.toBuffer()],
    program.programId
  );

  const derivedKeyHex = await CryptoUtils.deriveSigningKey(
    CONFIG.SOLANA_RESPOND_BIDIRECTIONAL_PATH,
    vaultAuthorityPda.toString(),
    CONFIG.MPC_ROOT_PRIVATE_KEY
  );

  const signingKey = new ethers.SigningKey(derivedKeyHex);
  const signature = signingKey.sign(hash);
  const rBytes = Buffer.from(ethers.getBytes(signature.r));
  const sBytes = Buffer.from(ethers.getBytes(signature.s));
  const recoveryId =
    Number(signature.v) >= 27 ? Number(signature.v) - 27 : Number(signature.v);

  return {
    bigR: {
      x: Array.from(rBytes),
      y: Array(32).fill(0),
    },
    s: Array.from(sBytes),
    recoveryId,
  };
};

/**
 * Signs a hash using the derived MPC key for withdrawal completions.
 * Uses global_vault_authority PDA + SOLANA_RESPOND_BIDIRECTIONAL_PATH.
 */
export const signHashWithMpcForWithdrawal = async (
  hash: Buffer
): Promise<ChainSignaturePayload> => {
  const { program } = requireContext();
  const [globalVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("global_vault_authority")],
    program.programId
  );

  const derivedKeyHex = await CryptoUtils.deriveSigningKey(
    CONFIG.SOLANA_RESPOND_BIDIRECTIONAL_PATH,
    globalVaultPda.toString(),
    CONFIG.MPC_ROOT_PRIVATE_KEY
  );

  const signingKey = new ethers.SigningKey(derivedKeyHex);
  const signature = signingKey.sign(hash);
  const rBytes = Buffer.from(ethers.getBytes(signature.r));
  const sBytes = Buffer.from(ethers.getBytes(signature.s));
  const recoveryId =
    Number(signature.v) >= 27 ? Number(signature.v) - 27 : Number(signature.v);

  return {
    bigR: {
      x: Array.from(rBytes),
      y: Array(32).fill(0),
    },
    s: Array.from(sBytes),
    recoveryId,
  };
};

/**
 * Returns the Ethereum address bytes for the root MPC key.
 * Used in mock tests where signHashWithMpc signs with the root key.
 */
export const getMpcRootAddressBytes = (): number[] => {
  const signingKey = new ethers.SigningKey(CONFIG.MPC_ROOT_PRIVATE_KEY);
  const address = ethers.computeAddress(signingKey.publicKey);
  return Array.from(Buffer.from(address.slice(2), "hex"));
};

const WAIT_FOR_EVENT_CONFIG = {
  timeoutMs: 300_000,
  backfillIntervalMs: 15_000,
  healthCheckIntervalMs: 15_000,
};

export type BtcEventListeners = {
  waitForSignatureMap: () => Promise<SignatureMap>;
  readRespond: Promise<{
    serializedOutput: Buffer;
    signature: ChainSignaturePayload;
  }>;
};

/**
 * Starts waitForEvent listeners for per-input signatures and the aggregate respondBidirectional event.
 * Uses signet.js waitForEvent which combines WebSocket + polling backfill for reliable event detection.
 * Must be called before submitting the Solana transaction.
 */
export function startBtcEventListeners(
  signatureRequestIds: string[],
  aggregateRequestId: string,
  afterSignature?: string
): BtcEventListeners {
  const { chainSignatureContract } = requireContext();
  const signer = new anchor.web3.PublicKey(CONFIG.CHAIN_SIGNATURES_PROGRAM_ID);

  const signaturePromises = signatureRequestIds.map((reqId) =>
    chainSignatureContract.waitForEvent({
      eventName: "signatureRespondedEvent",
      requestId: reqId,
      signer,
      afterSignature,
      ...WAIT_FOR_EVENT_CONFIG,
    })
  );

  const respondPromise = chainSignatureContract.waitForEvent({
    eventName: "respondBidirectionalEvent",
    requestId: aggregateRequestId,
    signer,
    afterSignature,
    ...WAIT_FOR_EVENT_CONFIG,
  });

  const waitForSignatureMap = async (): Promise<SignatureMap> => {
    const rsvSignatures = await Promise.all(signaturePromises);
    const map: SignatureMap = new Map();
    rsvSignatures.forEach((rsv, idx) => {
      map.set(signatureRequestIds[idx].toLowerCase(), {
        r: "0x" + rsv.r,
        s: "0x" + rsv.s,
        v: BigInt(rsv.v),
      });
    });
    return map;
  };

  return {
    waitForSignatureMap,
    readRespond: respondPromise as BtcEventListeners["readRespond"],
  };
}

/**
 * End-to-end helper that performs a live single-input deposit for tests: submits the Solana ix, waits for MPC signatures, signs/broadcasts Bitcoin, then claims on-chain.
 */
export async function executeSyntheticDeposit(
  amount: number,
  requester?: anchor.web3.PublicKey
): Promise<number> {
  const { provider, program, bitcoinAdapter } = requireContext();
  const depositRequester = requester ?? provider.wallet.publicKey;

  const preparedPlan = await buildDepositPlan({
    mode: "live_single",
    requester: depositRequester,
    amount,
    fee: SYNTHETIC_TX_FEE,
  });

  const { requestIdHex } = preparedPlan;
  const signatureRequestIds = computeSignatureRequestIds(preparedPlan);

  const depositTx = await program.methods
    .depositBtc(
      requestIdToBytes(requestIdHex),
      preparedPlan.requester,
      preparedPlan.btcInputs,
      preparedPlan.btcOutputs,
      preparedPlan.txParams
    )
    .accounts({
      payer: provider.wallet.publicKey,
      feePayer: provider.wallet.publicKey,
      instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .rpc();
  await provider.connection.confirmTransaction(depositTx);

  // Start listeners AFTER the Solana tx so backfill starts from the tx hash
  const events = startBtcEventListeners(
    signatureRequestIds,
    requestIdHex,
    depositTx
  );

  const signatureMap = await events.waitForSignatureMap();

  const psbt = buildDepositPsbt(preparedPlan);

  applySignaturesToPsbt(
    psbt,
    signatureMap,
    signatureRequestIds,
    preparedPlan.vaultAuthority.compressedPubkey
  );

  const signedTx = psbt.extractTransaction();
  const txHex = signedTx.toHex();
  await bitcoinAdapter.broadcastTransaction(txHex);

  const readEvent = await events.readRespond;

  const claimTx = await program.methods
    .claimBtc(
      requestIdToBytes(requestIdHex),
      Buffer.from(readEvent.serializedOutput),
      readEvent.signature
    )
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }),
    ])
    .rpc();
  await provider.connection.confirmTransaction(claimTx);

  return amount;
}

export const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

export const expectAnchorError = async (
  promise: Promise<unknown>,
  matcher: RegExp | string
) => {
  try {
    await promise;
    expect.fail(`Expected promise to reject with ${matcher}`);
  } catch (error: unknown) {
    if (error instanceof AssertionError) {
      throw error;
    }
    const message = getErrorMessage(error);
    if (matcher instanceof RegExp) {
      expect(message).to.match(matcher);
    } else {
      expect(message).to.include(matcher);
    }
  }
};

const SECP256K1_ORDER = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"
);
const SECP256K1_HALF_ORDER = BigInt(SECP256K1_ORDER) >> BigInt(1);

function encodeVarInt(value: number): Buffer {
  const { buffer } = varuint.encode(value);
  return Buffer.from(buffer);
}

function encodeWitnessStack(items: Buffer[]): Buffer {
  const chunks: Buffer[] = [encodeVarInt(items.length)];
  for (const item of items) {
    chunks.push(encodeVarInt(item.length));
    chunks.push(item);
  }
  return Buffer.concat(chunks);
}

/**
 * Normalizes an MPC-produced signature to low-S form and encodes a P2WPKH witness stack for bitcoinjs-lib PSBT finalization.
 */
export function prepareSignatureWitness(
  signature: ProcessedSignature,
  publicKey: Buffer
): { sigWithHashType: Buffer; witness: Buffer } {
  const rBytes = Buffer.from(signature.r.slice(2).padStart(64, "0"), "hex");
  const originalS = BigInt(signature.s);
  const lowS =
    originalS > SECP256K1_HALF_ORDER ? SECP256K1_ORDER - originalS : originalS;
  const sBytes = Buffer.from(lowS.toString(16).padStart(64, "0"), "hex");

  const rawSignature = Buffer.concat([rBytes, sBytes]);
  const sigWithHashType = Buffer.from(
    bitcoin.script.signature.encode(
      rawSignature,
      bitcoin.Transaction.SIGHASH_ALL
    )
  );
  const witness = encodeWitnessStack([sigWithHashType, publicKey]);

  return { sigWithHashType, witness };
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Creates a throwaway keypair and funds it with SOL from the provider wallet, retrying on transient blockhash errors.
 */
export async function createFundedAuthority(
  lamports = Math.floor(FUNDED_AUTHORITY_SOL * anchor.web3.LAMPORTS_PER_SOL)
): Promise<anchor.web3.Keypair> {
  const { provider } = requireContext();
  const authority = anchor.web3.Keypair.generate();
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_FUNDING_ATTEMPTS; attempt++) {
    const tx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        toPubkey: authority.publicKey,
        lamports,
      })
    );

    try {
      await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });
      return authority;
    } catch (error: unknown) {
      lastError = error;
      const message =
        error instanceof Error ? error.message : (error as string | null);

      if (message && message.toLowerCase().includes("blockhash not found")) {
        console.warn(
          `[test] Blockhash not found when funding authority (attempt ${
            attempt + 1
          }), retrying...`
        );
        await sleep(FUNDING_RETRY_DELAY_MS);
        continue;
      }

      throw error;
    }
  }

  // If we exhausted retries, surface the last error
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error(String(lastError));
}

/**
 * Polls a Bitcoin adapter for UTXOs on an address until the minimum count is met or attempts are exhausted.
 */
async function waitForUtxoCount(
  adapter: IBitcoinAdapter,
  address: string,
  minCount: number,
  maxAttempts = 15,
  delayMs = 2_000
): Promise<UTXO[]> {
  let latest: UTXO[] = [];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    latest = (await adapter.getAddressUtxos(address)) ?? [];

    if (latest.length >= minCount) {
      return latest;
    }

    await sleep(delayMs);
  }

  return latest;
}

type EnsureUtxoOptions = {
  minCount?: number;
  minValue?: number;
  fundingSats?: number;
};

/**
 * Ensures an address has enough funded UTXOs (optionally above a value threshold), funding via adapter.fundAddress when available.
 */
const ensureUtxos = async (
  adapter: IBitcoinAdapter,
  address: string,
  {
    minCount = 1,
    minValue,
    fundingSats = DEFAULT_FUNDING_SATS,
  }: EnsureUtxoOptions
): Promise<UTXO[]> => {
  let utxos = (await adapter.getAddressUtxos(address)) ?? [];
  let attempt = 0;

  const needsFunding = () =>
    utxos.length < minCount ||
    (minValue !== undefined && !utxos.some((utxo) => utxo.value >= minValue));

  while (needsFunding() && attempt < MAX_UTXO_FUNDING_ATTEMPTS) {
    if (!adapter.fundAddress) {
      break;
    }

    const satsToSend = Math.max(
      fundingSats + attempt * FUNDING_INCREMENT_SATS,
      minValue ?? MIN_FUNDING_SATS
    );

    await adapter.fundAddress(address, satsToSend / SATS_PER_BTC);

    const currentCount = utxos.length;
    const targetCount =
      currentCount < minCount
        ? Math.min(minCount, currentCount + 1)
        : currentCount + 1;

    utxos = await waitForUtxoCount(
      adapter,
      address,
      targetCount,
      MAX_UTXO_FUNDING_ATTEMPTS,
      UTXO_POLL_INTERVAL_MS
    );

    attempt += 1;
  }

  if (utxos.length < minCount) {
    throw new Error(`Unable to prepare ${minCount} UTXO(s) for ${address}.`);
  }

  if (minValue !== undefined && !utxos.some((utxo) => utxo.value >= minValue)) {
    throw new Error(`Unable to find UTXO >= ${minValue} sats for ${address}.`);
  }

  return utxos;
};

const toBtcInput = (utxo: UTXO, script: Buffer): BtcInput => ({
  txid: Array.from(Buffer.from(utxo.txid, "hex")),
  vout: utxo.vout,
  scriptPubkey: script,
  value: new BN(utxo.value),
});

/**
 * Greedy-selects UTXOs until the target is met while optionally enforcing a minimum change threshold.
 */
const selectUtxosForTarget = (
  utxos: UTXO[] | null | undefined,
  target: number,
  options?: { minChange?: number }
): { selected: UTXO[]; total: number } => {
  const sorted = [...(utxos ?? [])].sort((a, b) => b.value - a.value);
  const selected: UTXO[] = [];
  let total = 0;
  const minChange = options?.minChange ?? 0;

  for (const utxo of sorted) {
    selected.push(utxo);
    total += utxo.value;
    const change = total - target;

    if (total >= target && (change === 0 || change >= minChange)) {
      break;
    }
  }

  return { selected, total };
};

/**
 * Derives Bitcoin key material (address, script, compressed pubkey) from a PDA and derivation path.
 */
const deriveBtcTarget = (
  pda: anchor.web3.PublicKey,
  path: string
): BtcTarget => {
  const { btcUtils } = requireContext();
  const uncompressedPubkey = signetUtils.cryptography.deriveChildPublicKey(
    CONFIG.MPC_ROOT_PUBLIC_KEY as `04${string}`,
    pda.toString(),
    path,
    CONFIG.SOLANA_CAIP2_ID,
    CONFIG.KEY_VERSION
  );
  const compressedPubkey = btcUtils.compressPublicKey(uncompressedPubkey);
  return {
    pda,
    address: btcUtils.getAddressFromPubkey(compressedPubkey),
    script: btcUtils.createP2WPKHScript(compressedPubkey),
    compressedPubkey,
  };
};

/**
 * Derives the static global vault PDA and its corresponding Bitcoin address/script/key material.
 */
const deriveGlobalVaultContext = (): GlobalVaultContext => {
  const { program } = requireContext();
  const [globalVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("global_vault_authority")],
    program.programId
  );
  return {
    globalVault: deriveBtcTarget(globalVaultPda, CONFIG.BITCOIN_WITHDRAW_PATH),
  };
};

/**
 * Derive user-specific vault PDA plus Bitcoin address/script for a requester path.
 */
const deriveVaultContext = (
  requester: anchor.web3.PublicKey,
  pathOverride?: string
): VaultContext => {
  const { program } = requireContext();
  const path = pathOverride ?? requester.toString();
  const [vaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault_authority"), requester.toBuffer()],
    program.programId
  );
  return {
    path,
    vaultAuthority: deriveBtcTarget(vaultAuthorityPda, path),
    ...deriveGlobalVaultContext(),
  };
};

/**
 * Derives the change output script for a depositor by appending a ::change path to the vault authority derivation.
 */
const deriveChangeScript = (
  vaultAuthority: BtcTarget,
  path: string
): Buffer => {
  const changePath = `${path}::change`;
  return deriveBtcTarget(vaultAuthority.pda, changePath).script;
};

/**
 * Generates a fresh external P2WPKH destination (used as the withdrawal recipient in tests).
 */
const buildExternalDestination = (): BtcDestination => {
  const { btcUtils } = requireContext();
  const externalPrivKey = randomBytes(32);
  const externalPubkey = secp256k1.getPublicKey(externalPrivKey, false);
  const compressedExternalPubkey = btcUtils.compressPublicKey(
    Buffer.from(externalPubkey).toString("hex")
  );

  return {
    script: btcUtils.createP2WPKHScript(compressedExternalPubkey),
    address: btcUtils.getAddressFromPubkey(compressedExternalPubkey),
  };
};

/**
 * Derives the user BTC balance PDA for a given authority.
 */
export const deriveUserBalancePda = (
  authority: anchor.web3.PublicKey
): anchor.web3.PublicKey => {
  const { program } = requireContext();
  const [pda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("user_btc_balance"), authority.toBuffer()],
    program.programId
  );
  return pda;
};

/**
 * Fetches (or lazily initializes to zero) a user's BTC balance account on-chain.
 */
export const fetchUserBalance = async (authority: anchor.web3.PublicKey) => {
  const { program } = requireContext();
  const userBalancePda = deriveUserBalancePda(authority);

  try {
    const account = await program.account.userBtcBalance.fetch(userBalancePda);
    return {
      pda: userBalancePda,
      amount: account.amount as BN,
    };
  } catch {
    return {
      pda: userBalancePda,
      amount: new BN(0),
    };
  }
};

class BitcoinUtils {
  private network: bitcoin.Network;

  constructor(networkType: "testnet" | "regtest" = "testnet") {
    // Select network based on configuration
    if (networkType === "regtest") {
      this.network = bitcoin.networks.regtest;
    } else {
      this.network = bitcoin.networks.testnet;
    }
  }

  /**
   * Compress an uncompressed public key (65 bytes) to compressed format (33 bytes)
   * Uncompressed: 04 + x (32 bytes) + y (32 bytes)
   * Compressed: 02/03 + x (32 bytes) where prefix is 02 if y is even, 03 if y is odd
   */
  compressPublicKey(uncompressedHex: string): Buffer {
    const uncompressed = Buffer.from(uncompressedHex, "hex");

    if (
      uncompressed.length !== UNCOMPRESSED_PUBKEY_LENGTH ||
      uncompressed[0] !== UNCOMPRESSED_PUBKEY_PREFIX
    ) {
      throw new Error("Invalid uncompressed public key");
    }

    const x = uncompressed.slice(1, 33);
    const y = uncompressed.slice(33, UNCOMPRESSED_PUBKEY_LENGTH);

    // Check if y is even or odd
    const prefix =
      y[y.length - 1] % 2 === 0
        ? COMPRESSED_PUBKEY_EVEN_PREFIX
        : COMPRESSED_PUBKEY_ODD_PREFIX;

    return Buffer.concat([Buffer.from([prefix]), x]);
  }

  /**
   * Get Bitcoin address from public key (P2WPKH)
   */
  getAddressFromPubkey(pubkey: Buffer): string {
    const p2wpkh = bitcoin.payments.p2wpkh({
      pubkey,
      network: this.network,
    });
    return p2wpkh.address!;
  }

  /**
   * Create a P2WPKH script pubkey from a public key
   */
  createP2WPKHScript(pubkey: Buffer): Buffer {
    const p2wpkh = bitcoin.payments.p2wpkh({
      pubkey,
      network: this.network,
    });
    // Ensure it's a Node Buffer, not just Uint8Array
    return Buffer.from(p2wpkh.output!);
  }

  /**
   * Build Bitcoin PSBT transaction
   */
  buildPSBT(
    inputs: Array<{
      txid: string;
      vout: number;
      value: BN | number | bigint;
      scriptPubkey: Buffer;
    }>,
    outputs: Array<{
      address?: string;
      script?: Buffer;
      value: BN | number | bigint;
    }>
  ): bitcoin.Psbt {
    const psbt = new bitcoin.Psbt({ network: this.network });

    // Add inputs
    for (const input of inputs) {
      psbt.addInput({
        hash: input.txid,
        index: input.vout,
        witnessUtxo: {
          script: Buffer.from(input.scriptPubkey),
          value: bnToBigInt(input.value),
        },
      });
    }

    // Add outputs
    for (const output of outputs) {
      if (output.address) {
        psbt.addOutput({
          address: output.address,
          value: bnToBigInt(output.value),
        });
      } else if (output.script) {
        psbt.addOutput({
          script: Buffer.from(output.script),
          value: bnToBigInt(output.value),
        });
      }
    }

    return psbt;
  }
}

/**
 * Builds a PSBT from plan inputs/outputs with a given input script.
 */
const buildPlanPsbt = (
  btcInputs: BtcInput[],
  btcOutputs: BtcOutput[],
  inputScript: Buffer
): bitcoin.Psbt => {
  const { btcUtils } = requireContext();
  return btcUtils.buildPSBT(
    btcInputs.map((input) => ({
      txid: Buffer.from(input.txid).toString("hex"),
      vout: input.vout,
      value: input.value,
      scriptPubkey: inputScript,
    })),
    btcOutputs.map((output) => ({
      script: output.scriptPubkey,
      value: output.value,
    }))
  );
};

/**
 * Builds a PSBT for a deposit transaction from a DepositPlan.
 */
export const buildDepositPsbt = (plan: DepositPlan): bitcoin.Psbt =>
  buildPlanPsbt(plan.btcInputs, plan.btcOutputs, plan.vaultAuthority.script);

/**
 * Builds a PSBT for a withdrawal transaction from a WithdrawalPlan.
 */
export const buildWithdrawalPsbt = (plan: WithdrawalPlan): bitcoin.Psbt =>
  buildPlanPsbt(plan.btcInputs, plan.btcOutputs, plan.globalVault.script);

/**
 * Idempotently initializes the on-chain vault_config account with the MPC root public key.
 * The public key is stored as 64 bytes (uncompressed without the 0x04 prefix).
 */
async function ensureVaultConfigInitialized(
  program: Program<SolanaCoreContracts>,
  provider: anchor.AnchorProvider
) {
  const [vaultConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault_config")],
    program.programId
  );

  const publicKeyHex = CONFIG.MPC_ROOT_PUBLIC_KEY.startsWith("04")
    ? CONFIG.MPC_ROOT_PUBLIC_KEY.slice(2)
    : CONFIG.MPC_ROOT_PUBLIC_KEY;
  const publicKeyBytes = Array.from(Buffer.from(publicKeyHex, "hex"));

  const accountInfo = await provider.connection.getAccountInfo(vaultConfigPda);

  if (!accountInfo) {
    await program.methods
      .initializeConfig(publicKeyBytes)
      .accountsStrict({
        payer: provider.wallet.publicKey,
        config: vaultConfigPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
  }
}

type SignatureMap = Map<string, ProcessedSignature>;

/**
 * Inserts prepared P2WPKH witnesses into a PSBT using the supplied signature map and ordering.
 */
export const applySignaturesToPsbt = (
  psbt: bitcoin.Psbt,
  signatureMap: SignatureMap,
  requestIds: string[],
  signingPubkey: Buffer
) => {
  requestIds.forEach((id, idx) => {
    const sig = signatureMap.get(id.toLowerCase());
    if (!sig) {
      throw new Error(`Missing signature for requestId ${id}`);
    }
    const { witness } = prepareSignatureWitness(sig, signingPubkey);
    psbt.updateInput(idx, { finalScriptWitness: witness });
  });
};
