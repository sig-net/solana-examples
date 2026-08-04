// Uniswap V3 constants + a read-only QuoterV2 quote for the swap leg. Mirrors the
// reference integration tests' evm-swap.ts. The router is what the vault's approveRouter
// grants an allowance to and what a swap targets; the quoter is a read-only price oracle.
import { Contract as EthersContract, JsonRpcProvider } from 'ethers';
import {
  MPC_PARAMS_BYTES,
  MPCDestination,
  MPCSignatureAlgorithm,
  asciiPadded,
} from '@sig-net/midnight';

// Uniswap V3 on Sepolia (also present on a Sepolia fork).
export const UNISWAP_SWAP_ROUTER_02 = '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E';
export const UNISWAP_QUOTER_V2 = '0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3';
export const UNISWAP_V3_FACTORY = '0x0227628f3F023bb0B980b67D528571c95c6DaC1c';

// exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) -> uint256.
export const EXACT_INPUT_SINGLE_SELECTOR = new Uint8Array([0x04, 0xe4, 0x5a, 0xaf]);
// approve(address,uint256) -> bool.
export const APPROVE_SELECTOR = new Uint8Array([0x09, 0x5e, 0xa7, 0xb3]);
// Effectively-unlimited allowance (matches the contract's approveRouter, 2^128-1).
export const MAX_APPROVE = 340282366920938463463374607431768211455n;

// A V3 single-hop swap is ~120-200k gas; the contract fixes this envelope (vault pays).
export const SWAP_GAS_LIMIT = 300_000n;
export const SWAP_MAX_FEE_PER_GAS = 30_000_000_000n;
export const SWAP_MAX_PRIORITY_FEE_PER_GAS = 1_000_000_000n;

// The exactInputSingle result schema (must byte-match the contract's swapResponseSchema).
export const SWAP_RESULT_SCHEMA = '[{"name":"amountOut","type":"uint256"}]';
export const SWAP_SCHEMA_BYTES = SWAP_RESULT_SCHEMA.length;

// The contract-fixed routing of a swap event (the swap-schema variant of the vault routing).
export const SWAP_MPC_ROUTING = {
  algo: MPCSignatureAlgorithm.ecdsa,
  dest: MPCDestination.unused,
  params: new Uint8Array(MPC_PARAMS_BYTES),
  outputDeserializationSchema: asciiPadded(SWAP_RESULT_SCHEMA, SWAP_SCHEMA_BYTES),
  respondSerializationSchema: asciiPadded(SWAP_RESULT_SCHEMA, SWAP_SCHEMA_BYTES),
};

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
];

/** Whether the Uniswap router is deployed at `evmRpcUrl` (true on Sepolia + the fork). */
export async function uniswapAvailable(evmRpcUrl: string): Promise<boolean> {
  const code = await new JsonRpcProvider(evmRpcUrl).getCode(UNISWAP_SWAP_ROUTER_02);
  return code !== '0x';
}

/**
 * Live QuoterV2 quote for exactInputSingle (a read-only `eth_call`, no state change), plus
 * the `amountOutMin` after applying `slippageBps`. This is what the UI shows and what the
 * swap circuit binds as the on-chain slippage floor.
 */
export async function quoteExactInputSingle(
  evmRpcUrl: string,
  tokenIn: string,
  tokenOut: string,
  fee: bigint,
  amountIn: bigint,
  slippageBps = 100n, // 1%
): Promise<{ amountOut: bigint; amountOutMin: bigint }> {
  const quoter = new EthersContract(UNISWAP_QUOTER_V2, QUOTER_ABI, new JsonRpcProvider(evmRpcUrl));
  const [amountOut] = await quoter.getFunction('quoteExactInputSingle').staticCall({
    tokenIn,
    tokenOut,
    amountIn,
    fee,
    sqrtPriceLimitX96: 0n,
  });
  const amountOutMin = (BigInt(amountOut) * (10_000n - slippageBps)) / 10_000n;
  return { amountOut: BigInt(amountOut), amountOutMin };
}

// The Uniswap V3 fee tiers, in bps*100 (0.01% / 0.05% / 0.3% / 1%). Different pairs live in
// different tiers (e.g. USDC/EURC is 0.05%, a USDC/DAI pool may only exist at 0.01% or 0.3%),
// so the UI must discover which tier actually has a pool rather than assume one.
export const UNISWAP_FEE_TIERS = [100n, 500n, 3000n, 10000n];

/**
 * Quote across every fee tier and return the best (a tier with no pool reverts, so it's
 * skipped). Returns the winning tier's `fee` so the swap binds the SAME pool the quote used.
 * `null` means no pool for this pair at any tier.
 */
export async function quoteBestFee(
  evmRpcUrl: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  slippageBps = 100n,
): Promise<{ amountOut: bigint; amountOutMin: bigint; fee: bigint } | null> {
  const results = await Promise.allSettled(
    UNISWAP_FEE_TIERS.map(async fee => ({
      fee,
      ...(await quoteExactInputSingle(evmRpcUrl, tokenIn, tokenOut, fee, amountIn, slippageBps)),
    })),
  );
  let best: { amountOut: bigint; amountOutMin: bigint; fee: bigint } | null = null;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.amountOut > 0n && (!best || r.value.amountOut > best.amountOut)) {
      best = { amountOut: r.value.amountOut, amountOutMin: r.value.amountOutMin, fee: r.value.fee };
    }
  }
  return best;
}

// A normalized, order-independent key for a token pair (both lowercased + sorted).
export function pairKey(tokenA: string, tokenB: string): string {
  return [tokenA.toLowerCase(), tokenB.toLowerCase()].sort().join('|');
}

const FACTORY_ABI = ['function getPool(address,address,uint24) view returns (address)'];
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Which of the given token pairs have a direct V3 pool at any fee tier. Returns a set of
 * `pairKey`s so the UI can offer only swappable pairs (a token with no pool to anything is
 * hidden entirely). One factory `getPool` per (pair, tier) — cheap read-only `eth_call`s.
 */
export async function discoverSwappablePairs(
  evmRpcUrl: string,
  tokens: string[],
): Promise<Set<string>> {
  const factory = new EthersContract(UNISWAP_V3_FACTORY, FACTORY_ABI, new JsonRpcProvider(evmRpcUrl));
  const getPool = factory.getFunction('getPool');
  const swappable = new Set<string>();
  const checks: Promise<void>[] = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      const a = tokens[i]!;
      const b = tokens[j]!;
      for (const fee of UNISWAP_FEE_TIERS) {
        checks.push(
          getPool(a, b, fee)
            .then((pool: string) => {
              if (pool && pool !== ZERO_ADDRESS) swappable.add(pairKey(a, b));
            })
            .catch(() => {}),
        );
      }
    }
  }
  await Promise.all(checks);
  return swappable;
}

/** The live vault->router allowance for a token (0 means approveRouter is needed once). */
export async function routerAllowance(
  evmRpcUrl: string,
  erc20Hex: string,
  vaultEvmAddress: string,
): Promise<bigint> {
  const token = new EthersContract(
    erc20Hex,
    ['function allowance(address,address) view returns (uint256)'],
    new JsonRpcProvider(evmRpcUrl),
  );
  return BigInt(await token.getFunction('allowance')(vaultEvmAddress, UNISWAP_SWAP_ROUTER_02));
}
