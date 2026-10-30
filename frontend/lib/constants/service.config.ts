/**
 * Service configuration constants to centralize hardcoded values
 * across the application services.
 */

export const SERVICE_CONFIG = {
  ETHEREUM: {
    /** Sepolia testnet chain ID */
    CHAIN_ID: 11155111,
    /** CAIP-2 chain ID (eip155:chainId format) */
    CAIP2_ID: 'eip155:1',
  },
  CRYPTOGRAPHY: {
    /** Signature algorithm for chain signatures */
    SIGNATURE_ALGORITHM: 'ECDSA',
    /** Deprecated `dest` field of a request, kept blank; the target chain is `ETHEREUM.CAIP2_ID` */
    DEST: '',
    /** Root path for withdrawal operations, in SigNet's reserved `bidirectional/` namespace */
    WITHDRAWAL_ROOT_PATH: 'bidirectional/root',
  },
  BALANCE: {
    /** Minimum balance threshold (in token units after decimals) */
    MINIMUM_BALANCE: 0.01,
  },
  RETRY: {
    /** Default key version for request generation */
    DEFAULT_KEY_VERSION: 1,
  },
} as const;

/** Path of a user's deposit key, in SigNet's reserved `bidirectional/` namespace */
export const depositPath = (userAddress: string): string =>
  `bidirectional/${userAddress}`;
