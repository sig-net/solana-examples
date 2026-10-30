use anchor_lang::prelude::Pubkey;

// Chain signatures program state seeds
pub const CHAIN_SIGNATURES_STATE_SEED: &[u8] = b"program-state";

/// SigNet reserves this prefix for bidirectional request paths on Solana, so
/// that no plain sign request can derive a vault key and use up a request's nonce.
pub const BIDIRECTIONAL_PATH_PREFIX: &str = "bidirectional/";

/// Path of the treasury key, which withdrawals sign under.
pub const ROOT_PATH: &str = "bidirectional/root";

/// Path of a user's deposit key.
pub fn deposit_path(requester: &Pubkey) -> String {
    format!("{BIDIRECTIONAL_PATH_PREFIX}{requester}")
}
