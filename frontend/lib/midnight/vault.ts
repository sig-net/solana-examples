import { rawTokenType } from '@midnight-ntwrk/compact-runtime';
import { Contract as EthersContract, JsonRpcProvider, type Transaction } from 'ethers';
import {
  calculateRequestId,
  requestIdHex,
  requestIdBytes,
  deriveEvmAddress,
  evmAddressAbiWord,
  numericAbiWord,
  asciiPadded,
  hexToBytes,
  bytesToHex,
  stripHexPrefix,
  toSignBidirectionalEventIndex,
  calculateSignetAttestationDigest,
  deserializeEvmOutput,
  serializeRespondOutput,
  signBidirectionalEventToSignedEvmTransaction,
  SignetRequestResponseReader,
  SIGNET_DEFAULT_KEY_VERSION,
  PATH_BYTES,
  MPC_PARAMS_BYTES,
  MPC_FAILURE_OUTPUT,
  MPCSignatureAlgorithm,
  MPCDestination,
  TxParamType,
  type RequestIdHex,
  type SignBidirectionalEvent,
} from '@sig-net/midnight';

import { flow } from './flow';
import {
  ERC20_TRANSFER_GAS_LIMIT as GAS_LIMIT,
  ERC20_TRANSFER_MAX_FEE_PER_GAS as MAX_FEE,
  ERC20_TRANSFER_MAX_PRIORITY_FEE_PER_GAS as PRIORITY_FEE,
} from './evm-envelope';
import { pureCircuits, ledger, VAULT_REQUESTS_INDEX_FIELD } from './contract-exports';

// Fixed EVM transfer envelope + MPC routing (mirrors the reference integration tests).
const ERC20_TRANSFER_SELECTOR = new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]);
const RESULT_SCHEMA = '[{"name":"success","type":"bool"}]';
const VAULT_PATH = asciiPadded('vault', PATH_BYTES);
const MINUTE = 60_000;

const MPC_ROUTING = {
  algo: MPCSignatureAlgorithm.ecdsa,
  dest: MPCDestination.unused,
  params: new Uint8Array(MPC_PARAMS_BYTES),
  outputDeserializationSchema: asciiPadded(RESULT_SCHEMA, RESULT_SCHEMA.length),
  respondSerializationSchema: asciiPadded(RESULT_SCHEMA, RESULT_SCHEMA.length),
};

export type Env = {
  contractAddress: string; // Midnight vault contract
  signetContractAddress: string; // Midnight central signet contract
  mpcSecpPub: string; // MPC root secp256k1 pubkey (0x hex)
  evmRpcUrl: string; // Sepolia JSON-RPC
  fakenetResponsesUrl: string; // fakenet /responses cache
};

const addrBytes = (hex: string) => hexToBytes(stripHexPrefix(hex));
const rand32 = () => crypto.getRandomValues(new Uint8Array(32));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface Identity {
  secretKey: Uint8Array;
  commitment: Uint8Array;
  pathString: string;
}

// deriveEvmAddress with the default midnight:testnet chainId — matches the responder.
// The path is the commitment bytes as UTF-8 with NULs stripped; MUST be TextDecoder, not
// Buffer (the browser polyfill emits different U+FFFD runs, desyncing the address).
export function deriveIdentity(secretKey: Uint8Array): Identity {
  const commitment = pureCircuits.userCommitment(secretKey);
  const pathString = new TextDecoder('utf-8').decode(commitment).replace(/\0/g, '');
  return { secretKey, commitment, pathString };
}
export function depositAddress(env: Env, identity: Identity): string {
  return deriveEvmAddress(env.mpcSecpPub, env.contractAddress, identity.pathString);
}
export function vaultAddress(env: Env): string {
  return deriveEvmAddress(env.mpcSecpPub, env.contractAddress, 'vault');
}

// Shielded vault-token color for an ERC-20 under this vault.
export function vaultTokenType(erc20Hex: string, vaultContractAddress: string): string {
  const raw: any = rawTokenType(
    (pureCircuits as any).vaultTokenDomainSeparator(addrBytes(erc20Hex)),
    vaultContractAddress as any,
  );
  return (typeof raw === 'string' ? raw : bytesToHex(raw)).replace(/^0x/, '').toLowerCase();
}

export async function erc20Balance(rpcUrl: string, erc20Hex: string, address: string): Promise<bigint> {
  const token = new EthersContract(
    erc20Hex,
    ['function balanceOf(address) view returns (uint256)'],
    new JsonRpcProvider(rpcUrl),
  );
  return BigInt(await token.getFunction('balanceOf')(address));
}

async function readVaultLedger(providers: any, env: Env): Promise<any> {
  const cs = await providers.publicDataProvider.queryContractState(env.contractAddress);
  if (!cs) throw new Error(`no contract state at ${env.contractAddress}`);
  return (ledger as any)(cs.data);
}

function responseReader(providers: any, env: Env): SignetRequestResponseReader {
  return new SignetRequestResponseReader({
    requesterContractAddress: env.contractAddress,
    requesterRequestsIndexField: VAULT_REQUESTS_INDEX_FIELD,
    signetContractAddress: env.signetContractAddress,
    publicDataProvider: providers.publicDataProvider,
  } as any);
}

// Predict the request id the vault will record: the full request record, hashed.
function predictRequestId(
  env: Env,
  before: any,
  path: Uint8Array,
  nonce: bigint,
  erc20: Uint8Array,
  transferTo: Uint8Array,
  amount: bigint,
): RequestIdHex {
  const expected: SignBidirectionalEvent = {
    sender: { bytes: addrBytes(env.contractAddress) },
    requestNonce: before.signetRequestNonce,
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path,
    ...MPC_ROUTING,
    txParamType: TxParamType.evmType2,
    caip2Id: before.caip2Id,
    txParams: {
      to: erc20,
      chainId: before.evmChainId,
      nonce,
      gasLimit: GAS_LIMIT,
      maxFeePerGas: MAX_FEE,
      maxPriorityFeePerGas: PRIORITY_FEE,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
      calldata: {
        is_some: true,
        value: {
          selector: ERC20_TRANSFER_SELECTOR,
          noWords: 2n,
          words: [evmAddressAbiWord(transferTo), numericAbiWord(amount)],
        },
      },
    },
  } as any;
  return requestIdHex(calculateRequestId(expected)) as RequestIdHex;
}

async function assertRequestOnLedger(providers: any, env: Env, rid: RequestIdHex, circuit: string) {
  const after = await readVaultLedger(providers, env);
  if (!toSignBidirectionalEventIndex(after.signBidirectionalEventMap).has(rid)) {
    throw new Error(`request ${rid} not on the ledger after ${circuit}()`);
  }
}

async function fetchFakenetResponse(env: Env, requestId: string, timeoutMs = 8000): Promise<any> {
  const url = `${env.fakenetResponsesUrl}/responses/${requestId}`;
  const deadline = Date.now() + timeoutMs;
  let last = 'not attempted';
  do {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = `fetch failed: ${String(e)}`;
    }
    await sleep(1000);
  } while (Date.now() < deadline);
  throw new Error(`no fakenet response for ${requestId} (${last})`);
}

// Stage 1: poll the signet contract until the MPC's signature over the EVM tx appears.
async function pollSignatureResponse(
  providers: any,
  env: Env,
  requestId: RequestIdHex,
  expectedSigner: string,
  log: (m: string) => void,
  timeoutMs = 6 * MINUTE,
): Promise<Transaction> {
  const reader = responseReader(providers, env);
  const end = Date.now() + timeoutMs;
  const warned = new Set<bigint>();
  while (Date.now() < end) {
    const { verified, verdicts } = await reader.getVerifiedSignatureRespondedEvent(requestId, expectedSigner);
    for (const v of verdicts as any[]) {
      if (v.rejectedReason !== undefined && !warned.has(v.count)) {
        warned.add(v.count);
        log(`ignoring response post ${v.count}: ${v.rejectedReason}`);
      }
    }
    if (verified !== undefined) {
      const request = await reader.getSignatureRequest(requestId);
      return signBidirectionalEventToSignedEvmTransaction(request, verified) as unknown as Transaction;
    }
    await sleep(1000);
  }
  throw new Error(`timed out waiting for signature response to ${requestId}`);
}

// Broadcast the MPC-signed EVM tx (idempotent across retries).
async function broadcastEvm(env: Env, tx: Transaction): Promise<void> {
  const provider = new JsonRpcProvider(env.evmRpcUrl);
  const { hash } = tx;
  if (!hash) throw new Error('signed tx missing hash');
  const mined = await provider.getTransactionReceipt(hash);
  if (mined) {
    if (mined.status === 0) throw new Error(`sweep ${hash} reverted`);
    return;
  }
  try {
    await provider.broadcastTransaction(tx.serialized);
  } catch (e: any) {
    const msg = String(e?.message ?? '').toLowerCase();
    if (e?.code !== 'NONCE_EXPIRED' && !msg.includes('already known') && !msg.includes('nonce too low'))
      throw e;
  }
  const receipt = await provider.waitForTransaction(hash, 1, 3 * MINUTE);
  if (!receipt) throw new Error(`sweep ${hash} not confirmed`);
  if (receipt.status === 0) throw new Error(`sweep ${hash} reverted`);
}

// Stage 2: match the MPC's attestation digest against the recomputed serialized output.
// The log is unauthenticated — the settle circuits re-verify digest + signature in-circuit.
async function fetchAttestedRespondOutcome(providers: any, env: Env, requestId: RequestIdHex): Promise<any | undefined> {
  const events = await responseReader(providers, env).getRespondBidirectionalEvents(requestId);
  if (events.length === 0) return undefined;
  let cached: any;
  try {
    cached = await fetchFakenetResponse(env, requestId);
  } catch {
    return undefined;
  }
  const candidates: { serializedOutput: Uint8Array; isFailure: boolean }[] = [];
  let decodedSuccess: boolean | undefined;
  if (cached.success && cached.output != null) {
    try {
      const decoded: any = deserializeEvmOutput(RESULT_SCHEMA as any, cached.output);
      decodedSuccess = decoded.success === true;
      candidates.push({ serializedOutput: serializeRespondOutput(RESULT_SCHEMA as any, decoded), isFailure: false });
    } catch {
      /* only the failure candidate can match */
    }
  }
  candidates.push({ serializedOutput: MPC_FAILURE_OUTPUT, isFailure: true });
  for (const c of candidates) {
    const digest = calculateSignetAttestationDigest(requestIdBytes(requestId), c.serializedOutput);
    const event = (events as any[]).find(e =>
      Buffer.from(e.attestationDigest).equals(Buffer.from(digest)),
    );
    if (event) {
      return {
        event,
        serializedOutput: c.serializedOutput,
        succeeded: !c.isFailure && decodedSuccess === true,
        matchedFailureOutput: c.isFailure,
      };
    }
  }
  return undefined;
}

// MPC round trip shared by deposit + withdraw: signature -> broadcast -> attestation.
async function settleViaMpc(
  providers: any,
  env: Env,
  rid: RequestIdHex,
  expectedSigner: string,
  log: (m: string) => void,
): Promise<any> {
  flow.set('settling');
  log('Waiting for MPC signature + settling on Sepolia...');
  const signed = await pollSignatureResponse(providers, env, rid, expectedSigner, log);
  await broadcastEvm(env, signed);
  const end = Date.now() + 6 * MINUTE;
  while (Date.now() < end) {
    const outcome = await fetchAttestedRespondOutcome(providers, env, rid);
    if (outcome) return outcome;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for respond-bidirectional attestation for ${rid}`);
}

// deposit() -> MPC round trip -> claim() mints the shielded token.
export async function runDeposit(
  providers: any,
  vault: any,
  env: Env,
  identity: Identity,
  erc20Hex: string,
  amount: bigint,
  log: (m: string) => void,
) {
  flow.start('deposit');
  const erc20 = addrBytes(erc20Hex);
  const userEvm = depositAddress(env, identity);
  const nonce = await evmNonce(env, userEvm);
  log(`Deposit sender ${userEvm} (evm nonce ${nonce})`);

  const before = await readVaultLedger(providers, env);
  if (!before.initialized) throw new Error('vault not initialized');
  const rid = predictRequestId(env, before, identity.commitment, nonce, erc20, before.vaultEvmAddress, amount);
  log(`Predicted requestId 0x${rid}`);

  flow.set('proving');
  log('Submitting deposit() on Midnight...');
  await vault.callTx.deposit(nonce, GAS_LIMIT, MAX_FEE, PRIORITY_FEE, SIGNET_DEFAULT_KEY_VERSION, {
    erc20Address: erc20,
    amount,
  });
  await assertRequestOnLedger(providers, env, rid, 'deposit');

  const outcome = await settleViaMpc(providers, env, rid, userEvm, log);
  if (!outcome.succeeded) throw new Error(`MPC attested deposit ${rid} as FAILED`);

  flow.set('claim-proving');
  log('Submitting claim() to mint shielded token...');
  const selfRecipient = {
    is_some: false,
    value: { is_left: true, left: { bytes: new Uint8Array(32) }, right: { bytes: new Uint8Array(32) } },
  };
  await vault.callTx.claim(requestIdBytes(rid), outcome.event, outcome.serializedOutput, rand32(), selfRecipient);
  flow.set('done');
  log('Deposit complete — shielded token minted.');
}

// withdraw() -> MPC round trip -> completeWithdraw() (or refundWithdraw on failure).
export async function runWithdraw(
  providers: any,
  vault: any,
  env: Env,
  identity: Identity,
  erc20Hex: string,
  amount: bigint,
  destHex: string,
  log: (m: string) => void,
) {
  flow.start('withdraw');
  const erc20 = addrBytes(erc20Hex);
  const dest = addrBytes(destHex);
  const vaultEvm = vaultAddress(env);
  const nonce = await evmNonce(env, vaultEvm);
  log(`Withdraw sender (vault) ${vaultEvm} (evm nonce ${nonce})`);

  const before = await readVaultLedger(providers, env);
  if (!before.initialized) throw new Error('vault not initialized');
  const rid = predictRequestId(env, before, VAULT_PATH, nonce, erc20, dest, amount);

  const coin = {
    nonce: rand32(),
    color: hexToBytes(vaultTokenType(erc20Hex, env.contractAddress)),
    value: amount,
  };

  flow.set('proving');
  log('Submitting withdraw() (surrendering the vault coin)...');
  await vault.callTx.withdraw(nonce, SIGNET_DEFAULT_KEY_VERSION, { erc20Address: erc20, amount, destEvmAddress: dest }, coin);
  await assertRequestOnLedger(providers, env, rid, 'withdraw');

  const outcome = await settleViaMpc(providers, env, rid, vaultEvm, log);

  flow.set('claim-proving');
  if (outcome.matchedFailureOutput) {
    log('EVM transfer never executed — refunding...');
    await vault.callTx.refundWithdraw(requestIdBytes(rid), outcome.event, outcome.serializedOutput, rand32());
  } else {
    log('Settling completeWithdraw...');
    await vault.callTx.completeWithdraw(requestIdBytes(rid), outcome.event, outcome.serializedOutput, rand32());
  }
  flow.set('done');
  log(outcome.succeeded ? 'Withdraw finalized (success).' : 'Withdraw settled (refunded).');
}

async function evmNonce(env: Env, address: string): Promise<bigint> {
  return BigInt(await new JsonRpcProvider(env.evmRpcUrl).getTransactionCount(address));
}
