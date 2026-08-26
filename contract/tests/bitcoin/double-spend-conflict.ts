import * as anchor from "@coral-xyz/anchor";
import { ComputeBudgetProgram } from "@solana/web3.js";
import { expect } from "chai";
import * as bitcoin from "bitcoinjs-lib";
import ECPairFactory from "ecpair";
import * as ecc from "tiny-secp256k1";
import { CryptoUtils } from "fakenet-signer";
import {
  applySignaturesToPsbt,
  bnToBigInt,
  buildWithdrawalPlan,
  buildWithdrawalPsbt,
  computeSignatureRequestIds,
  COMPUTE_UNITS,
  createFundedAuthority,
  executeSyntheticDeposit,
  fetchUserBalance,
  getBitcoinTestContext,
  planRequestIdBytes,
  setupBitcoinTestContext,
  startBtcEventListeners,
  teardownBitcoinTestContext,
} from "./utils";
import { CONFIG } from "../../utils/envConfig";

const ECPair = ECPairFactory(ecc);

describe("BTC Withdrawal Double-Spend Conflict", () => {
  before(async function () {
    await setupBitcoinTestContext();
  });

  after(async function () {
    await teardownBitcoinTestContext();
  });

  it("refunds balance when withdrawal UTXOs are double-spent", async function () {
    this.timeout(30_000);

    const { provider, program, bitcoinAdapter } = getBitcoinTestContext();

    // Step 1: Create a funded authority and deposit BTC to get a balance
    const authority = await createFundedAuthority();
    const depositAmount = 10_000;

    console.log("  📥 Executing synthetic deposit to fund user balance...");
    await executeSyntheticDeposit(depositAmount, authority.publicKey);

    const balanceAfterDeposit = await fetchUserBalance(authority.publicKey);
    expect(balanceAfterDeposit.amount.toNumber()).to.equal(depositAmount);
    console.log(
      `  ✓ User balance after deposit: ${balanceAfterDeposit.amount.toNumber()} sats`
    );

    // Step 2: Build withdrawal plan
    console.log("  📤 Building withdrawal plan...");
    const withdrawalPlan = await buildWithdrawalPlan({
      mode: "live",
      authority,
    });

    const withdrawAmount = withdrawalPlan.amount.toNumber();
    const withdrawFee = withdrawalPlan.fee.toNumber();
    const totalDebit = withdrawAmount + withdrawFee;

    console.log(`  • Withdraw amount: ${withdrawAmount} sats`);
    console.log(`  • Withdraw fee: ${withdrawFee} sats`);
    console.log(`  • Total debit: ${totalDebit} sats`);

    // Step 3: Initiate withdrawal (balance is optimistically deducted)
    const signatureRequestIds = computeSignatureRequestIds(withdrawalPlan);

    console.log("  🔄 Initiating withdrawal (balance will be deducted)...");
    const withdrawTx = await program.methods
      .withdrawBtc(
        planRequestIdBytes(withdrawalPlan),
        withdrawalPlan.btcInputs,
        withdrawalPlan.amount,
        withdrawalPlan.recipient.address,
        withdrawalPlan.txParams
      )
      .accounts({
        authority: authority.publicKey,
        feePayer: provider.wallet.publicKey,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .signers([authority])
      .rpc();
    await provider.connection.confirmTransaction(withdrawTx);

    // Start listeners AFTER the Solana tx so backfill starts from the tx hash
    const events = startBtcEventListeners(
      signatureRequestIds,
      withdrawalPlan.requestIdHex,
      withdrawTx
    );

    // Verify balance was optimistically deducted
    const balanceAfterWithdraw = await fetchUserBalance(authority.publicKey);
    expect(balanceAfterWithdraw.amount.toNumber()).to.equal(
      depositAmount - totalDebit
    );
    console.log(
      `  ✓ Balance after withdraw initiation: ${balanceAfterWithdraw.amount.toNumber()} sats (optimistically deducted)`
    );

    // Step 5: Wait for MPC signatures
    console.log("  ⏳ Waiting for MPC signatures...");
    const signatureMap = await events.waitForSignatureMap();
    console.log(
      `  ✓ Received ${signatureRequestIds.length} signature(s) from MPC`
    );

    // Step 6: Build the withdrawal PSBT but do NOT broadcast it
    const psbt = buildWithdrawalPsbt(withdrawalPlan);

    applySignaturesToPsbt(
      psbt,
      signatureMap,
      signatureRequestIds,
      withdrawalPlan.globalVault.compressedPubkey
    );
    const signedWithdrawTx = psbt.extractTransaction();
    const monitoredTxid = signedWithdrawTx.getId();

    // Step 7: Craft a conflicting spend of the global vault UTXOs
    console.log("  ⚔️ Creating conflicting transaction...");
    const conflictingInput = withdrawalPlan.btcInputs[0];
    const inputValue = bnToBigInt(conflictingInput.value);
    const conflictFee = BigInt(500);
    const conflictOutputValue = inputValue - conflictFee;

    if (conflictOutputValue <= BigInt(0)) {
      throw new Error("Input value too small for conflict spend");
    }

    // Derive the global vault signing key (path = "root")
    const derivedKeyHex = await CryptoUtils.deriveSigningKey(
      CONFIG.BITCOIN_WITHDRAW_PATH, // "root"
      withdrawalPlan.globalVault.pda.toString(),
      CONFIG.MPC_ROOT_PRIVATE_KEY
    );
    const spendingKey = ECPair.fromPrivateKey(
      Buffer.from(derivedKeyHex.slice(2), "hex"),
      { network: bitcoin.networks.regtest }
    );

    // Create external destination for the conflicting tx
    const externalKey = ECPair.makeRandom({
      network: bitcoin.networks.regtest,
    });
    const externalAddress = bitcoin.payments.p2wpkh({
      pubkey: externalKey.publicKey,
      network: bitcoin.networks.regtest,
    }).address;

    if (!externalAddress) {
      throw new Error("Failed to derive external address");
    }

    // Build and sign the conflicting transaction
    const conflictingPsbt = new bitcoin.Psbt({
      network: bitcoin.networks.regtest,
    });
    conflictingPsbt.addInput({
      hash: Buffer.from(conflictingInput.txid).toString("hex"),
      index: conflictingInput.vout,
      witnessUtxo: {
        script: Buffer.from(withdrawalPlan.globalVault.script),
        value: inputValue,
      },
    });
    conflictingPsbt.addOutput({
      address: externalAddress,
      value: conflictOutputValue,
    });
    conflictingPsbt.signInput(0, spendingKey);
    conflictingPsbt.finalizeAllInputs();

    const conflictingTx = conflictingPsbt.extractTransaction();
    const conflictingTxHex = conflictingTx.toHex();
    const conflictingTxid = conflictingTx.getId();

    // Step 8: Broadcast the conflicting tx and mine it
    console.log("  💥 Broadcasting conflicting transaction...");
    await bitcoinAdapter.broadcastTransaction(conflictingTxHex);
    await bitcoinAdapter.mineBlocks?.(1);
    console.log(`  ✓ Conflicting tx mined: ${conflictingTxid}`);

    // Step 9: Wait for error response from fakenet-signer
    console.log("  ⏳ Waiting for error response...");
    const readEvent = await events.readRespond;

    // Verify error response format
    const serializedOutput = Buffer.from(readEvent.serializedOutput);
    expect(serializedOutput.slice(0, 4).toString("hex")).to.equal("deadbeef");
    expect(serializedOutput[4]).to.equal(1);

    console.log("  ✓ Received error response with 0xDEADBEEF prefix");
    console.log("  • monitored txid:", monitoredTxid);
    console.log("  • conflicting txid:", conflictingTxid);

    // Step 10: Call complete_withdraw_btc with the error response
    console.log("  🔄 Calling complete_withdraw_btc with error response...");
    const completeTx = await program.methods
      .completeWithdrawBtc(
        planRequestIdBytes(withdrawalPlan),
        Buffer.from(readEvent.serializedOutput),
        readEvent.signature
      )
      .accounts({
        payer: provider.wallet.publicKey,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }),
      ])
      .rpc();
    await provider.connection.confirmTransaction(completeTx);

    // Step 11: Verify balance was refunded
    const balanceAfterComplete = await fetchUserBalance(authority.publicKey);
    expect(balanceAfterComplete.amount.toNumber()).to.equal(depositAmount);

    console.log(
      `  ✓ Balance after complete: ${balanceAfterComplete.amount.toNumber()} sats`
    );
    console.log(
      `  ✓ Balance correctly refunded: ${
        depositAmount - totalDebit
      } → ${depositAmount} sats`
    );
  });
});
