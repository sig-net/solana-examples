import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection } from "@solana/web3.js";
import BN from "bn.js";
import { SolanaCoreContracts } from "../target/types/solana_core_contracts";
import { expect } from "chai";
import { ethers } from "ethers";
import { contracts, utils as signetUtils } from "signet.js";
import { ChainSignatureServer } from "fakenet-signer";

const { getRequestIdBidirectional } = contracts.solana;
import { CONFIG, SERVER_CONFIG, TEST_TIMEOUT_MS } from "../utils/envConfig";

const COMPUTE_UNITS = 1_400_000;

interface TransactionParams {
  nonce: BN;
  value: BN;
  maxPriorityFeePerGas: BN;
  maxFeePerGas: BN;
  gasLimit: BN;
  chainId: BN;
}

class EthereumUtils {
  private provider: ethers.JsonRpcProvider;

  constructor() {
    this.provider = new ethers.JsonRpcProvider(CONFIG.SEPOLIA_RPC_URL);
  }

  /**
   * Get the provider instance
   */
  getProvider(): ethers.JsonRpcProvider {
    return this.provider;
  }

  /**
   * Build ERC20 transfer transaction
   */
  async buildTransferTransaction(
    from: string,
    to: string,
    amount: bigint
  ): Promise<{
    callData: string;
    txParams: TransactionParams;
    rlpEncodedTx: string;
    nonce: number;
  }> {
    const nonce = await this.provider.getTransactionCount(from);

    const transferInterface = new ethers.Interface([
      "function transfer(address to, uint256 amount) returns (bool)",
    ]);
    const callData = transferInterface.encodeFunctionData("transfer", [
      to,
      amount,
    ]);

    const feeData = await this.provider.getFeeData();
    const maxFeePerGas =
      feeData.maxFeePerGas || ethers.parseUnits("30", "gwei");
    const maxPriorityFeePerGas =
      feeData.maxPriorityFeePerGas || ethers.parseUnits("2", "gwei");

    const gasEstimate = await this.provider.estimateGas({
      from,
      to: CONFIG.USDC_ADDRESS_SEPOLIA,
      data: callData,
    });

    const gasLimit =
      (gasEstimate * BigInt(100 + CONFIG.GAS_BUFFER_PERCENT)) / BigInt(100);

    // Create transaction params
    const txParams: TransactionParams = {
      nonce: new BN(nonce),
      value: new BN(0),
      maxPriorityFeePerGas: new BN(maxPriorityFeePerGas.toString()),
      maxFeePerGas: new BN(maxFeePerGas.toString()),
      gasLimit: new BN(gasLimit.toString()),
      chainId: new BN(CONFIG.SEPOLIA_CHAIN_ID),
    };

    // Build RLP-encoded transaction
    const tempTx = {
      type: 2, // EIP-1559
      chainId: CONFIG.SEPOLIA_CHAIN_ID,
      nonce,
      maxPriorityFeePerGas,
      maxFeePerGas,
      gasLimit,
      to: CONFIG.USDC_ADDRESS_SEPOLIA,
      value: BigInt(0),
      data: callData,
    };

    const rlpEncodedTx = ethers.Transaction.from(tempTx).unsignedSerialized;

    return {
      callData,
      txParams,
      rlpEncodedTx: ethers.hexlify(rlpEncodedTx),
      nonce,
    };
  }

  /**
   * Submit signed transaction to Ethereum
   */
  async submitTransaction(signedTx: ethers.Transaction): Promise<string> {
    // Log before broadcasting so the hash and sender are on record even if the
    // transaction is never mined and the confirmation wait below times out.
    console.log("  📤 Broadcasting:", signedTx.hash);
    console.log("     from:", signedTx.from);
    const txHash = await this.provider.send("eth_sendRawTransaction", [
      signedTx.serialized,
    ]);
    return txHash;
  }

  /**
   * Wait for transaction confirmation
   */
  async waitForConfirmation(
    txHash: string,
    timeoutMs = CONFIG.ETH_CONFIRMATION_TIMEOUT_MS
  ): Promise<ethers.TransactionReceipt> {
    const receipt = await this.provider.waitForTransaction(
      txHash,
      1,
      timeoutMs
    );
    if (!receipt) {
      throw new Error(
        `Transaction ${txHash} not confirmed within ${timeoutMs}ms`
      );
    }
    if (receipt.status !== 1) {
      throw new Error("Transaction failed");
    }
    return receipt;
  }
}

async function ensureVaultConfigInitialized(
  program: Program<SolanaCoreContracts>,
  provider: anchor.AnchorProvider
) {
  const [vaultConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault_config")],
    program.programId
  );

  const desiredProgramId = new anchor.web3.PublicKey(
    CONFIG.CHAIN_SIGNATURES_PROGRAM_ID
  );

  const publicKeyHex = CONFIG.MPC_ROOT_PUBLIC_KEY.startsWith("04")
    ? CONFIG.MPC_ROOT_PUBLIC_KEY.slice(2)
    : CONFIG.MPC_ROOT_PUBLIC_KEY;
  const publicKeyBytes = Array.from(Buffer.from(publicKeyHex, "hex"));

  const accountInfo = await provider.connection.getAccountInfo(vaultConfigPda);

  // 1) does not exist: initialize with env config
  if (!accountInfo) {
    await program.methods
      .initializeConfig(publicKeyBytes, desiredProgramId)
      .accountsStrict({
        payer: provider.wallet.publicKey,
        config: vaultConfigPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log(
      "✅ vault_config initialized with:",
      desiredProgramId.toBase58()
    );
    return vaultConfigPda;
  }

  // 2) Already exists: check and sync
  const cfg = await program.account.vaultConfig.fetch(vaultConfigPda);

  const onchainProgramId: anchor.web3.PublicKey =
    (cfg as any).chainSignaturesProgramId ??
    (cfg as any).chain_signatures_program_id;

  const onchainRootKey: number[] =
    (cfg as any).mpcRootPublicKey ?? (cfg as any).mpc_root_public_key;

  // Both fields are checked: `update_config` writes them together, and the
  // program verifies respond signatures against the stored root key, so a
  // config stale in only that field fails at claim rather than earlier.
  const programIdMatches = onchainProgramId.equals(desiredProgramId);
  const rootKeyMatches = Buffer.from(onchainRootKey).equals(
    Buffer.from(publicKeyBytes)
  );

  if (!programIdMatches || !rootKeyMatches) {
    if (!programIdMatches) {
      console.log(
        "🔄 syncing onchain chain_signatures_program_id:",
        onchainProgramId.toBase58(),
        "->",
        desiredProgramId.toBase58()
      );
    }

    if (!rootKeyMatches) {
      console.log(
        "🔄 syncing onchain mpc_root_public_key:",
        "04" + Buffer.from(onchainRootKey).toString("hex").slice(0, 16) + "…",
        "->",
        "04" + Buffer.from(publicKeyBytes).toString("hex").slice(0, 16) + "…"
      );
    }

    await program.methods
      .updateConfig(publicKeyBytes, desiredProgramId)
      .accountsStrict({
        payer: provider.wallet.publicKey,
        config: vaultConfigPda,
      })
      .rpc();

    console.log("✅ synced.");
  } else {
    console.log("✅ onchain vault_config already matches env.");
  }

  return vaultConfigPda;
}

describe("🏦 ERC20 Deposit, Withdraw and Withdraw with refund Flow", () => {
  // Test context
  let provider: anchor.AnchorProvider;
  let program: Program<SolanaCoreContracts>;
  let chainSignatureContract: InstanceType<
    typeof contracts.solana.ChainSignatureContract
  >;
  let ethUtils: EthereumUtils;
  let server: ChainSignatureServer | null = null;
  let vaultConfigPda: anchor.web3.PublicKey;

  before(async function () {
    this.timeout(30000);

    const envProvider = anchor.AnchorProvider.env();
    const tracedConnection = new Connection(
      envProvider.connection.rpcEndpoint,
      {
        commitment: "confirmed",
        disableRetryOnRateLimit: true,
        fetch: async (input, init) => {
          const res = await globalThis.fetch(input, init);
          if (res.status === 429) {
            let method = "unknown";
            try {
              const body = JSON.parse(init?.body as string);
              method = Array.isArray(body)
                ? body.map((r: { method: string }) => r.method).join(", ")
                : body.method ?? "unknown";
            } catch {}
            console.warn(
              `\n[429 TRACE] RPC method: ${method}\n${new Error().stack}`
            );
          }
          return res;
        },
      }
    );
    provider = new anchor.AnchorProvider(
      tracedConnection,
      envProvider.wallet,
      anchor.AnchorProvider.defaultOptions()
    );
    anchor.setProvider(provider);

    program = anchor.workspace
      .SolanaCoreContracts as Program<SolanaCoreContracts>;

    vaultConfigPda = await ensureVaultConfigInitialized(program, provider);

    ethUtils = new EthereumUtils();

    chainSignatureContract = new contracts.solana.ChainSignatureContract({
      provider,
      programId: CONFIG.CHAIN_SIGNATURES_PROGRAM_ID,
      config: {
        rootPublicKey: CONFIG.MPC_ROOT_PUBLIC_KEY as `04${string}`,
      },
    });

    const cfg = await program.account.vaultConfig.fetch(vaultConfigPda);
    console.log(
      "onchain config chain sig program:",
      cfg.chainSignaturesProgramId.toBase58()
    );
    console.log("env chain sig program:", CONFIG.CHAIN_SIGNATURES_PROGRAM_ID);

    if (!SERVER_CONFIG.DISABLE_LOCAL_CHAIN_SIGNATURE_SERVER) {
      const serverConfig = {
        solanaRpcUrl: SERVER_CONFIG.SOLANA_RPC_URL,
        solanaPrivateKey: SERVER_CONFIG.SOLANA_PRIVATE_KEY,
        mpcRootKey: CONFIG.MPC_ROOT_PRIVATE_KEY,
        infuraApiKey: CONFIG.INFURA_API_KEY,
        programId: CONFIG.CHAIN_SIGNATURES_PROGRAM_ID,
        isDevnet: true,
        verbose: false,
        bitcoinNetwork: CONFIG.BITCOIN_NETWORK,
      };

      server = new ChainSignatureServer(serverConfig);
      await server.start();
    } else {
      console.log("🔌 Local ChainSignatureServer disabled via config");
    }
  });

  after(async function () {
    this.timeout(10000);

    if (server) {
      await server.shutdown();
      server = null;
    }
  });

  it("Should complete full ERC20 deposit flow", async function () {
    this.timeout(TEST_TIMEOUT_MS);
    console.log("\n🚀 Starting ERC20 Deposit Flow Test\n");

    // =====================================================
    // STEP 1: DERIVE ADDRESSES
    // =====================================================

    console.log("📍 Step 1: Deriving addresses...");

    const [vaultAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), provider.wallet.publicKey.toBuffer()],
      program.programId
    );

    const [globalVaultAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global_vault_authority")],
      program.programId
    );

    const path = provider.wallet.publicKey.toString();
    const derivedPublicKey = signetUtils.cryptography.deriveChildPublicKey(
      CONFIG.MPC_ROOT_PUBLIC_KEY as `04${string}`,
      vaultAuthority.toString(),
      path,
      CONFIG.SOLANA_CAIP2_ID,
      CONFIG.KEY_VERSION
    );
    const derivedAddress = ethers.computeAddress("0x" + derivedPublicKey);

    const signerPublicKey = signetUtils.cryptography.deriveChildPublicKey(
      CONFIG.MPC_ROOT_PUBLIC_KEY as `04${string}`,
      globalVaultAuthority.toString(),
      "root",
      CONFIG.SOLANA_CAIP2_ID,
      CONFIG.KEY_VERSION
    );
    const signerAddress = ethers.computeAddress("0x" + signerPublicKey);

    const mpcRespondPublicKey = signetUtils.cryptography.deriveChildPublicKey(
      CONFIG.MPC_ROOT_PUBLIC_KEY as `04${string}`,
      vaultAuthority.toString(),
      CONFIG.SOLANA_RESPOND_BIDIRECTIONAL_PATH,
      CONFIG.SOLANA_CAIP2_ID,
      CONFIG.KEY_VERSION
    );
    const mpcRespondAddress = ethers.computeAddress("0x" + mpcRespondPublicKey);

    console.log("  🔑 MPC Respond address:", mpcRespondAddress);
    console.log("  👛 Wallet:", provider.wallet.publicKey.toString());
    console.log(
      "  🔑 Chain Signatures Program ID:",
      CONFIG.CHAIN_SIGNATURES_PROGRAM_ID
    );
    console.log("  🔑 Derived address (FROM):", derivedAddress);
    console.log("  🎯 Signer address (TO):", signerAddress);
    console.log("  ⏳ Waiting 5 seconds...\n");
    await new Promise((resolve) =>
      setTimeout(resolve, CONFIG.WAIT_FOR_FUNDING_MS)
    );

    // =====================================================
    // STEP 2: PREPARE TRANSACTION
    // =====================================================

    console.log("📍 Step 2: Preparing transaction...");

    const amountBigInt = ethers.parseUnits(
      CONFIG.TRANSFER_AMOUNT,
      CONFIG.DECIMALS
    );
    const amountBN = new BN(amountBigInt.toString());
    const erc20AddressBytes = Array.from(
      Buffer.from(CONFIG.USDC_ADDRESS_SEPOLIA.slice(2), "hex")
    );

    const { callData, txParams, rlpEncodedTx, nonce } =
      await ethUtils.buildTransferTransaction(
        derivedAddress,
        signerAddress,
        amountBigInt
      );

    console.log("  💰 Depositing:", amountBN.toString(), "units");

    // Generate request ID
    const requestId = contracts.solana.getRequestIdBidirectional({
      sender: vaultAuthority.toString(),
      payload: Array.from(ethers.getBytes(rlpEncodedTx)),
      caip2Id: CONFIG.ETHEREUM_CAIP2_ID,
      keyVersion: CONFIG.KEY_VERSION,
      path,
      algo: "ECDSA",
      dest: "ethereum",
      params: "",
    });
    const requestIdBytes = Array.from(Buffer.from(requestId.slice(2), "hex"));
    console.log(" requestId:", requestId);

    // =====================================================
    // STEP 3: DEPOSIT ERC20
    // =====================================================

    console.log("\n📍 Step 3: Initiating deposit...");

    const accounts = await getDepositAccounts(
      program,
      provider,
      requestIdBytes,
      erc20AddressBytes
    );

    // Check initial balance
    const initialBalance = await getInitialBalance(
      program,
      accounts.userBalance
    );

    const recipientAddressBytes = Array.from(
      Buffer.from(signerAddress.slice(2), "hex")
    );

    const depositTx = await program.methods
      .depositErc20(
        requestIdBytes,
        provider.wallet.publicKey,
        erc20AddressBytes,
        recipientAddressBytes,
        amountBN,
        txParams
      )
      .accountsStrict({
        payer: provider.wallet.publicKey,
        requesterPda: vaultAuthority,
        pendingDeposit: accounts.pendingDeposit,
        feePayer: provider.wallet.publicKey,
        chainSignaturesProgram: accounts.chainSignaturesProgram,
        chainSignaturesState: accounts.chainSignaturesState,
        eventAuthority: accounts.eventAuthority,
        systemProgram: anchor.web3.SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        config: vaultConfigPda,
      })
      .rpc();

    console.log("  ✅ Deposit transaction:", depositTx);

    // =====================================================
    // STEP 4: SETUP EVENT LISTENERS
    // =====================================================

    console.log("\n📍 Step 4: Setting up event listeners...");

    const signer = new anchor.web3.PublicKey(
      CONFIG.CHAIN_SIGNATURES_PROGRAM_ID
    );

    // Start listeners AFTER the Solana tx so backfill starts from the tx hash
    const signaturePromise = chainSignatureContract.waitForEvent({
      eventName: "signatureRespondedEvent",
      requestId,
      signer,
      afterSignature: depositTx,
      timeoutMs: CONFIG.WAIT_FOR_EVENT_TIMEOUT_MS,
      backfillIntervalMs: 15_000,
      healthCheckIntervalMs: 15_000,
    });
    const respondBidirectionalPromise = chainSignatureContract.waitForEvent({
      eventName: "respondBidirectionalEvent",
      requestId,
      signer,
      afterSignature: depositTx,
      timeoutMs: CONFIG.WAIT_FOR_EVENT_TIMEOUT_MS,
      backfillIntervalMs: 15_000,
      healthCheckIntervalMs: 15_000,
    });

    // =====================================================
    // STEP 5: WAIT FOR SIGNATURE
    // =====================================================

    console.log("\n📍 Step 5: Waiting for signature...");

    const rsvSignature = await signaturePromise;
    const signature = {
      r: "0x" + rsvSignature.r,
      s: "0x" + rsvSignature.s,
      v: BigInt(rsvSignature.v),
    };

    // =====================================================
    // STEP 6: SUBMIT TO ETHEREUM
    // =====================================================

    console.log("\n📍 Step 6: Submitting to Ethereum...");

    const signedTx = ethers.Transaction.from({
      type: 2,
      chainId: CONFIG.SEPOLIA_CHAIN_ID,
      nonce,
      maxPriorityFeePerGas: BigInt(txParams.maxPriorityFeePerGas.toString()),
      maxFeePerGas: BigInt(txParams.maxFeePerGas.toString()),
      gasLimit: BigInt(txParams.gasLimit.toString()),
      to: CONFIG.USDC_ADDRESS_SEPOLIA,
      value: BigInt(0),
      data: callData,
      signature,
    });

    const txHash = await ethUtils.submitTransaction(signedTx);
    await ethUtils.waitForConfirmation(txHash);
    console.log("  ✅ Transaction confirmed:", txHash);

    // =====================================================
    // STEP 7: CLAIM DEPOSIT
    // =====================================================

    console.log("\n📍 Step 7: Claiming deposit...");

    const respondBidirectionalEvent = await respondBidirectionalPromise;
    console.log("  ✅ Got read response!");

    const claimTx = await program.methods
      .claimErc20(
        requestIdBytes,
        Buffer.from(respondBidirectionalEvent.serializedOutput),
        respondBidirectionalEvent.signature
      )
      .accounts({
        userBalance: accounts.userBalance,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }),
      ])
      .rpc();

    console.log("  ✅ Claim transaction:", claimTx);

    // =====================================================
    // STEP 8: VERIFY BALANCE
    // =====================================================

    console.log("\n📍 Step 8: Verifying balance...");

    const finalBalance = await program.account.userErc20Balance.fetch(
      accounts.userBalance
    );
    const expectedBalance = initialBalance.add(amountBN);

    console.log("  💰 Initial balance:", initialBalance.toString());
    console.log("  ➕ Amount deposited:", amountBN.toString());
    console.log("  💰 Final balance:", finalBalance.amount.toString());
    console.log("  ✅ Expected balance:", expectedBalance.toString());

    expect(finalBalance.amount.toString()).to.equal(expectedBalance.toString());

    console.log("\n🎉 ERC20 deposit flow completed successfully!");
  });

  it("Should complete full ERC20 withdraw flow", async function () {
    this.timeout(TEST_TIMEOUT_MS);
    console.log("\n🚀 Starting ERC20 Withdraw Flow Test\n");

    // =====================================================
    // STEP 1: CHECK BALANCE
    // =====================================================

    console.log("📍 Step 1: Checking current balance...");

    const erc20AddressBytes = Array.from(
      Buffer.from(CONFIG.USDC_ADDRESS_SEPOLIA.slice(2), "hex")
    );

    const [userBalance] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("user_erc20_balance"),
        provider.wallet.publicKey.toBuffer(),
        Buffer.from(erc20AddressBytes),
      ],
      program.programId
    );

    const currentBalance = await program.account.userErc20Balance.fetch(
      userBalance
    );
    console.log("  💰 Current balance:", currentBalance.amount.toString());

    const chainSignaturesProgram = new anchor.web3.PublicKey(
      CONFIG.CHAIN_SIGNATURES_PROGRAM_ID
    );

    const [chainSignaturesState] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("program-state")],
      chainSignaturesProgram
    );

    const [eventAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      chainSignaturesProgram
    );

    // =====================================================
    // STEP 2: DERIVE RECIPIENT ADDRESS
    // =====================================================

    console.log("\n📍 Step 2: Deriving signer address...");

    const [globalVaultAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global_vault_authority")],
      program.programId
    );

    const signerPublicKey = signetUtils.cryptography.deriveChildPublicKey(
      CONFIG.MPC_ROOT_PUBLIC_KEY as `04${string}`,
      globalVaultAuthority.toString(),
      "root",
      CONFIG.SOLANA_CAIP2_ID,
      CONFIG.KEY_VERSION
    );
    const signerAddress = ethers.computeAddress("0x" + signerPublicKey);

    const mpcRespondPublicKey = signetUtils.cryptography.deriveChildPublicKey(
      CONFIG.MPC_ROOT_PUBLIC_KEY as `04${string}`,
      globalVaultAuthority.toString(),
      CONFIG.SOLANA_RESPOND_BIDIRECTIONAL_PATH,
      CONFIG.SOLANA_CAIP2_ID,
      CONFIG.KEY_VERSION
    );
    const mpcRespondAddress = ethers.computeAddress("0x" + mpcRespondPublicKey);

    console.log("  🔑 MPC Respond address:", mpcRespondAddress);

    const recipientAddress = CONFIG.WITHDRAWAL_RECIPIENT_ADDRESS;
    const recipientAddressBytes = Array.from(
      Buffer.from(recipientAddress.slice(2), "hex")
    );

    console.log("  👛 Wallet:", provider.wallet.publicKey.toString());
    console.log("  🔑 MPC Signer (FROM):", signerAddress);
    console.log("  🎯 Recipient (TO):", recipientAddress);

    // =====================================================
    // STEP 3: PREPARE WITHDRAWAL TRANSACTION
    // =====================================================

    console.log("\n📍 Step 3: Preparing withdrawal transaction...");

    // Withdraw half the balance
    const withdrawAmount = currentBalance.amount.div(new BN(2));
    const withdrawAmountBigInt = BigInt(withdrawAmount.toString());

    // Get nonce for MPC signer (the transaction will be FROM this address)
    const ethprovider = ethUtils.getProvider();
    const nonce = await ethprovider.getTransactionCount(signerAddress);

    // Build withdrawal transaction
    const transferInterface = new ethers.Interface([
      "function transfer(address to, uint256 amount) returns (bool)",
    ]);
    const callData = transferInterface.encodeFunctionData("transfer", [
      recipientAddress,
      withdrawAmountBigInt,
    ]);

    // Get gas prices
    const feeData = await ethprovider.getFeeData();
    const maxFeePerGas =
      feeData.maxFeePerGas || ethers.parseUnits("30", "gwei");
    const maxPriorityFeePerGas =
      feeData.maxPriorityFeePerGas || ethers.parseUnits("2", "gwei");

    // Estimate gas
    const gasEstimate = await ethprovider.estimateGas({
      from: signerAddress,
      to: CONFIG.USDC_ADDRESS_SEPOLIA,
      data: callData,
    });

    const gasLimit =
      (gasEstimate * BigInt(100 + CONFIG.GAS_BUFFER_PERCENT)) / BigInt(100);

    const txParams: TransactionParams = {
      nonce: new BN(nonce),
      value: new BN(0),
      maxPriorityFeePerGas: new BN(maxPriorityFeePerGas.toString()),
      maxFeePerGas: new BN(maxFeePerGas.toString()),
      gasLimit: new BN(gasLimit.toString()),
      chainId: new BN(CONFIG.SEPOLIA_CHAIN_ID),
    };

    // Build RLP-encoded transaction
    const tempTx = {
      type: 2,
      chainId: CONFIG.SEPOLIA_CHAIN_ID,
      nonce,
      maxPriorityFeePerGas,
      maxFeePerGas,
      gasLimit,
      to: CONFIG.USDC_ADDRESS_SEPOLIA,
      value: BigInt(0),
      data: callData,
    };

    const rlpEncodedTx = ethers.Transaction.from(tempTx).unsignedSerialized;

    // Generate request ID - using HARDCODED_ROOT_PATH
    const requestId = getRequestIdBidirectional({
      sender: globalVaultAuthority.toString(),
      payload: Array.from(ethers.getBytes(rlpEncodedTx)),
      caip2Id: CONFIG.ETHEREUM_CAIP2_ID,
      keyVersion: CONFIG.KEY_VERSION,
      path: "root", // HARDCODED_ROOT_PATH
      algo: "ECDSA",
      dest: "ethereum",
      params: "",
    });
    const requestIdBytes = Array.from(Buffer.from(requestId.slice(2), "hex"));

    console.log(" requestId:", requestId);

    const [pendingWithdrawal] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("pending_erc20_withdrawal"), Buffer.from(requestIdBytes)],
      program.programId
    );

    // =====================================================
    // STEP 4: INITIATE WITHDRAWAL
    // =====================================================

    console.log("\n📍 Step 4: Initiating withdrawal...");

    const withdrawTx = await program.methods
      .withdrawErc20(
        requestIdBytes,
        erc20AddressBytes,
        withdrawAmount,
        recipientAddressBytes,
        txParams
      )
      .accountsStrict({
        authority: provider.wallet.publicKey,
        requester: globalVaultAuthority,
        pendingWithdrawal,
        userBalance,
        feePayer: provider.wallet.publicKey,
        chainSignaturesState,
        eventAuthority,
        chainSignaturesProgram,
        systemProgram: anchor.web3.SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        config: vaultConfigPda,
      })
      .rpc();

    console.log("  ✅ Withdrawal transaction:", withdrawTx);

    // Check balance was decremented
    const balanceAfterWithdraw = await program.account.userErc20Balance.fetch(
      userBalance
    );
    console.log(
      "  💰 Balance after withdrawal:",
      balanceAfterWithdraw.amount.toString()
    );
    const expectedBalanceAfterWithdraw =
      currentBalance.amount.sub(withdrawAmount);
    expect(balanceAfterWithdraw.amount.toString()).to.equal(
      expectedBalanceAfterWithdraw.toString()
    );

    // =====================================================
    // STEP 5: SETUP EVENT LISTENERS
    // =====================================================

    console.log("\n📍 Step 5: Setting up event listeners...");

    const signer = new anchor.web3.PublicKey(
      CONFIG.CHAIN_SIGNATURES_PROGRAM_ID
    );

    // Start listeners AFTER the Solana tx so backfill starts from the tx hash
    const signaturePromise = chainSignatureContract.waitForEvent({
      eventName: "signatureRespondedEvent",
      requestId,
      signer,
      afterSignature: withdrawTx,
      timeoutMs: CONFIG.WAIT_FOR_EVENT_TIMEOUT_MS,
      backfillIntervalMs: 15_000,
      healthCheckIntervalMs: 15_000,
    });
    const respondBidirectionalPromise = chainSignatureContract.waitForEvent({
      eventName: "respondBidirectionalEvent",
      requestId,
      signer,
      afterSignature: withdrawTx,
      timeoutMs: CONFIG.WAIT_FOR_EVENT_TIMEOUT_MS,
      backfillIntervalMs: 15_000,
      healthCheckIntervalMs: 15_000,
    });

    // =====================================================
    // STEP 6: WAIT FOR SIGNATURE
    // =====================================================

    console.log("\n📍 Step 6: Waiting for signature...");

    const rsvSignature = await signaturePromise;
    const signature = {
      r: "0x" + rsvSignature.r,
      s: "0x" + rsvSignature.s,
      v: BigInt(rsvSignature.v),
    };

    // =====================================================
    // STEP 7: SUBMIT TO ETHEREUM
    // =====================================================

    console.log("\n📍 Step 7: Submitting to Ethereum...");

    const signedTx = ethers.Transaction.from({
      type: 2,
      chainId: CONFIG.SEPOLIA_CHAIN_ID,
      nonce,
      maxPriorityFeePerGas: BigInt(txParams.maxPriorityFeePerGas.toString()),
      maxFeePerGas: BigInt(txParams.maxFeePerGas.toString()),
      gasLimit: BigInt(txParams.gasLimit.toString()),
      to: CONFIG.USDC_ADDRESS_SEPOLIA,
      value: BigInt(0),
      data: callData,
      signature,
    });

    if (signedTx.from?.toLowerCase() !== signerAddress.toLowerCase()) {
      throw new Error(
        `Transaction from address mismatch! Expected ${signerAddress}, got ${signedTx.from}`
      );
    }

    try {
      const txHash = await ethUtils.submitTransaction(signedTx);
      await ethUtils.waitForConfirmation(txHash);
      console.log("  ✅ Transaction confirmed:", txHash);
    } catch (error: any) {
      console.error(
        "  ❌ Transaction failed:",
        error.message || error.shortMessage || error
      );
      throw error;
    }

    // =====================================================
    // STEP 8: COMPLETE WITHDRAWAL
    // =====================================================

    console.log("\n📍 Step 8: Completing withdrawal...");

    const respondBidirectionalEvent = await respondBidirectionalPromise;

    await program.methods
      .completeWithdrawErc20(
        requestIdBytes,
        Buffer.from(respondBidirectionalEvent.serializedOutput),
        respondBidirectionalEvent.signature
      )
      .accounts({
        userBalance,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }),
      ])
      .rpc();

    // Check if withdrawal was successful by checking balance
    const finalBalance = await program.account.userErc20Balance.fetch(
      userBalance
    );

    if (respondBidirectionalEvent.serializedOutput.length === 1) {
      const success = respondBidirectionalEvent.serializedOutput[0] === 1;
      if (!success) {
        console.log("  ⚠️ Transfer failed, balance refunded");
        expect(finalBalance.amount.toString()).to.equal(
          withdrawAmount.toString()
        );
        return;
      }
    } else {
      console.log("  ⚠️ Transaction reverted, balance refunded");
      expect(finalBalance.amount.toString()).to.equal(
        withdrawAmount.toString()
      );
      return;
    }

    const expectedBalance = currentBalance.amount.sub(withdrawAmount);
    expect(finalBalance.amount.toString()).to.equal(expectedBalance.toString());
    console.log("  ✅ Withdrawal complete");

    // =====================================================
    // STEP 9: VERIFY RECIPIENT BALANCE
    // =====================================================

    console.log("\n🎉 ERC20 withdrawal flow completed successfully!");
  });

  it("Should handle failed ERC20 withdrawal and refund balance", async function () {
    this.timeout(TEST_TIMEOUT_MS);
    console.log("\n🚀 Starting Failed ERC20 Withdrawal Test\n");

    // =====================================================
    // STEP 1: CHECK EXISTING BALANCE
    // =====================================================

    console.log("📍 Step 1: Checking existing balance...");

    const erc20AddressBytes = Array.from(
      Buffer.from(CONFIG.USDC_ADDRESS_SEPOLIA.slice(2), "hex")
    );

    const [userBalance] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("user_erc20_balance"),
        provider.wallet.publicKey.toBuffer(),
        Buffer.from(erc20AddressBytes),
      ],
      program.programId
    );

    const currentBalance = await program.account.userErc20Balance.fetch(
      userBalance
    );
    console.log("  💰 Current balance:", currentBalance.amount.toString());

    if (currentBalance.amount.eq(new BN(0))) {
      console.log("  ⚠️ No balance to test withdrawal failure. Skipping test.");
      return;
    }

    const chainSignaturesProgram = new anchor.web3.PublicKey(
      CONFIG.CHAIN_SIGNATURES_PROGRAM_ID
    );

    const [chainSignaturesState] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("program-state")],
      chainSignaturesProgram
    );

    const [eventAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      chainSignaturesProgram
    );

    // =====================================================
    // STEP 2: CREATE FAILING WITHDRAWAL
    // =====================================================

    console.log("\n📍 Step 2: Creating withdrawal that will fail...");

    const recipientAddress = "0x0000000000000000000000000000000000000001";
    const recipientAddressBytes = Array.from(
      Buffer.from(recipientAddress.slice(2), "hex")
    );

    const withdrawAmount = currentBalance.amount;

    // Derive the MPC signer address first
    const [globalVaultAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global_vault_authority")],
      program.programId
    );

    const signerPublicKey = signetUtils.cryptography.deriveChildPublicKey(
      CONFIG.MPC_ROOT_PUBLIC_KEY as `04${string}`,
      globalVaultAuthority.toString(),
      "root",
      CONFIG.SOLANA_CAIP2_ID,
      CONFIG.KEY_VERSION
    );
    const signerAddress = ethers.computeAddress("0x" + signerPublicKey);

    const mpcRespondPublicKey = signetUtils.cryptography.deriveChildPublicKey(
      CONFIG.MPC_ROOT_PUBLIC_KEY as `04${string}`,
      globalVaultAuthority.toString(),
      CONFIG.SOLANA_RESPOND_BIDIRECTIONAL_PATH,
      CONFIG.SOLANA_CAIP2_ID,
      CONFIG.KEY_VERSION
    );
    const mpcRespondAddress = ethers.computeAddress("0x" + mpcRespondPublicKey);

    // Get current nonce for MPC signer
    const ethprovider = ethUtils.getProvider();
    const currentNonce = await ethprovider.getTransactionCount(signerAddress);

    // Use an old nonce to make transaction fail
    const oldNonce = currentNonce > 0 ? currentNonce - 1 : 0;
    console.log(
      "  📊 Using old nonce:",
      oldNonce,
      "(current:",
      currentNonce + ")"
    );

    // Build withdrawal transaction with OLD nonce
    const transferInterface = new ethers.Interface([
      "function transfer(address to, uint256 amount) returns (bool)",
    ]);
    const callData = transferInterface.encodeFunctionData("transfer", [
      recipientAddress,
      withdrawAmount.toString(),
    ]);

    const feeData = await ethprovider.getFeeData();
    const maxFeePerGas =
      feeData.maxFeePerGas || ethers.parseUnits("30", "gwei");
    const maxPriorityFeePerGas =
      feeData.maxPriorityFeePerGas || ethers.parseUnits("2", "gwei");

    const gasEstimate = 100000;

    const txParams: TransactionParams = {
      nonce: new BN(oldNonce), // OLD NONCE
      value: new BN(0),
      maxPriorityFeePerGas: new BN(maxPriorityFeePerGas.toString()),
      maxFeePerGas: new BN(maxFeePerGas.toString()),
      gasLimit: new BN(gasEstimate.toString()),
      chainId: new BN(CONFIG.SEPOLIA_CHAIN_ID),
    };

    const tempTx = {
      type: 2,
      chainId: CONFIG.SEPOLIA_CHAIN_ID,
      nonce: oldNonce,
      maxPriorityFeePerGas,
      maxFeePerGas,
      gasLimit: BigInt(gasEstimate),
      to: CONFIG.USDC_ADDRESS_SEPOLIA,
      value: BigInt(0),
      data: callData,
    };

    const rlpEncodedTx = ethers.Transaction.from(tempTx).unsignedSerialized;

    const requestId = getRequestIdBidirectional({
      sender: globalVaultAuthority.toString(),
      payload: Array.from(ethers.getBytes(rlpEncodedTx)),
      caip2Id: CONFIG.ETHEREUM_CAIP2_ID,
      keyVersion: CONFIG.KEY_VERSION,
      path: "root", // HARDCODED_ROOT_PATH
      algo: "ECDSA",
      dest: "ethereum",
      params: "",
    });
    const requestIdBytes = Array.from(Buffer.from(requestId.slice(2), "hex"));

    console.log(" requestId:", requestId);

    const [pendingWithdrawal] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("pending_erc20_withdrawal"), Buffer.from(requestIdBytes)],
      program.programId
    );

    // =====================================================
    // STEP 3: INITIATE WITHDRAWAL
    // =====================================================

    console.log("\n📍 Step 3: Initiating withdrawal...");

    const balanceBeforeWithdraw = currentBalance.amount;

    const withdrawTx = await program.methods
      .withdrawErc20(
        requestIdBytes,
        erc20AddressBytes,
        withdrawAmount,
        recipientAddressBytes,
        txParams
      )
      .accountsStrict({
        authority: provider.wallet.publicKey,
        requester: globalVaultAuthority,
        pendingWithdrawal,
        userBalance,
        feePayer: provider.wallet.publicKey,
        chainSignaturesState,
        eventAuthority,
        chainSignaturesProgram,
        systemProgram: anchor.web3.SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        config: vaultConfigPda,
      })
      .rpc();

    console.log("  ✅ Withdrawal transaction:", withdrawTx);

    // Check balance was decremented optimistically
    const balanceAfterWithdraw = await program.account.userErc20Balance.fetch(
      userBalance
    );
    console.log(
      "  💰 Balance after withdrawal:",
      balanceAfterWithdraw.amount.toString()
    );
    expect(balanceAfterWithdraw.amount.toString()).to.equal("0");

    // =====================================================
    // STEP 4: SETUP EVENT LISTENERS
    // =====================================================

    console.log("\n📍 Step 4: Setting up event listeners...");

    const signer = new anchor.web3.PublicKey(
      CONFIG.CHAIN_SIGNATURES_PROGRAM_ID
    );

    // Start listeners AFTER the Solana tx so backfill starts from the tx hash
    const signaturePromise = chainSignatureContract.waitForEvent({
      eventName: "signatureRespondedEvent",
      requestId,
      signer,
      afterSignature: withdrawTx,
      timeoutMs: CONFIG.WAIT_FOR_EVENT_TIMEOUT_MS,
      backfillIntervalMs: 15_000,
      healthCheckIntervalMs: 15_000,
    });
    const respondBidirectionalPromise = chainSignatureContract.waitForEvent({
      eventName: "respondBidirectionalEvent",
      requestId,
      signer,
      afterSignature: withdrawTx,
      timeoutMs: CONFIG.WAIT_FOR_EVENT_TIMEOUT_MS,
      backfillIntervalMs: 15_000,
      healthCheckIntervalMs: 15_000,
    });

    // =====================================================
    // STEP 5: WAIT FOR SIGNATURE
    // =====================================================

    console.log("\n📍 Step 5: Waiting for signature...");

    const rsvSignature = await signaturePromise;
    const signature = {
      r: "0x" + rsvSignature.r,
      s: "0x" + rsvSignature.s,
      v: BigInt(rsvSignature.v),
    };

    // =====================================================
    // STEP 6: TRY TO SUBMIT (WILL FAIL)
    // =====================================================

    console.log("\n📍 Step 6: Attempting to submit transaction...");

    const signedTx = ethers.Transaction.from({
      type: 2,
      chainId: CONFIG.SEPOLIA_CHAIN_ID,
      nonce: txParams.nonce.toNumber(),
      maxPriorityFeePerGas: BigInt(txParams.maxPriorityFeePerGas.toString()),
      maxFeePerGas: BigInt(txParams.maxFeePerGas.toString()),
      gasLimit: BigInt(txParams.gasLimit.toString()),
      to: CONFIG.USDC_ADDRESS_SEPOLIA,
      value: BigInt(0),
      data: callData,
      signature,
    });

    try {
      const txHash = await ethUtils.submitTransaction(signedTx);
      await ethUtils.waitForConfirmation(txHash);
      console.log("  ⚠️ Transaction unexpectedly succeeded!");
    } catch (error: any) {
      console.log("  ✅ Transaction failed as expected");
    }

    // =====================================================
    // STEP 7: WAIT FOR ERROR RESPONSE
    // =====================================================

    console.log("\n📍 Step 7: Waiting for error response...");

    const respondBidirectionalEvent = await respondBidirectionalPromise;

    // =====================================================
    // STEP 8: COMPLETE WITHDRAWAL (REFUND)
    // =====================================================

    console.log("\n📍 Step 8: Completing withdrawal (expecting refund)...");

    await program.methods
      .completeWithdrawErc20(
        requestIdBytes,
        Buffer.from(respondBidirectionalEvent.serializedOutput),
        respondBidirectionalEvent.signature
      )
      .accounts({
        userBalance,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }),
      ])
      .rpc();

    // =====================================================
    // STEP 9: VERIFY REFUND
    // =====================================================

    console.log("\n📍 Step 9: Verifying balance was refunded...");

    const finalBalance = await program.account.userErc20Balance.fetch(
      userBalance
    );

    expect(finalBalance.amount.toString()).to.equal(
      balanceBeforeWithdraw.toString()
    );

    console.log("  ✅ Balance refunded:", finalBalance.amount.toString());

    console.log("\n🎉 Failed withdrawal handled correctly!");
  });
});

/**
 * Get deposit accounts
 */
async function getDepositAccounts(
  program: Program<SolanaCoreContracts>,
  provider: anchor.AnchorProvider,
  requestIdBytes: number[],
  erc20AddressBytes: number[]
) {
  const [pendingDeposit] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("pending_erc20_deposit"), Buffer.from(requestIdBytes)],
    program.programId
  );

  const [userBalance] = anchor.web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("user_erc20_balance"),
      provider.wallet.publicKey.toBuffer(),
      Buffer.from(erc20AddressBytes),
    ],
    program.programId
  );

  const chainSignaturesProgram = new anchor.web3.PublicKey(
    CONFIG.CHAIN_SIGNATURES_PROGRAM_ID
  );

  const [chainSignaturesState] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("program-state")],
    chainSignaturesProgram
  );

  const [eventAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    chainSignaturesProgram
  );

  return {
    pendingDeposit,
    userBalance,
    chainSignaturesProgram,
    chainSignaturesState,
    eventAuthority,
  };
}

/**
 * Get initial balance
 */
async function getInitialBalance(
  program: Program<SolanaCoreContracts>,
  userBalance: anchor.web3.PublicKey
): Promise<BN> {
  try {
    const account = await program.account.userErc20Balance.fetch(userBalance);
    console.log("  💰 Initial balance:", account.amount.toString());
    return account.amount as BN;
  } catch {
    console.log("  💰 No existing balance");
    return new BN(0);
  }
}
