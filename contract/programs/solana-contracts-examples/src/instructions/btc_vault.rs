use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;
use anchor_lang::solana_program::secp256k1_recover::secp256k1_recover;
use borsh::BorshDeserialize;
use chain_signatures::cpi::accounts::SignBidirectional;
use chain_signatures::cpi::sign_bidirectional;

use signet_rs::bitcoin::psbt::Psbt;
use signet_rs::bitcoin::types::*;
use signet_rs::{TransactionBuilder, TxBuilder, BITCOIN};

use crate::contexts::{ClaimBtc, CompleteWithdrawBtc, DepositBtc, WithdrawBtc};
use crate::state::{BtcDepositParams, BtcInput, BtcOutput, BtcWithdrawParams};

pub fn deposit_btc(
    ctx: Context<DepositBtc>,
    request_id: [u8; 32],
    requester: Pubkey,
    inputs: Vec<BtcInput>,
    outputs: Vec<BtcOutput>,
    tx_params: BtcDepositParams,
) -> Result<()> {
    let path = crate::constants::deposit_path(&requester);
    // SECURITY: caller-provided outputs can redirect funds; the vault output should be hardcoded
    // (e.g., to a program-derived script) so deposits always land in the contract-controlled vault.
    let BtcDepositParams {
        lock_time,
        caip2_id,
        vault_script_pubkey,
    } = tx_params;

    // Build Bitcoin transaction inputs
    let mut btc_inputs = Vec::new();
    let mut total_input_value = 0u64;

    for input in &inputs {
        let txid = Txid(Hash(input.txid));

        let txin = TxIn {
            previous_output: OutPoint::new(txid, input.vout),
            script_sig: ScriptBuf::default(),
            sequence: Sequence::MAX,
            witness: Witness::default(),
        };

        btc_inputs.push(txin);
        total_input_value = total_input_value
            .checked_add(input.value)
            .ok_or(crate::error::ErrorCode::Overflow)?;
    }

    // Build Bitcoin transaction outputs
    let mut btc_outputs = Vec::new();
    let mut total_output_value = 0u64;
    let mut vault_output_value = 0u64;

    for output in &outputs {
        let script_pubkey = ScriptBuf::from_bytes(output.script_pubkey.clone());

        let txout = TxOut {
            value: Amount::from_sat(output.value),
            script_pubkey,
        };

        btc_outputs.push(txout);
        total_output_value = total_output_value
            .checked_add(output.value)
            .ok_or(crate::error::ErrorCode::Overflow)?;

        if output.script_pubkey.as_slice() == vault_script_pubkey.as_slice() {
            vault_output_value = vault_output_value
                .checked_add(output.value)
                .ok_or(crate::error::ErrorCode::Overflow)?;
        }
    }

    // Build unsigned Bitcoin transaction (SegWit - Version::Two)
    let lock_time =
        LockTime::from_height(lock_time).map_err(|_| crate::error::ErrorCode::InvalidAddress)?;

    let tx = TransactionBuilder::new::<BITCOIN>()
        .version(Version::Two)
        .inputs(btc_inputs)
        .outputs(btc_outputs)
        .lock_time(lock_time)
        .build();

    // Get the TXID in explorer order for deterministic request IDs
    let mut txid_explorer_reversed_bytes = tx.compute_txid().as_byte_array();
    txid_explorer_reversed_bytes.reverse(); // Revert to get explorer format

    // Generate PSBT for MPC signing (includes metadata for signing)
    let mut psbt = Psbt::from_unsigned_tx(tx);

    // Add witnessUtxo for each input (required for SegWit P2WPKH signing)
    for (i, input) in inputs.iter().enumerate() {
        psbt.update_input_with_witness_utxo(i, input.script_pubkey.clone(), input.value)
            .map_err(|_| crate::error::ErrorCode::SerializationError)?;
    }

    let psbt_bytes = psbt
        .serialize()
        .map_err(|_| crate::error::ErrorCode::SerializationError)?;

    // Generate request ID using TXID (deterministic!)
    let computed_request_id = generate_sign_bidirectional_request_id(
        &ctx.accounts.requester_pda.key(),
        &txid_explorer_reversed_bytes,
        &caip2_id,
        1,
        &path,
        "ECDSA",
        "",
        "",
    );

    require!(
        computed_request_id == request_id,
        crate::error::ErrorCode::InvalidRequestId
    );

    require!(
        vault_output_value > 0,
        crate::error::ErrorCode::VaultOutputNotFound
    );

    // Store pending deposit info
    let pending = &mut ctx.accounts.pending_deposit;
    pending.requester = requester;
    pending.amount = vault_output_value;
    pending.path = path.clone();
    pending.request_id = request_id;

    // Create callback schema for boolean result
    let callback_schema = serde_json::to_vec(&serde_json::json!("bool"))
        .map_err(|_| crate::error::ErrorCode::SerializationError)?;

    let explorer_schema = callback_schema.clone();

    // CPI to sign_bidirectional
    let requester_key_bytes = requester.to_bytes();
    let requester_bump = ctx.bumps.requester_pda;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"vault_authority",
        requester_key_bytes.as_ref(),
        &[requester_bump],
    ]];

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.chain_signatures_program.to_account_info(),
        SignBidirectional {
            program_state: ctx.accounts.chain_signatures_state.to_account_info(),
            requester: ctx.accounts.requester_pda.to_account_info(),
            fee_payer: ctx
                .accounts
                .fee_payer
                .as_ref()
                .map(|fp| fp.to_account_info()),
            system_program: ctx.accounts.system_program.to_account_info(),
            instructions: ctx
                .accounts
                .instructions
                .as_ref()
                .map(|i| i.to_account_info()),
            event_authority: ctx.accounts.event_authority.to_account_info(),
            program: ctx.accounts.chain_signatures_program.to_account_info(),
        },
        signer_seeds,
    );

    // Send PSBT to Chain Signatures for signing (needs metadata!)
    sign_bidirectional(
        cpi_ctx,
        psbt_bytes,
        caip2_id,
        1,
        path,
        "ECDSA".to_string(),
        "".to_string(),
        "".to_string(),
        crate::ID,
        explorer_schema,
        callback_schema,
    )?;

    msg!("BTC deposit initiated with request_id: {:?}", request_id);

    Ok(())
}

pub fn claim_btc(
    ctx: Context<ClaimBtc>,
    request_id: [u8; 32],
    serialized_output: Vec<u8>,
    signature: chain_signatures::Signature,
) -> Result<()> {
    let pending = &ctx.accounts.pending_deposit;
    let config = &ctx.accounts.config;

    // Derive the expected address on-chain from MPC root public key + user's derivation path
    // Formula: childPubKey = basePubKey + (epsilon × G), where epsilon = keccak256(derivation_path)
    let expected_address_bytes = crate::crypto::derive_deposit_expected_address(
        &config.mpc_root_public_key,
        &pending.requester,
    )?;

    // Verify signature against the derived expected address
    let message_hash = hash_message(&request_id, &serialized_output);
    let expected_address_str = format!("0x{}", hex::encode(expected_address_bytes));
    verify_signature_from_address(&message_hash, &signature, &expected_address_str)?;

    // Deserialize result as boolean
    let success: bool = BorshDeserialize::try_from_slice(&serialized_output)
        .map_err(|_| crate::error::ErrorCode::InvalidOutput)?;

    require!(success, crate::error::ErrorCode::TransferFailed);

    // Update user balance
    let balance = &mut ctx.accounts.user_balance;
    balance.amount = balance
        .amount
        .checked_add(pending.amount)
        .ok_or(crate::error::ErrorCode::Overflow)?;

    msg!("BTC deposit claimed successfully");

    Ok(())
}

pub fn withdraw_btc(
    ctx: Context<WithdrawBtc>,
    request_id: [u8; 32],
    inputs: Vec<BtcInput>,
    amount: u64,
    recipient_address: String,
    tx_params: BtcWithdrawParams,
) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    let path = crate::constants::ROOT_PATH.to_string();
    let BtcWithdrawParams {
        lock_time,
        caip2_id,
        vault_script_pubkey,
        recipient_script_pubkey,
        fee,
    } = tx_params;

    let total_debit = amount
        .checked_add(fee)
        .ok_or(crate::error::ErrorCode::Overflow)?;

    // Check user has sufficient balance
    let balance = &mut ctx.accounts.user_balance;
    require!(
        balance.amount >= total_debit,
        crate::error::ErrorCode::InsufficientBalance
    );

    // Optimistically decrement the balance
    balance.amount = balance
        .amount
        .checked_sub(total_debit)
        .ok_or(crate::error::ErrorCode::Underflow)?;

    // Build Bitcoin transaction inputs
    let mut btc_inputs = Vec::new();
    let mut total_input_value = 0u64;
    for input in &inputs {
        let txid = Txid(Hash(input.txid));

        let txin = TxIn {
            previous_output: OutPoint::new(txid, input.vout),
            script_sig: ScriptBuf::default(),
            sequence: Sequence::MAX,
            witness: Witness::default(),
        };

        btc_inputs.push(txin);

        total_input_value = total_input_value
            .checked_add(input.value)
            .ok_or(crate::error::ErrorCode::Overflow)?;
    }

    require!(
        total_input_value >= total_debit,
        crate::error::ErrorCode::InsufficientInputs
    );

    let recipient_script = ScriptBuf::from_bytes(recipient_script_pubkey.clone());
    let vault_script = ScriptBuf::from_bytes(vault_script_pubkey.clone());

    let change_output_value = total_input_value
        .checked_sub(total_debit)
        .ok_or(crate::error::ErrorCode::Underflow)?;

    // SECURITY: vault change is caller-supplied; the vault/change script should be hardcoded
    // by the program to avoid malicious change addresses siphoning funds.
    let mut btc_outputs = Vec::new();
    btc_outputs.push(TxOut {
        value: Amount::from_sat(amount),
        script_pubkey: recipient_script,
    });

    if change_output_value > 0 {
        btc_outputs.push(TxOut {
            value: Amount::from_sat(change_output_value),
            script_pubkey: vault_script.clone(),
        });
    }

    let _total_output_value = amount
        .checked_add(change_output_value)
        .ok_or(crate::error::ErrorCode::Overflow)?;

    // Change is derived deterministically, so no extra validation required beyond initial checks.

    // Build unsigned Bitcoin transaction (SegWit - Version::Two)
    let lock_time =
        LockTime::from_height(lock_time).map_err(|_| crate::error::ErrorCode::InvalidAddress)?;

    let tx = TransactionBuilder::new::<BITCOIN>()
        .version(Version::Two)
        .inputs(btc_inputs)
        .outputs(btc_outputs)
        .lock_time(lock_time)
        .build();

    // Get the TXID in explorer order for deterministic request IDs
    let mut txid_explorer_reversed_bytes = tx.compute_txid().as_byte_array();
    txid_explorer_reversed_bytes.reverse(); // Revert to get explorer format

    // Generate PSBT for MPC signing (includes metadata for signing)
    let mut psbt = Psbt::from_unsigned_tx(tx);

    // Add witnessUtxo for each input (required for SegWit P2WPKH signing)
    for (i, input) in inputs.iter().enumerate() {
        psbt.update_input_with_witness_utxo(i, input.script_pubkey.clone(), input.value)
            .map_err(|_| crate::error::ErrorCode::SerializationError)?;
    }

    let psbt_bytes = psbt
        .serialize()
        .map_err(|_| crate::error::ErrorCode::SerializationError)?;

    // Generate request ID using TXID (deterministic!)
    let computed_request_id = generate_sign_bidirectional_request_id(
        &ctx.accounts.requester.key(),
        &txid_explorer_reversed_bytes,
        &caip2_id,
        1,
        &path,
        "ECDSA",
        "",
        "",
    );

    require!(
        computed_request_id == request_id,
        crate::error::ErrorCode::InvalidRequestId
    );

    // Store pending withdrawal info
    let pending = &mut ctx.accounts.pending_withdrawal;
    pending.requester = authority;
    pending.amount = amount;
    pending.fee = fee;
    pending.recipient_address = recipient_address;
    pending.path = path.clone();
    pending.request_id = request_id;

    // Create callback schema
    let callback_schema = serde_json::to_vec(&serde_json::json!("bool"))
        .map_err(|_| crate::error::ErrorCode::SerializationError)?;

    let explorer_schema = callback_schema.clone();

    // CPI to sign_bidirectional
    let requester_bump = ctx.bumps.requester;
    let signer_seeds: &[&[&[u8]]] = &[&[b"global_vault_authority", &[requester_bump]]];

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.chain_signatures_program.to_account_info(),
        SignBidirectional {
            program_state: ctx.accounts.chain_signatures_state.to_account_info(),
            requester: ctx.accounts.requester.to_account_info(),
            fee_payer: ctx
                .accounts
                .fee_payer
                .as_ref()
                .map(|fp| fp.to_account_info()),
            system_program: ctx.accounts.system_program.to_account_info(),
            instructions: ctx
                .accounts
                .instructions
                .as_ref()
                .map(|i| i.to_account_info()),
            event_authority: ctx.accounts.event_authority.to_account_info(),
            program: ctx.accounts.chain_signatures_program.to_account_info(),
        },
        signer_seeds,
    );

    // Send PSBT to Chain Signatures for signing (needs metadata!)
    sign_bidirectional(
        cpi_ctx,
        psbt_bytes,
        caip2_id.clone(),
        1,
        path,
        "ECDSA".to_string(),
        "".to_string(),
        "".to_string(),
        crate::ID,
        explorer_schema,
        callback_schema,
    )?;

    msg!("BTC withdrawal initiated with request_id: {:?}", request_id);

    Ok(())
}

pub fn complete_withdraw_btc(
    ctx: Context<CompleteWithdrawBtc>,
    request_id: [u8; 32],
    serialized_output: Vec<u8>,
    signature: chain_signatures::Signature,
) -> Result<()> {
    let pending = &ctx.accounts.pending_withdrawal;
    let config = &ctx.accounts.config;

    // Derive the expected response signer on-chain from the MPC root public key
    // For withdrawals, the signer is always the global vault address
    let expected_address_bytes = crate::crypto::derive_withdrawal_expected_address(
        &config.mpc_root_public_key,
    )?;

    // Verify signature against the derived expected address
    let message_hash = hash_message(&request_id, &serialized_output);
    let expected_address_str = format!("0x{}", hex::encode(expected_address_bytes));
    verify_signature_from_address(&message_hash, &signature, &expected_address_str)?;

    msg!("Signature verified successfully");

    // Check for error magic prefix
    const ERROR_PREFIX: [u8; 4] = [0xDE, 0xAD, 0xBE, 0xEF];

    let should_refund = if serialized_output.len() >= 4 && serialized_output[..4] == ERROR_PREFIX {
        msg!("Detected error response (magic prefix)");
        true
    } else {
        let success: bool = BorshDeserialize::try_from_slice(&serialized_output)
            .map_err(|_| crate::error::ErrorCode::InvalidOutput)?;

        if !success {
            msg!("Transfer returned false");
            true
        } else {
            msg!("Transfer returned true");
            false
        }
    };

    if should_refund {
        // Refund the balance
        let balance = &mut ctx.accounts.user_balance;
        let refund_total = pending
            .amount
            .checked_add(pending.fee)
            .ok_or(crate::error::ErrorCode::Overflow)?;
        balance.amount = balance
            .amount
            .checked_add(refund_total)
            .ok_or(crate::error::ErrorCode::Overflow)?;

        msg!("Balance refunded: {} sats (amount + fee)", refund_total);
    }

    msg!("BTC withdrawal process completed");

    Ok(())
}

fn verify_signature_from_address(
    message_hash: &[u8; 32],
    signature: &chain_signatures::Signature,
    expected_address: &str,
) -> Result<()> {
    require!(
        signature.recovery_id < 4,
        crate::error::ErrorCode::InvalidSignature
    );

    let mut sig_bytes = [0u8; 64];
    sig_bytes[..32].copy_from_slice(&signature.big_r.x);
    sig_bytes[32..].copy_from_slice(&signature.s);

    let recovered_pubkey = secp256k1_recover(message_hash, signature.recovery_id, &sig_bytes)
        .map_err(|_| crate::error::ErrorCode::InvalidSignature)?;

    let pubkey_bytes = recovered_pubkey.to_bytes();
    let pubkey_hash = keccak::hash(&pubkey_bytes);
    let address_bytes = &pubkey_hash.to_bytes()[12..];

    let recovered_address = format!("0x{}", hex::encode(address_bytes));

    require!(
        recovered_address.to_lowercase() == expected_address.to_lowercase(),
        crate::error::ErrorCode::InvalidSignature
    );

    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn generate_sign_bidirectional_request_id(
    sender: &Pubkey,
    transaction_data: &[u8],
    caip2_id: &str,
    key_version: u32,
    path: &str,
    algo: &str,
    dest: &str,
    params: &str,
) -> [u8; 32] {
    use alloy_sol_types::SolValue;

    let encoded = (
        sender.to_string(),
        transaction_data,
        caip2_id,
        key_version,
        path,
        algo,
        dest,
        params,
    )
        .abi_encode_packed();

    keccak::hash(&encoded).to_bytes()
}

fn hash_message(request_id: &[u8; 32], serialized_output: &[u8]) -> [u8; 32] {
    let mut data = Vec::with_capacity(32 + serialized_output.len());
    data.extend_from_slice(request_id);
    data.extend_from_slice(serialized_output);

    keccak::hash(&data).to_bytes()
}
