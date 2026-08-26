use alloy_primitives::{Address, U256};
use alloy_sol_types::SolCall;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;
use anchor_lang::solana_program::secp256k1_recover::secp256k1_recover;
use borsh::BorshDeserialize;
use chain_signatures::cpi::accounts::SignBidirectional;
use chain_signatures::cpi::sign_bidirectional;

use signet_rs::{TransactionBuilder, TxBuilder, EVM};

use crate::contexts::{ClaimErc20, CompleteWithdrawErc20, DepositErc20, WithdrawErc20};
use crate::state::{EvmTransactionParams, IERC20};

const HARDCODED_ROOT_PATH: &str = "root";

pub fn deposit_erc20(
    ctx: Context<DepositErc20>,
    request_id: [u8; 32],
    requester: Pubkey,
    erc20_address: [u8; 20],
    recipient_address: [u8; 20],
    amount: u128,
    tx_params: EvmTransactionParams,
) -> Result<()> {
    let path = requester.to_string();
    // SECURITY: recipient_address should eventually be derived on-chain instead of supplied.
    // Create ERC20 transfer call
    let recipient = Address::from_slice(&recipient_address);
    let call = IERC20::transferCall {
        to: recipient,
        amount: U256::from(amount),
    };

    // Build EVM transaction
    let evm_tx = TransactionBuilder::new::<EVM>()
        .chain_id(tx_params.chain_id)
        .nonce(tx_params.nonce)
        .to(erc20_address)
        .value(tx_params.value)
        .input(call.abi_encode())
        .gas_limit(tx_params.gas_limit)
        .max_fee_per_gas(tx_params.max_fee_per_gas)
        .max_priority_fee_per_gas(tx_params.max_priority_fee_per_gas)
        .build();

    let rlp_encoded_tx = evm_tx.build_for_signing();

    // Generate CAIP-2 ID from chain ID
    let caip2_id = format!("eip155:1");

    // Generate request ID and verify it matches the one passed in
    let computed_request_id = generate_sign_bidirectional_request_id(
        &ctx.accounts.requester_pda.key(),
        &rlp_encoded_tx,
        &caip2_id,
        1, // key_version
        &path,
        "ECDSA",
        "ethereum",
        "",
    );

    require!(
        computed_request_id == request_id,
        crate::error::ErrorCode::InvalidRequestId
    );

    // Store pending deposit info
    let pending = &mut ctx.accounts.pending_deposit;
    pending.requester = requester;
    pending.amount = amount;
    pending.erc20_address = erc20_address;
    pending.path = path.clone();
    pending.request_id = request_id;

    // Create schema for ERC20 transfer return value from alloy-sol-types
    let functions = IERC20::abi::functions();
    let transfer_func = functions
        .get("transfer")
        .and_then(|funcs| funcs.first())
        .ok_or(crate::error::ErrorCode::FunctionNotFound)?;

    let explorer_schema = serde_json::to_vec(&transfer_func.outputs)
        .map_err(|_| crate::error::ErrorCode::SerializationError)?;

    let callback_schema = serde_json::to_vec(&serde_json::json!("bool"))
        .map_err(|_| crate::error::ErrorCode::SerializationError)?;

    // CPI to sign_respond
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

    sign_bidirectional(
        cpi_ctx,
        rlp_encoded_tx,
        caip2_id,
        1, // key_version
        path,
        "ECDSA".to_string(),
        "ethereum".to_string(),
        "".to_string(),
        crate::ID,
        explorer_schema,
        callback_schema,
    )?;

    msg!("ERC20 deposit initiated with request_id: {:?}", request_id);

    Ok(())
}

pub fn claim_erc20(
    ctx: Context<ClaimErc20>,
    request_id: [u8; 32],
    serialized_output: Vec<u8>,
    signature: chain_signatures::Signature,
) -> Result<()> {
    let pending = &ctx.accounts.pending_deposit;
    let config = &ctx.accounts.config;

    // Derive the expected address on-chain from MPC root public key + user's derivation path
    let expected_address_bytes = crate::crypto::derive_deposit_expected_address(
        &config.mpc_root_public_key,
        &pending.requester,
    )?;

    // Verify signature
    let message_hash = hash_message(&request_id, &serialized_output);

    // Verify the signature
    let expected_address = format!("0x{}", hex::encode(expected_address_bytes));
    verify_signature_from_address(&message_hash, &signature, &expected_address)?;

    // Deserialize directly as bool (server now sends just the boolean)
    let success: bool = BorshDeserialize::try_from_slice(&serialized_output)
        .map_err(|_| crate::error::ErrorCode::InvalidOutput)?;

    require!(success, crate::error::ErrorCode::TransferFailed);

    // Update user balance
    let balance = &mut ctx.accounts.user_balance;
    balance.amount = balance
        .amount
        .checked_add(pending.amount)
        .ok_or(crate::error::ErrorCode::Overflow)?;

    msg!("ERC20 deposit claimed successfully");

    Ok(())
}

pub fn withdraw_erc20(
    ctx: Context<WithdrawErc20>,
    request_id: [u8; 32],
    erc20_address: [u8; 20],
    amount: u128,
    recipient_address: [u8; 20],
    tx_params: EvmTransactionParams,
) -> Result<()> {
    let authority = ctx.accounts.authority.key();

    // Use the hardcoded root path for withdrawals
    let path = HARDCODED_ROOT_PATH.to_string();

    // Check user has sufficient balance
    let balance = &mut ctx.accounts.user_balance;
    require!(
        balance.amount >= amount,
        crate::error::ErrorCode::InsufficientBalance
    );

    // Optimistically decrement the balance
    balance.amount = balance
        .amount
        .checked_sub(amount)
        .ok_or(crate::error::ErrorCode::Underflow)?;

    // Create ERC20 transfer call
    let recipient = Address::from_slice(&recipient_address);
    let call = IERC20::transferCall {
        to: recipient,
        amount: U256::from(amount),
    };

    // Build EVM transaction - note: this is FROM the hardcoded recipient address
    let evm_tx = TransactionBuilder::new::<EVM>()
        .chain_id(tx_params.chain_id)
        .nonce(tx_params.nonce)
        .to(erc20_address)
        .value(tx_params.value)
        .input(call.abi_encode())
        .gas_limit(tx_params.gas_limit)
        .max_fee_per_gas(tx_params.max_fee_per_gas)
        .max_priority_fee_per_gas(tx_params.max_priority_fee_per_gas)
        .build();

    let rlp_encoded_tx = evm_tx.build_for_signing();

    // Generate CAIP-2 ID from chain ID
    let caip2_id = format!("eip155:1");

    // Generate request ID
    let computed_request_id = generate_sign_bidirectional_request_id(
        &ctx.accounts.requester.key(),
        &rlp_encoded_tx,
        &caip2_id,
        1, // key_version
        &path,
        "ECDSA",
        "ethereum",
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
    pending.erc20_address = erc20_address;
    pending.recipient_address = recipient_address;
    pending.path = path.clone();
    pending.request_id = request_id;

    // Create schema for ERC20 transfer return value
    let functions = IERC20::abi::functions();
    let transfer_func = functions
        .get("transfer")
        .and_then(|funcs| funcs.first())
        .ok_or(crate::error::ErrorCode::FunctionNotFound)?;

    let explorer_schema = serde_json::to_vec(&transfer_func.outputs)
        .map_err(|_| crate::error::ErrorCode::SerializationError)?;

    let callback_schema = serde_json::to_vec(&serde_json::json!("bool"))
        .map_err(|_| crate::error::ErrorCode::SerializationError)?;

    // CPI to sign_respond
    let requester_bump = ctx.bumps.requester;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"global_vault_authority", // Just this seed
        &[requester_bump],
    ]];

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

    sign_bidirectional(
        cpi_ctx,
        rlp_encoded_tx,
        caip2_id,
        1, // key_version
        path,
        "ECDSA".to_string(),
        "ethereum".to_string(),
        "".to_string(),
        crate::ID,
        explorer_schema,
        callback_schema,
    )?;

    msg!(
        "ERC20 withdrawal initiated with request_id: {:?}",
        request_id
    );

    Ok(())
}

pub fn complete_withdraw_erc20(
    ctx: Context<CompleteWithdrawErc20>,
    request_id: [u8; 32],
    serialized_output: Vec<u8>,
    signature: chain_signatures::Signature,
) -> Result<()> {
    let pending = &ctx.accounts.pending_withdrawal;
    let config = &ctx.accounts.config;

    // Derive the expected address on-chain from MPC root public key + "root" path
    // For withdrawals, the signer is always the global vault address
    let expected_address_bytes =
        crate::crypto::derive_withdrawal_expected_address(&config.mpc_root_public_key)?;

    let message_hash = hash_message(&request_id, &serialized_output);
    // Verify the signature
    let expected_address = format!("0x{}", hex::encode(expected_address_bytes));

    verify_signature_from_address(&message_hash, &signature, &expected_address)?;

    msg!("Signature verified successfully");

    // Check for error magic prefix
    const ERROR_PREFIX: [u8; 4] = [0xDE, 0xAD, 0xBE, 0xEF];

    let should_refund = if serialized_output.len() >= 4 && serialized_output[..4] == ERROR_PREFIX {
        msg!("Detected error response (magic prefix)");
        true // Always refund on error
    } else {
        // Normal response - deserialize as boolean
        let success: bool = BorshDeserialize::try_from_slice(&serialized_output)
            .map_err(|_| crate::error::ErrorCode::InvalidOutput)?;

        if !success {
            msg!("Transfer returned false");
            true // Refund if transfer returned false
        } else {
            msg!("Transfer returned true");
            false // Don't refund
        }
    };

    if should_refund {
        // Refund the balance
        let balance = &mut ctx.accounts.user_balance;
        balance.amount = balance
            .amount
            .checked_add(pending.amount)
            .ok_or(crate::error::ErrorCode::Overflow)?;

        msg!("Balance refunded: {}", pending.amount);
    }

    msg!("ERC20 withdrawal process completed");

    Ok(())
}

// Add this helper function to verify signature by recovering address
fn verify_signature_from_address(
    message_hash: &[u8; 32],
    signature: &chain_signatures::Signature,
    expected_address: &str,
) -> Result<()> {
    // Validate recovery ID
    require!(
        signature.recovery_id < 4,
        crate::error::ErrorCode::InvalidSignature
    );

    // Prepare signature for secp256k1_recover
    let mut sig_bytes = [0u8; 64];
    sig_bytes[..32].copy_from_slice(&signature.big_r.x);
    sig_bytes[32..].copy_from_slice(&signature.s);

    // Recover the public key
    let recovered_pubkey = secp256k1_recover(message_hash, signature.recovery_id, &sig_bytes)
        .map_err(|_| crate::error::ErrorCode::InvalidSignature)?;

    // Convert public key to Ethereum address
    // The recovered key is 64 bytes (without the 0x04 prefix)
    let pubkey_bytes = recovered_pubkey.to_bytes();

    // Hash the public key to get address
    let pubkey_hash = keccak::hash(&pubkey_bytes);
    let address_bytes = &pubkey_hash.to_bytes()[12..]; // Last 20 bytes

    // Convert to hex string for comparison
    let recovered_address = format!("0x{}", hex::encode(address_bytes));

    // Compare addresses (case-insensitive)
    require!(
        recovered_address.to_lowercase() == expected_address.to_lowercase(),
        crate::error::ErrorCode::InvalidSignature
    );

    Ok(())
}

// Helper functions

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
