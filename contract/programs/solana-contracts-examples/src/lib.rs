#![recursion_limit = "512"]
use anchor_lang::prelude::*;

pub mod constants;
pub mod contexts;
pub mod crypto;
pub mod error;
pub mod instructions;
pub mod state;

use ::chain_signatures::Signature;
pub use constants::*;
pub use contexts::*;
pub use state::*;

declare_id!("DLJ41RXS8NE2nLPQWRMZHhjKDgSYgxJxECR1NtQEUkvR");

#[program]
pub mod solana_core_contracts {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        mpc_root_public_key: [u8; 64],
        chain_signatures_program_id: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.mpc_root_public_key = mpc_root_public_key;
        config.chain_signatures_program_id = chain_signatures_program_id;
        Ok(())
    }

    pub fn deposit_erc20(
        ctx: Context<DepositErc20>,
        request_id: [u8; 32],
        requester: Pubkey,
        erc20_address: [u8; 20],
        recipient_address: [u8; 20],
        amount: u128,
        tx_params: EvmTransactionParams,
    ) -> Result<()> {
        instructions::erc20_vault::deposit_erc20(
            ctx,
            request_id,
            requester,
            erc20_address,
            recipient_address,
            amount,
            tx_params,
        )
    }

    pub fn claim_erc20(
        ctx: Context<ClaimErc20>,
        request_id: [u8; 32],
        serialized_output: Vec<u8>,
        signature: Signature,
    ) -> Result<()> {
        instructions::erc20_vault::claim_erc20(ctx, request_id, serialized_output, signature)
    }

    pub fn withdraw_erc20(
        ctx: Context<WithdrawErc20>,
        request_id: [u8; 32],
        erc20_address: [u8; 20],
        amount: u128,
        recipient_address: [u8; 20],
        tx_params: EvmTransactionParams,
    ) -> Result<()> {
        instructions::erc20_vault::withdraw_erc20(
            ctx,
            request_id,
            erc20_address,
            amount,
            recipient_address,
            tx_params,
        )
    }

    pub fn complete_withdraw_erc20(
        ctx: Context<CompleteWithdrawErc20>,
        request_id: [u8; 32],
        serialized_output: Vec<u8>,
        signature: Signature,
    ) -> Result<()> {
        instructions::erc20_vault::complete_withdraw_erc20(
            ctx,
            request_id,
            serialized_output,
            signature,
        )
    }

    pub fn deposit_btc(
        ctx: Context<DepositBtc>,
        request_id: [u8; 32],
        requester: Pubkey,
        inputs: Vec<BtcInput>,
        outputs: Vec<BtcOutput>,
        tx_params: BtcDepositParams,
    ) -> Result<()> {
        instructions::btc_vault::deposit_btc(ctx, request_id, requester, inputs, outputs, tx_params)
    }

    pub fn claim_btc(
        ctx: Context<ClaimBtc>,
        request_id: [u8; 32],
        serialized_output: Vec<u8>,
        signature: Signature,
    ) -> Result<()> {
        instructions::btc_vault::claim_btc(ctx, request_id, serialized_output, signature)
    }

    pub fn withdraw_btc(
        ctx: Context<WithdrawBtc>,
        request_id: [u8; 32],
        inputs: Vec<BtcInput>,
        amount: u64,
        recipient_address: String,
        tx_params: BtcWithdrawParams,
    ) -> Result<()> {
        instructions::btc_vault::withdraw_btc(
            ctx,
            request_id,
            inputs,
            amount,
            recipient_address,
            tx_params,
        )
    }

    pub fn complete_withdraw_btc(
        ctx: Context<CompleteWithdrawBtc>,
        request_id: [u8; 32],
        serialized_output: Vec<u8>,
        signature: Signature,
    ) -> Result<()> {
        instructions::btc_vault::complete_withdraw_btc(
            ctx,
            request_id,
            serialized_output,
            signature,
        )
    }

    pub fn update_config(
        ctx: Context<UpdateVaultConfig>,
        mpc_root_public_key: [u8; 64],
        chain_signatures_program_id: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.mpc_root_public_key = mpc_root_public_key;
        config.chain_signatures_program_id = chain_signatures_program_id;
        Ok(())
    }
}
