use crate::constants::*;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(request_id: [u8; 32], requester: Pubkey, erc20_address: [u8; 20], recipient_address: [u8; 20], amount: u128, tx_params: EvmTransactionParams)]
pub struct DepositErc20<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault_authority", requester.as_ref()],
        bump
    )]
    pub requester_pda: SystemAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + PendingErc20Deposit::INIT_SPACE,
        seeds = [
            b"pending_erc20_deposit",
            request_id.as_ref()
        ],
        bump
    )]
    pub pending_deposit: Account<'info, PendingErc20Deposit>,

    #[account(mut)]
    pub fee_payer: Option<Signer<'info>>,

    /// CHECK: This is the external chain-signatures program. We do not rely on Anchor's `Program<T>` type checks.
    /// Safety is enforced by the constraint:
    /// `chain_signatures_program.key() == config.chain_signatures_program_id`.
    #[account(
        constraint = chain_signatures_program.key() == config.chain_signatures_program_id
            @ crate::error::ErrorCode::InvalidChainSignaturesProgram
    )]
    pub chain_signatures_program: UncheckedAccount<'info>,

    /// CHECK: PDA owned/derived by the chain-signatures program.
    /// Verified by Anchor using `seeds` + `seeds::program = chain_signatures_program.key()`.
    #[account(
        mut,
        seeds = [b"program-state"],
        bump,
        seeds::program = chain_signatures_program.key()
    )]
    pub chain_signatures_state: UncheckedAccount<'info>,

    /// CHECK: Event authority for CPI events, PDA with seed "__event_authority"
    #[account(
        seeds = [b"__event_authority"],
        bump,
        seeds::program = chain_signatures_program.key()
    )]
    pub event_authority: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
    pub instructions: Option<AccountInfo<'info>>,
    #[account(
        seeds = [b"vault_config"],
        bump
    )]
    pub config: Account<'info, VaultConfig>,
}

#[derive(Accounts)]
#[instruction(request_id: [u8; 32])]
pub struct ClaimErc20<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [
            b"pending_erc20_deposit",
            &request_id
        ],
        bump,
        close = payer
    )]
    pub pending_deposit: Account<'info, PendingErc20Deposit>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + UserErc20Balance::INIT_SPACE,
        seeds = [
            b"user_erc20_balance",
            pending_deposit.requester.as_ref(),
            &pending_deposit.erc20_address
        ],
        bump
    )]
    pub user_balance: Account<'info, UserErc20Balance>,

    pub system_program: Program<'info, System>,
    #[account(
        seeds = [b"vault_config"],
        bump
    )]
    pub config: Account<'info, VaultConfig>,
}

#[derive(Accounts)]
#[instruction(request_id: [u8; 32], erc20_address: [u8; 20], amount: u128, recipient_address: [u8; 20], tx_params: EvmTransactionParams)]
pub struct WithdrawErc20<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"global_vault_authority"],
        bump
    )]
    /// CHECK: This is a PDA that will be used as a signer
    pub requester: AccountInfo<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + PendingErc20Withdrawal::INIT_SPACE,
        seeds = [
            b"pending_erc20_withdrawal",
            request_id.as_ref()
        ],
        bump
    )]
    pub pending_withdrawal: Account<'info, PendingErc20Withdrawal>,

    #[account(
        mut,
        seeds = [
            b"user_erc20_balance",
            authority.key().as_ref(),
            &erc20_address
        ],
        bump,
        constraint = user_balance.amount >= amount
    )]
    pub user_balance: Account<'info, UserErc20Balance>,

    #[account(mut)]
    pub fee_payer: Option<Signer<'info>>,

    /// CHECK: Chain signatures state
    #[account(
        mut,
        seeds = [CHAIN_SIGNATURES_STATE_SEED],
        bump,
        seeds::program = chain_signatures_program.key()
    )]
    pub chain_signatures_state: AccountInfo<'info>,

    /// CHECK: Event authority for CPI events, PDA with seed "__event_authority"
    #[account(
        seeds = [b"__event_authority"],
        bump,
        seeds::program = chain_signatures_program.key()
    )]
    pub event_authority: AccountInfo<'info>,

    /// CHECK: This is the external chain-signatures program. We do not rely on Anchor's `Program<T>` type checks.
    /// Safety is enforced by the constraint:
    /// `chain_signatures_program.key() == config.chain_signatures_program_id`.
    #[account(
        constraint = chain_signatures_program.key() == config.chain_signatures_program_id
            @ crate::error::ErrorCode::InvalidChainSignaturesProgram
    )]
    pub chain_signatures_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub instructions: Option<AccountInfo<'info>>,
    #[account(
        seeds = [b"vault_config"],
        bump
    )]
    pub config: Account<'info, VaultConfig>,
}

#[derive(Accounts)]
#[instruction(request_id: [u8; 32])]
pub struct CompleteWithdrawErc20<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [
            b"pending_erc20_withdrawal",
            &request_id
        ],
        bump,
        close = payer
    )]
    pub pending_withdrawal: Account<'info, PendingErc20Withdrawal>,

    #[account(
        mut,
        seeds = [
            b"user_erc20_balance",
            pending_withdrawal.requester.as_ref(),
            &pending_withdrawal.erc20_address
        ],
        bump
    )]
    pub user_balance: Account<'info, UserErc20Balance>,

    pub system_program: Program<'info, System>,
    #[account(
        seeds = [b"vault_config"],
        bump
    )]
    pub config: Account<'info, VaultConfig>,
}
