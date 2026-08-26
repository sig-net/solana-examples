use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct VaultConfig {
    /// The full 64-byte uncompressed secp256k1 public key (without 0x04 prefix)
    pub mpc_root_public_key: [u8; 64],
    pub chain_signatures_program_id: Pubkey,
}
