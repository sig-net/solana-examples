## Prerequisites

- Install dependencies: `yarn install`
- Copy `.env.example` to `.env` and configure:

  - `MPC_NETWORK` — `dev`, `testnet`, `mainnet`, or `custom`. The managed
    networks resolve the chain-signatures program and MPC root key from
    `signet.js`; `custom` requires `CHAIN_SIGNATURES_PROGRAM_ID` and either
    `MPC_ROOT_PUBLIC_KEY` or `MPC_ROOT_PRIVATE_KEY`.
  - `SEPOLIA_RPC_URL` for EVM chains
  - `BITCOIN_NETWORK` (regtest/testnet)

  `SOLANA_RPC_URL` and `SOLANA_PRIVATE_KEY` are needed only when running the
  local chain signature server. See `contract/CLAUDE.md` for the full list.

### Bitcoin Setup (Regtest)

For local Bitcoin testing with instant block mining:

Bitcoin Core runs from `docker/bitcoin/docker-compose.yml` in this repository;
`anchor test` starts and stops it automatically. To manage it by hand:

```bash
yarn btc:start   # start the container, create a wallet, mine 101 blocks
yarn btc:stop    # tear it down
```

Set in `.env`:

```
BITCOIN_NETWORK=regtest
```

**Network Options:**

- `regtest` - Local Bitcoin Core (addresses: `bcrt1q...`) - Auto-mines blocks, instant funding
- `testnet` - Bitcoin testnet4 (addresses: `tb1q...`) - Requires external faucet

## Build, Type Check, and Test

- Compile programs: `anchor build`
- Deploy to devnet: `anchor deploy --provider.wallet <deployer-keypair>` —
  deploying needs the program's upgrade authority, which is not the wallet in
  `Anchor.toml`'s `[provider]` block
- Type check and lint: `yarn lint`
- Run tests: `anchor test --skip-build --skip-deploy` (every suite), or
  `anchor run test-erc20` for the ERC20 suite alone
- The TypeScript integration tests automatically ensure the on-chain `vault_config`
  account is initialized with the derived MPC root signer. If the account already
  exists with the correct key, the setup skips re-initialization.

## Key Management

- If you have access to the private key, set `MPC_ROOT_PRIVATE_KEY`; the root public key is derived automatically.
- If the private key is unavailable, provide the uncompressed key in `MPC_ROOT_PUBLIC_KEY` (65-byte hex, prefixed with `04`).
- Ensure the on-chain contract is initialized with the same base public key you load here before interacting with it.

## Proposed Improvement: Intent-Encoded Derivation Paths

### Overview

Turn a single cross-chain deposit into one or more pre-authorized Solana actions by encoding user intent directly into the MPC key derivation path.

Today the `path` parameter in `deposit_*` is set to the user's Solana pubkey — but it's arbitrary. By setting `path = keccak256(abi.encode(actionType, params...))`, the deposit address itself becomes a cryptographic commitment to a specific subsequent action on Solana.

### How It Works

**User (off-chain):**

1. Decide the post-deposit action, e.g. `transfer(20, 0x123, 0x456)`
2. Compute `path = keccak256(abi.encode("transfer", 20, 0x123, 0x456))`
3. Derive the deposit address for that path (deterministic via epsilon derivation)
4. Deposit funds to that address on Ethereum/Bitcoin
5. Publish the action pre-image as calldata in the deposit tx (so any relayer can index it)

**Relayer (single Solana tx, multiple instructions):**

1. Index the deposit tx calldata to recover the action pre-image
2. Call `deposit_*` / `claim_*` with the intent-encoded path → credits vault balance
3. Execute the pre-authorized action (transfer, swap, etc.)
4. The program verifies `keccak256(provided_action_params) == path` before executing

### Properties

- **No MPC-layer changes** — the MPC network already supports arbitrary paths
- **No extra on-chain state for intents** — the deposit address IS the intent
- **Permissionless relaying** — anyone who knows the pre-image can execute; the outcome is deterministic
- **Front-running is harmless** — whoever relays, the same action executes
- **Composable** — the path can encode a sequence of actions, turning 1 deposit into N on-chain operations

### Contract Changes Required

- An action schema defining supported actions (transfer, swap, etc.)
- Path verification: `keccak256(provided_action_params) == path`
- Action execution logic triggered after claim
- Atomicity enforcement: claim + action execution must happen in the same transaction (e.g. a `claim_and_execute` instruction)
- A cancellation/timeout mechanism for deposits to intent-encoded addresses

### Open Questions

- **Cancellation:** once funds are at the derived address, the user can't easily reclaim them — a timeout or cancel-path mechanism is needed
- **Path encoding format:** must be canonical for deterministic hashing; ABI encoding is a good default (unambiguous, well-tooled, fits 64-char path limit as hex hash)
- **Multi-action intents:** `path = keccak256(action1 || action2 || ...)` enables chaining a whole sequence from a single deposit
