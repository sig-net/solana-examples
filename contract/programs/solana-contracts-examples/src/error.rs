use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Serialization error")]
    SerializationError,
    #[msg("Function not found in ABI")]
    FunctionNotFound,
    #[msg("Invalid request ID")]
    InvalidRequestId,
    #[msg("Invalid signature")]
    InvalidSignature,
    #[msg("Transfer failed")]
    TransferFailed,
    #[msg("Invalid output format")]
    InvalidOutput,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Invalid address")]
    InvalidAddress,
    #[msg("Insufficient balance")]
    InsufficientBalance,
    #[msg("Underflow error")]
    Underflow,
    #[msg("No vault outputs found in transaction")]
    VaultOutputNotFound,
    #[msg("Provided inputs do not cover requested amount + fee")]
    InsufficientInputs,
    #[msg("Invalid chain signatures program id")]
    InvalidChainSignaturesProgram,
}
