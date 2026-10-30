//! On-chain Ethereum address derivation using secp256k1.
//!
//! This module derives Ethereum addresses from MPC public keys using the same
//! derivation scheme as signet.js (sig-net's TypeScript SDK).
//!
//! # Derivation Formula
//!
//! The child public key is derived as:
//! ```text
//! derivationPath = "sig.network v2.0.0 epsilon derivation:{chainId}:{predecessorId}:{path}"
//! epsilon = keccak256(derivationPath)
//! childPublicKey = parentPublicKey + (epsilon × G)
//! ethereumAddress = keccak256(childPublicKey)[12..32]
//! ```
//!
//! # ECMul Trick (secp256k1_recover abuse)
//!
//! We use Solana's `secp256k1_recover` syscall to perform scalar multiplication
//! efficiently (~100 CUs) instead of doing it in pure code (~5M CUs).
//!
//! The ecrecover formula is:
//! ```text
//! Q = r⁻¹ × (s × R - z × G)
//! ```
//!
//! By setting:
//! - z = 0 (message hash = 0) → eliminates the z×G term
//! - r = R.x (x-coordinate of point R)
//! - s = r × k (where k is our scalar)
//!
//! The formula simplifies to:
//! ```text
//! Q = r⁻¹ × (r × k × R) = k × R
//! ```
//!
//! References:
//! - https://ethresear.ch/t/you-can-kinda-abuse-ecrecover-to-do-ecmul-in-secp256k1-today/2384

use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;
use anchor_lang::solana_program::secp256k1_recover::secp256k1_recover;
use libsecp256k1::curve::{Affine, Field, Jacobian, Scalar, AFFINE_G};

/// Chain ID for Solana (CAIP-2 format)
const SOLANA_CAIP2_ID: &str = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/// Path used for respond bidirectional signatures (must match fakenet-signer's CONFIG.SOLANA_RESPOND_BIDIRECTIONAL_PATH)
const RESPOND_BIDIRECTIONAL_PATH: &str = "solana response key";

/// Derives the epsilon scalar from the derivation path.
///
/// Formula: epsilon = keccak256("sig.network v2.0.0 epsilon derivation:{chainId}:{predecessorId}:{path}")
fn derive_epsilon(predecessor_id: &str, path: &str) -> [u8; 32] {
    let derivation_path = format!(
        "sig.network v2.0.0 epsilon derivation:{}:{}:{}",
        SOLANA_CAIP2_ID, predecessor_id, path
    );
    keccak::hash(derivation_path.as_bytes()).to_bytes()
}

/// Computes scalar × G (generator point multiplication) using secp256k1_recover.
///
/// This abuses the ecrecover formula by:
/// - Setting message hash (z) = 0
/// - Setting r = G.x (generator x-coordinate)
/// - Setting s = r × scalar (mod n)
///
/// Result: Q = scalar × G
fn scalar_mul_generator(scalar_bytes: &[u8; 32]) -> Result<Affine> {
    // Get generator point coordinates from libsecp256k1
    let g = AFFINE_G;
    let mut gx_bytes = [0u8; 32];
    g.x.fill_b32(&mut gx_bytes);
    let gy_bytes = {
        let mut buf = [0u8; 32];
        g.y.fill_b32(&mut buf);
        buf
    };

    // Convert scalar and r to libsecp256k1 Scalar type for modular arithmetic
    let mut scalar = Scalar::default();
    let _ = scalar.set_b32(scalar_bytes);

    let mut r_scalar = Scalar::default();
    let _ = r_scalar.set_b32(&gx_bytes);

    // s = r × scalar (mod n) using libsecp256k1's Scalar multiplication
    let s_scalar = r_scalar * scalar;
    let mut s_bytes = [0u8; 32];
    s_scalar.fill_b32(&mut s_bytes);

    // Construct signature: [r (32 bytes) | s (32 bytes)]
    let mut signature = [0u8; 64];
    signature[..32].copy_from_slice(&gx_bytes);
    signature[32..].copy_from_slice(&s_bytes);

    // Message hash = 0 (this eliminates the z×G term)
    let zero_hash = [0u8; 32];

    // recovery_id based on G.y parity (G.y is even, so recovery_id = 0)
    let recovery_id = if gy_bytes[31] & 1 == 0 { 0 } else { 1 };

    // Call secp256k1_recover syscall
    let recovered = secp256k1_recover(&zero_hash, recovery_id, &signature)
        .map_err(|_| error!(crate::error::ErrorCode::InvalidSignature))?;

    let pubkey_bytes = recovered.to_bytes();

    // Convert to libsecp256k1 Affine point
    let mut x = Field::default();
    let mut y = Field::default();
    let _ = x.set_b32(&pubkey_bytes[..32].try_into().unwrap());
    let _ = y.set_b32(&pubkey_bytes[32..].try_into().unwrap());

    let mut result = Affine::default();
    result.set_xy(&x, &y);

    Ok(result)
}

/// Adds two elliptic curve points P1 + P2 using libsecp256k1.
fn point_add(p1: &Affine, p2: &Affine) -> Affine {
    // Convert first point to Jacobian for addition
    let mut j1 = Jacobian::default();
    j1.set_ge(p1);

    // Add the second point (Affine)
    j1 = j1.add_ge(p2);

    // Convert back to Affine
    let mut result = Affine::default();
    result.set_gej(&j1);
    result
}

/// Derives the Ethereum address from the MPC root public key and derivation parameters.
///
/// # Arguments
/// * `mpc_root_public_key` - The 64-byte uncompressed secp256k1 public key (without 0x04 prefix)
/// * `predecessor_id` - The vault authority PDA as a string
/// * `path` - The derivation path
///
/// # Returns
/// The 20-byte Ethereum address
pub fn derive_ethereum_address(
    mpc_root_public_key: &[u8; 64],
    predecessor_id: &str,
    path: &str,
) -> Result<[u8; 20]> {
    // Step 1: Compute epsilon = keccak256(derivation_path)
    let epsilon = derive_epsilon(predecessor_id, path);

    // Step 2: Compute epsilon × G using the secp256k1_recover trick
    let epsilon_g = scalar_mul_generator(&epsilon)?;

    // Step 3: Create base public key as Affine point
    let mut base_x = Field::default();
    let mut base_y = Field::default();
    let _ = base_x.set_b32(&mpc_root_public_key[..32].try_into().unwrap());
    let _ = base_y.set_b32(&mpc_root_public_key[32..].try_into().unwrap());

    let mut base_point = Affine::default();
    base_point.set_xy(&base_x, &base_y);

    // Step 4: Compute childPublicKey = basePublicKey + (epsilon × G)
    let child_point = point_add(&base_point, &epsilon_g);

    // Step 5: Compute Ethereum address = keccak256(childPublicKey)[12..32]
    let mut x_bytes = [0u8; 32];
    let mut y_bytes = [0u8; 32];
    child_point.x.fill_b32(&mut x_bytes);
    child_point.y.fill_b32(&mut y_bytes);

    let mut pubkey_bytes = [0u8; 64];
    pubkey_bytes[..32].copy_from_slice(&x_bytes);
    pubkey_bytes[32..].copy_from_slice(&y_bytes);

    let pubkey_hash = keccak::hash(&pubkey_bytes).to_bytes();

    let mut address = [0u8; 20];
    address.copy_from_slice(&pubkey_hash[12..32]);

    Ok(address)
}

/// Derives the expected Ethereum address for a deposit claim (respond bidirectional).
///
/// For deposits, the respond bidirectional signer is derived from the user's vault authority PDA
/// using the RESPOND_BIDIRECTIONAL_PATH.
pub fn derive_deposit_expected_address(
    mpc_root_public_key: &[u8; 64],
    user_pubkey: &Pubkey,
) -> Result<[u8; 20]> {
    // Derive the vault authority PDA for this user
    let (vault_authority, _bump) =
        Pubkey::find_program_address(&[b"vault_authority", user_pubkey.as_ref()], &crate::ID);

    let predecessor_id = vault_authority.to_string();

    derive_ethereum_address(mpc_root_public_key, &predecessor_id, RESPOND_BIDIRECTIONAL_PATH)
}

/// Derives the expected Ethereum address for a withdrawal completion (respond bidirectional).
///
/// For withdrawals, the respond bidirectional signer is derived from the global vault authority PDA
/// using the RESPOND_BIDIRECTIONAL_PATH.
pub fn derive_withdrawal_expected_address(mpc_root_public_key: &[u8; 64]) -> Result<[u8; 20]> {
    // Derive the global vault authority PDA
    let (global_vault_authority, _bump) =
        Pubkey::find_program_address(&[b"global_vault_authority"], &crate::ID);

    let predecessor_id = global_vault_authority.to_string();

    derive_ethereum_address(mpc_root_public_key, &predecessor_id, RESPOND_BIDIRECTIONAL_PATH)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_derive_epsilon() {
        let epsilon = derive_epsilon("TestPredecessor", "test/path");
        assert_eq!(epsilon.len(), 32);
    }
}
