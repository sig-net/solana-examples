# CLAUDE.md

This file provides guidance to Claude Code when working with code in the `contract/` directory.

## Build & Development Commands

```bash
anchor build             # Build the Solana program
anchor test              # Build + deploy + run every suite (ETH and BTC)
anchor run test-erc20    # Run only the ERC20 suite, no build, no Docker
yarn lint                # Prettier check (CI enforces this)
yarn lint:fix            # Prettier auto-fix
```

Deploying needs the program's upgrade authority, which is **not** the wallet in
`Anchor.toml`'s `[provider]` block. That wallet is the test wallet; pass the
deployer explicitly:

```bash
anchor deploy --provider.wallet ~/.config/solana/<deployer>.json
```

Check the current authority with
`solana program show <program-id> -u devnet`.

## Testing

Tests are **long-running and verbose**. Always run them in a **background Bash
task** and peek into the output to check progress and logs.

The per-test timeout is derived in `utils/envConfig.ts` rather than hardcoded:
the `waitForEvent` budget plus a fixed budget for the rest of the case. With
`MPC_WAITS_FOR_ETH_FINALITY` at its default it is 2,500,000 ms.

`anchor test` runs every suite under `tests/` and starts and stops a Bitcoin
regtest container around them, so Docker must be available. There is no flag to
narrow it to one suite: `[scripts].test` always runs, and `--run` adds a path
rather than replacing it. Use the `test-erc20` script instead — see below.

### Running all tests

```bash
# Run in background via Bash tool with run_in_background: true
anchor test
```

### Running without rebuilding or redeploying

```bash
anchor test --skip-build --skip-deploy
```

### Running only the ERC20 suite

`anchor run` executes a named `[scripts]` entry and sets up the provider the
same way `anchor test` does, so this needs no environment plumbing. It does not
build or deploy.

```bash
anchor run test-erc20

# override the endpoint, e.g. to avoid the public devnet RPC
anchor run test-erc20 --provider.cluster "<rpc-url>"
```

`[provider] cluster = "devnet"` resolves to the public endpoint, which
rate-limits; the ERC20 test carries 429-tracing code for that reason. Pass
`--provider.cluster` with a dedicated RPC, as CI does.

### Driving mocha directly

Bypassing Anchor means nothing sets `ANCHOR_PROVIDER_URL` or `ANCHOR_WALLET`,
which `AnchorProvider.env()` requires. `ANCHOR_WALLET` is a **path** that Anchor
reads with `fs.readFileSync`, not key material, and must be absolute — dotenv
does not expand `~`:

```bash
set -a; . ./.env; set +a
ANCHOR_PROVIDER_URL="<rpc-url>" ANCHOR_WALLET="$HOME/.config/solana/id.json" \
  NODE_OPTIONS='--import tsx' \
  yarn mocha --no-warnings --timeout 2500000 --exit tests/sign-respond-erc20.ts
```

Run **one instance at a time**. Concurrent runs share a derived Ethereum
address, read the same nonce, and collide — one fails with
`REPLACEMENT_UNDERPRICED` while the other never mines.

### Test structure

- `tests/sign-respond-erc20.ts` — ERC20 deposit, withdraw, and refund flows
- `tests/bitcoin/happy-path.ts` — BTC deposit and withdrawal happy path
- `tests/bitcoin/sad-path.ts` — BTC error cases and validation
- `tests/bitcoin/double-spend-conflict.ts` — BTC double-spend conflict handling
- `tests/bitcoin/utils.ts` — Shared BTC test utilities

## Architecture Overview

Anchor-based Solana program implementing cross-chain vault operations for ERC20
tokens (via EVM/Sepolia) and BTC using MPC signatures from the Chain Signatures
protocol.

### Program Structure

All paths below are under `programs/solana-contracts-examples/`:

- `src/lib.rs` — Entrypoint with all instruction handlers
- `src/instructions/erc20_vault.rs` — ERC20 deposit, claim, withdraw, complete-withdraw logic
- `src/instructions/btc_vault.rs` — BTC deposit, claim, withdraw, complete-withdraw logic
- `src/contexts/` — Anchor account contexts (config, erc20, btc)
- `src/state/` — Account state definitions (config, erc20, btc)
- `src/crypto.rs` — Signature verification utilities
- `src/error.rs` — Custom error definitions
- `src/constants.rs` — Program constants

## Environment

Configuration is loaded via `utils/envConfig.ts` with Zod validation from a
`.env` file in this directory (resolved against the process working directory,
so commands must run from `contract/`).

Always required:

- `SEPOLIA_RPC_URL` — full Sepolia JSON-RPC endpoint, e.g.
  `https://eth-sepolia.g.alchemy.com/v2/<key>`. The Ethereum provider is built
  unconditionally, so the ERC20 suite cannot run without it. When unset, an
  Infura URL is composed from `INFURA_API_KEY` as a fallback.

### Choosing an MPC network

`MPC_NETWORK` selects which Chain Signatures deployment to talk to:

- `dev`, `testnet`, `mainnet` — the chain-signatures program id and the MPC root
  public key are both resolved from `signet.js`. Do not also set
  `CHAIN_SIGNATURES_PROGRAM_ID` or `MPC_ROOT_PUBLIC_KEY`: a value that disagrees
  with the selected network is rejected rather than silently ignored.
- `custom` (the default) — a self-hosted MPC. **You must supply both
  `CHAIN_SIGNATURES_PROGRAM_ID` and the root key** (`MPC_ROOT_PUBLIC_KEY`, or
  `MPC_ROOT_PRIVATE_KEY` to derive it). Neither has a default, and validation
  fails if either is missing.

The program id and the root key are properties of the same network and must
always match. Pairing one network's program with another's root key produces
signatures that recover to an unexpected address; nothing fails at request time,
so it surfaces much later as a transaction that never mines or a
`claim_erc20` rejected with `InvalidSignature`.

The on-chain `vault_config` account stores both values, and the ERC20 test
rewrites it to match `.env` when either has drifted.

### Other variables

- `MPC_WAITS_FOR_ETH_FINALITY` — default `true`. Widens the `waitForEvent`
  budget to 30 minutes, since respond events cannot arrive before the source
  transaction finalizes. Set `false` for an MPC that responds on inclusion.
- `DISABLE_LOCAL_CHAIN_SIGNATURE_SERVER` — default `true`. The managed networks
  are external, so this stays `true` unless running the local fakenet signer.
- `SOLANA_RPC_URL`, `SOLANA_PRIVATE_KEY`, `MPC_ROOT_PRIVATE_KEY` — required
  **only** when `DISABLE_LOCAL_CHAIN_SIGNATURE_SERVER=false`. The local fakenet
  signer is their sole consumer; the suite itself reaches Solana through
  `AnchorProvider.env()`.
- `INFURA_API_KEY` — the fallback source for `SEPOLIA_RPC_URL`, and required
  when `DISABLE_LOCAL_CHAIN_SIGNATURE_SERVER=false` because the fakenet signer
  takes an Infura key directly.
- `BITCOIN_NETWORK` — `regtest` or `testnet`.

See `.env.example` for a working template.

## Before Completing Any Task

```bash
yarn lint
```
