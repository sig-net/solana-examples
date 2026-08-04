'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, Settings2 } from 'lucide-react';
import { formatUnits, parseUnits } from 'viem';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { TokenAmountDisplay } from '@/components/ui/token-amount-display';
import { MIDNIGHT_TOKENS } from '@/lib/constants/token-metadata';
import { useMidnightWallet } from '@/providers/midnight-context';
import { useMidnightProgress } from '@/hooks/use-midnight-progress';
import { midnightEnv } from '@/lib/midnight/env';
import { discoverSwappablePairs, pairKey, quoteBestFee } from '@/lib/midnight/evm-swap';
import type { Token } from '@/lib/types/token.types';

import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

interface SwapWidgetProps {
  className?: string;
}

// Slippage presets in bps (0.1% / 0.5% / 1%). The swap binds amountOutMin = quote * (1 - bps).
const SLIPPAGE_PRESETS = [10n, 50n, 100n];
const DEFAULT_SLIPPAGE_BPS = 100n;

type TokenWithBalance = Token & { balance: string; units: bigint };

// Swap uses the shielded vault-token balance (vaultUnits) as the spendable source, and
// mints the swapped-to token back as a shielded coin. Midnight-only: the UI stays disabled
// until the Midnight (Developer) wallet is connected, then draws from MIDNIGHT_TOKENS.
export function SwapWidget({ className }: SwapWidgetProps) {
  const midnight = useMidnightWallet();
  const progress = useMidnightProgress();

  const [fromAmount, setFromAmount] = useState('');
  const [toAmount, setToAmount] = useState('');
  const [fromToken, setFromToken] = useState<TokenWithBalance | undefined>();
  const [toToken, setToToken] = useState<TokenWithBalance | undefined>();
  // Local: whether THIS widget kicked off a swap. progress.active is the shared flow state
  // (deposit/withdraw/swap all use one flow), so it can't distinguish a swap from a deposit.
  const [swapping, setSwapping] = useState(false);
  // The Uniswap V3 fee tier discovered for the current pair (null = no pool at any tier).
  const [fee, setFee] = useState<bigint | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [slippageBps, setSlippageBps] = useState<bigint>(DEFAULT_SLIPPAGE_BPS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Which token pairs have a Uniswap pool (pairKey set; null while still discovering). Only
  // tokens that pair with something are offered — a token with no pool anywhere is hidden.
  const [swappablePairs, setSwappablePairs] = useState<Set<string> | null>(null);

  const enabled = midnight.connected;

  // One entry per Midnight token: shielded vault balance (spendable) + on-chain decimals.
  const tokens: TokenWithBalance[] = useMemo(() => {
    const perToken = midnight.balances?.perToken;
    return MIDNIGHT_TOKENS.map(t => {
      const b = perToken?.[t.erc20Address.toLowerCase()];
      const decimals = b?.decimals ?? 6;
      const units = b?.vaultUnits ?? 0n;
      return {
        erc20Address: t.erc20Address,
        symbol: t.symbol,
        name: t.name,
        decimals,
        chain: 'midnight' as const,
        units,
        balance: formatUnits(units, decimals),
      };
    });
  }, [midnight.balances]);

  // Discover which pairs actually have a pool (once, on connect). Token addresses are static,
  // so this doesn't depend on balances.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    discoverSwappablePairs(midnightEnv.evmRpcUrl, MIDNIGHT_TOKENS.map(t => t.erc20Address))
      .then(pairs => !cancelled && setSwappablePairs(pairs))
      .catch(() => !cancelled && setSwappablePairs(new Set()));
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  // From = any token with a pool to something; To = tokens that pair with the current From.
  const fromTokens = useMemo(
    () =>
      swappablePairs
        ? tokens.filter(t =>
            tokens.some(
              o => o.erc20Address !== t.erc20Address && swappablePairs.has(pairKey(t.erc20Address, o.erc20Address)),
            ),
          )
        : [],
    [tokens, swappablePairs],
  );
  const toTokens = useMemo(
    () =>
      swappablePairs && fromToken
        ? tokens.filter(
            t =>
              t.erc20Address !== fromToken.erc20Address &&
              swappablePairs.has(pairKey(fromToken.erc20Address, t.erc20Address)),
          )
        : [],
    [tokens, swappablePairs, fromToken],
  );

  // Default the from/to selections to a valid swappable pair, preferring a From the user holds.
  useEffect(() => {
    if (!enabled || fromTokens.length === 0) return;
    setFromToken(prev =>
      prev && fromTokens.some(t => t.erc20Address === prev.erc20Address)
        ? prev
        : (fromTokens.find(t => t.units > 0n) ?? fromTokens[0]),
    );
  }, [enabled, fromTokens]);

  // Keep To a valid partner of the current From.
  useEffect(() => {
    if (toTokens.length === 0) return;
    setToToken(prev =>
      prev && toTokens.some(t => t.erc20Address === prev.erc20Address) ? prev : toTokens[0],
    );
  }, [toTokens]);

  // Keep the from/to selections in sync with refreshed balances (same token id, new balance).
  const fromSel = fromToken && tokens.find(t => t.erc20Address === fromToken.erc20Address);
  const toSel = toToken && tokens.find(t => t.erc20Address === toToken.erc20Address);

  // Live quote for the "to" amount, discovering the fee tier that actually has a pool for this
  // pair (USDC/EURC is 0.05% but USDC/DAI may only exist at another tier). Best-effort; the
  // swap re-quotes on-chain for the slippage floor. Debounced, cancelled if inputs change.
  useEffect(() => {
    setFee(null);
    if (!enabled || !fromSel || !toSel || fromSel.erc20Address === toSel.erc20Address) {
      setToAmount('');
      return;
    }
    let amountIn: bigint;
    try {
      amountIn = parseUnits(fromAmount || '0', fromSel.decimals);
    } catch {
      setToAmount('');
      return;
    }
    if (amountIn <= 0n) {
      setToAmount('');
      return;
    }
    let cancelled = false;
    setQuoting(true);
    const id = setTimeout(async () => {
      try {
        const best = await quoteBestFee(
          midnightEnv.evmRpcUrl,
          fromSel.erc20Address,
          toSel.erc20Address,
          amountIn,
          slippageBps,
        );
        if (cancelled) return;
        setFee(best?.fee ?? null);
        setToAmount(best ? formatUnits(best.amountOut, toSel.decimals) : '');
      } catch {
        if (!cancelled) {
          setFee(null);
          setToAmount('');
        }
      } finally {
        if (!cancelled) setQuoting(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [enabled, fromAmount, fromSel, toSel, slippageBps]);

  const amountValid = (() => {
    if (!fromSel) return false;
    try {
      const units = parseUnits(fromAmount || '0', fromSel.decimals);
      return units > 0n && units <= fromSel.units;
    } catch {
      return false;
    }
  })();

  const canSwap =
    enabled &&
    !!fromSel &&
    !!toSel &&
    fromSel.erc20Address !== toSel.erc20Address &&
    amountValid &&
    fee !== null &&
    !quoting &&
    !progress.active;

  const handleSwap = () => {
    if (!canSwap || !fromSel || !toSel || fee === null) return;
    const units = parseUnits(fromAmount, fromSel.decimals);
    setSwapping(true);
    midnight
      .swap(fromSel.erc20Address, toSel.erc20Address, units, fee, slippageBps)
      .then(() => {
        setFromAmount('');
        setToAmount('');
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Swap failed'))
      .finally(() => setSwapping(false));
  };

  const noPool = amountValid && !quoting && fee === null;
  const buttonLabel = !enabled
    ? 'Connect Midnight to swap'
    : swappablePairs === null
      ? 'Loading pools…'
      : swapping
        ? 'Swapping…'
        : quoting
          ? 'Fetching quote…'
          : noPool
            ? 'No pool for this pair'
            : 'Swap';

  return (
    <div
      className={cn(
        'border-dark-neutral-50 gradient-bg-swap relative w-full max-w-full shrink-0 space-y-6 self-start border p-4 sm:p-6 lg:max-w-sm lg:p-8',
        className,
      )}
    >
      <div className='flex items-center justify-between'>
        <h2 className='text-tundora-400 text-xl font-semibold'>Swap</h2>
        <Button
          variant='ghost'
          size='icon'
          className='h-8 w-8 p-0'
          onClick={() => setSettingsOpen(true)}
          aria-label='Swap settings'
        >
          <Settings2 className='text-dark-neutral-300 h-6 w-6' />
        </Button>
      </div>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Swap settings</DialogTitle>
            <DialogDescription>
              Max slippage — the swap reverts on-chain if the output falls below this
              tolerance of the quote.
            </DialogDescription>
          </DialogHeader>
          <div className='flex flex-wrap gap-2'>
            {SLIPPAGE_PRESETS.map(bps => (
              <Button
                key={String(bps)}
                variant={slippageBps === bps ? 'secondary' : 'outline'}
                size='sm'
                onClick={() => setSlippageBps(bps)}
              >
                {formatUnits(bps, 2)}%
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <div className='flex flex-col gap-4'>
        <TokenAmountDisplay
          value={fromAmount}
          onChange={setFromAmount}
          tokens={enabled ? fromTokens : []}
          selectedToken={fromSel}
          onTokenSelect={t => setFromToken(t as TokenWithBalance)}
          placeholder='0'
          disabled={!enabled}
        />

        <div className='flex justify-center'>
          <ArrowDown className='text-dark-neutral-300 h-5 w-5' />
        </div>

        <TokenAmountDisplay
          value={toAmount}
          onChange={() => {}}
          tokens={enabled ? toTokens : []}
          selectedToken={toSel}
          onTokenSelect={t => setToToken(t as TokenWithBalance)}
          placeholder='0'
          disabled={!enabled}
        />
      </div>

      <Button
        onClick={handleSwap}
        disabled={!canSwap}
        variant='secondary'
        size='lg'
        className='w-full'
      >
        {buttonLabel}
      </Button>
    </div>
  );
}
