'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useRhinestoneTransfer } from '@/hooks/useRhinestoneTransfer';

const NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000';

const CHAIN_NAMES: Record<number, string> = {
    1: 'Ethereum', 10: 'Optimism', 56: 'BSC', 137: 'Polygon',
    8453: 'Base', 42161: 'Arbitrum', 9745: 'Plasma',
};
const chainName = (id: number) => CHAIN_NAMES[id] ?? `chain ${id}`;

/** Chain-aware block-explorer link. A swap fills on the TARGET chain, so the
 *  result link must resolve there. */
function getExplorerTxUrl(chainId: number | undefined, hash: string): string {
    switch (chainId) {
        case 9745: return `https://plasmascan.to/tx/${hash}`;
        case 1: return `https://etherscan.io/tx/${hash}`;
        case 8453: return `https://basescan.org/tx/${hash}`;
        case 42161: return `https://arbiscan.io/tx/${hash}`;
        case 10: return `https://optimistic.etherscan.io/tx/${hash}`;
        case 137: return `https://polygonscan.com/tx/${hash}`;
        case 56: return `https://bscscan.com/tx/${hash}`;
        default: return `https://basescan.org/tx/${hash}`;
    }
}

type AssetChain = { chainId: number; type: string; network: string; address: string; balance: string; usdValue: number };
type Asset = { symbol: string; name?: string; totalBalance: string; totalUsdValue: string; decimals: number; chains: AssetChain[] };

/**
 * Swap test screen — NEW multi-source workflow. You pick a source ASSET (by
 * symbol) that you hold in Spot; the backend AGGREGATES that asset across every
 * chain you hold it on into one Rhinestone intent. The destination chain is
 * chosen by the backend RESOLVER (BSC-preferred) unless you switch to advanced
 * and fix it yourself. Balances are read from the same backend endpoint the swap
 * sources from, so what you see here is exactly what a swap will aggregate.
 */
export default function SwapPage() {
    const router = useRouter();
    const { quoteSwap, swapViaBackend, getBackendBalances, isSending, error } = useRhinestoneTransfer();

    const [accessToken, setAccessToken] = useState<string | null>(null);

    // Live spot balances (backend view — what the swap will source from).
    const [assets, setAssets] = useState<Asset[]>([]);
    const [balLoading, setBalLoading] = useState(false);
    const [balError, setBalError] = useState<string | null>(null);

    const [fromSymbol, setFromSymbol] = useState<string>('');
    const [amount, setAmount] = useState('');

    // Destination. Resolver mode (default) sends only the symbol; the backend
    // picks the best output chain (BSC-preferred). Advanced mode fixes the chain.
    const [autoResolve, setAutoResolve] = useState(true);
    const [toSymbol, setToSymbol] = useState('USDT');
    const [toToken, setToToken] = useState('');
    const [toDecimals, setToDecimals] = useState('18');
    const [toChainId, setToChainId] = useState('8453');

    const [quote, setQuote] = useState<any>(null);
    const [quoting, setQuoting] = useState(false);
    const [result, setResult] = useState<{ hash: string; chainId?: number } | null>(null);
    const [localError, setLocalError] = useState<string | null>(null);

    const loadBalances = useCallback(async (token: string) => {
        setBalLoading(true); setBalError(null);
        try {
            const res = await getBackendBalances({ accessToken: token, walletType: 'spot' });
            const held = (res.assets ?? []).filter((a) => parseFloat(a.totalBalance || '0') > 0);
            setAssets(held);
            // Default the source to the largest-USD holding.
            if (held.length && !fromSymbol) {
                const top = [...held].sort((a, b) => parseFloat(b.totalUsdValue) - parseFloat(a.totalUsdValue))[0];
                setFromSymbol(top.symbol);
            }
        } catch (e: any) {
            setBalError(e?.message || 'Failed to load balances');
        } finally {
            setBalLoading(false);
        }
    }, [getBackendBalances, fromSymbol]);

    useEffect(() => {
        const token = localStorage.getItem('accessToken');
        if (!token) { router.push('/'); return; }
        setAccessToken(token);
        loadBalances(token);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [router]);

    const selected = assets.find((a) => a.symbol === fromSymbol);
    // Chains the backend will actually aggregate from: EVM, non-Plasma, non-zero.
    const sourceChains = (selected?.chains ?? []).filter(
        (c) => c.type === 'evm' && c.chainId !== 9745 && parseFloat(c.balance || '0') > 0,
    );
    const aggregatable = sourceChains.reduce((s, c) => s + parseFloat(c.balance || '0'), 0);

    // Reference leg for the DTO (backend re-derives all legs by symbol; these just
    // anchor fromToken/chain/decimals). Must be a real swappable EVM source chain.
    const refChain = sourceChains[0];
    const refFromToken = !refChain || refChain.address === 'native' ? NATIVE_ADDRESS : refChain.address;

    const buildParams = () => {
        const base = {
            accessToken: accessToken!,
            fromToken: refFromToken,
            fromSymbol: selected!.symbol,
            fromDecimals: selected!.decimals,
            fromChainId: refChain!.chainId,
            toSymbol: toSymbol.trim() || 'TOKEN',
            amount: amount.trim(),
        };
        if (autoResolve) return base;
        return {
            ...base,
            toToken: toToken.trim(),
            toDecimals: parseInt(toDecimals) || 18,
            toChainId: parseInt(toChainId) || refChain!.chainId,
        };
    };

    const validate = (): string | null => {
        if (!selected) return 'Pick a source asset you hold';
        if (!refChain) return 'This asset has no swappable (non-Plasma EVM) balance';
        if (!amount || parseFloat(amount) <= 0) return 'Enter an amount';
        if (!toSymbol.trim()) return 'Enter a destination symbol';
        if (!autoResolve && !toToken.trim()) return 'Destination token address required in advanced mode';
        return null;
    };

    const handleQuote = async () => {
        setResult(null); setLocalError(null); setQuote(null);
        const v = validate();
        if (v) { setLocalError(v); return; }
        setQuoting(true);
        try {
            setQuote(await quoteSwap(buildParams()));
        } catch (e: any) {
            setLocalError(e?.message || 'Quote failed');
        } finally {
            setQuoting(false);
        }
    };

    const handleSwap = async () => {
        setResult(null); setLocalError(null);
        const v = validate();
        if (v) { setLocalError(v); return; }
        try {
            const settledChain = quote?.to?.chainId ?? (parseInt(toChainId) || undefined);
            const res = await swapViaBackend(buildParams());
            setResult({ ...res, chainId: settledChain });
            setQuote(null);
            if (accessToken) loadBalances(accessToken); // refresh after swap
        } catch (e: any) {
            setLocalError(e?.message || 'Swap failed');
        }
    };

    const shown = localError || error;
    const input = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-black';

    return (
        <div className="min-h-screen bg-slate-50 p-6">
            <div className="max-w-md mx-auto">
                <button onClick={() => router.push('/dashboard')} className="text-sm text-slate-500 hover:text-slate-700 mb-4">← Back</button>

                <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
                    <h1 className="text-xl font-bold text-slate-900">Swap</h1>
                    <p className="text-sm text-slate-500 mt-1">Spot · aggregates one asset across all your chains → any token</p>

                    {/* Live spot balances — exactly what the swap sources from. */}
                    <div className="mt-4 flex items-center justify-between">
                        <span className="text-sm font-medium text-slate-700">Your Spot balances</span>
                        <button onClick={() => accessToken && loadBalances(accessToken)} disabled={balLoading} className="text-xs text-emerald-700 hover:underline disabled:opacity-50">
                            {balLoading ? 'Loading…' : 'Refresh'}
                        </button>
                    </div>
                    {balError && <p className="mt-1 text-xs text-red-600">{balError}</p>}
                    {!balError && !balLoading && assets.length === 0 && (
                        <p className="mt-1 text-xs text-slate-500">No spot balances found. Fund your spot wallet (e.g. USDC on Base and Arbitrum) to test multi-source.</p>
                    )}
                    {assets.length > 0 && (
                        <div className="mt-2 rounded-lg border border-slate-200 divide-y divide-slate-100 text-sm">
                            {assets.map((a) => (
                                <div key={a.symbol} className="px-3 py-2">
                                    <div className="flex justify-between">
                                        <span className="font-medium text-slate-800">{a.symbol}</span>
                                        <span className="text-slate-800">{a.totalBalance} <span className="text-slate-400">(${a.totalUsdValue})</span></span>
                                    </div>
                                    <div className="mt-0.5 text-xs text-slate-500">
                                        {a.chains.filter((c) => parseFloat(c.balance || '0') > 0).map((c) => (
                                            <span key={c.chainId} className="mr-2">{chainName(c.chainId)}: {c.balance}</span>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* From — pick the asset; backend aggregates it across every chain you hold it on. */}
                    <label className="block text-sm font-medium text-slate-700 mt-6 mb-1">From (aggregated across your chains)</label>
                    <select value={fromSymbol} onChange={(e) => { setFromSymbol(e.target.value); setQuote(null); }} className={input} disabled={assets.length === 0}>
                        {assets.length === 0 && <option value="">— no balances —</option>}
                        {assets.map((a) => (
                            <option key={a.symbol} value={a.symbol}>{a.symbol} · {a.totalBalance} across {a.chains.filter((c) => parseFloat(c.balance || '0') > 0).length} chain(s)</option>
                        ))}
                    </select>
                    {selected && (
                        <p className="mt-1 text-xs text-slate-500">
                            Will source from: {sourceChains.length ? sourceChains.map((c) => `${chainName(c.chainId)} (${c.balance})`).join(', ') : '— none swappable —'}
                            {sourceChains.length > 1 && <span className="text-emerald-600"> · multi-source</span>}
                        </p>
                    )}

                    <label className="block text-sm font-medium text-slate-700 mt-4 mb-1">Amount</label>
                    <div className="flex gap-2">
                        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10" inputMode="decimal" className={input} />
                        <button onClick={() => setAmount(String(aggregatable))} disabled={!selected} className="shrink-0 px-3 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50">Max</button>
                    </div>
                    {selected && <p className="mt-1 text-xs text-slate-400">Max aggregatable: {aggregatable} {selected.symbol}</p>}

                    {/* Destination. */}
                    <label className="block text-sm font-medium text-slate-700 mt-4 mb-1">To (receive any token)</label>
                    <label className="flex items-center gap-2 text-xs text-slate-600 mb-2">
                        <input type="checkbox" checked={autoResolve} onChange={(e) => setAutoResolve(e.target.checked)} />
                        Auto-pick output chain (resolver · BSC-preferred) — send symbol only
                    </label>
                    <input value={toSymbol} onChange={(e) => setToSymbol(e.target.value)} placeholder={autoResolve ? 'USDT' : 'LINK'} className={input} />
                    {!autoResolve && (
                        <>
                            <input value={toChainId} onChange={(e) => setToChainId(e.target.value)} placeholder="chainId (8453)" className={input + ' mt-2'} />
                            <input value={toToken} onChange={(e) => setToToken(e.target.value)} placeholder="0x token address" className={input + ' mt-2 font-mono text-xs'} />
                            <input value={toDecimals} onChange={(e) => setToDecimals(e.target.value)} placeholder="decimals (18)" className={input + ' mt-2'} />
                        </>
                    )}

                    <button onClick={handleQuote} disabled={quoting || isSending || !selected} className="w-full mt-6 border border-emerald-600 text-emerald-700 hover:bg-emerald-50 disabled:opacity-60 font-semibold rounded-lg py-3 transition">
                        {quoting ? 'Getting quote…' : 'Get quote'}
                    </button>

                    {quote && (
                        <div className="mt-4 bg-slate-50 border border-slate-200 rounded-lg p-4 text-sm text-slate-700">
                            {quote.quoteAvailable ? (
                                <>
                                    <div className="flex justify-between"><span>You&apos;ll receive ≈</span><span className="font-semibold text-slate-900">{quote.to.youReceive} {quote.to.symbol}</span></div>
                                    <div className="flex justify-between text-slate-500 mt-1"><span>Settles on</span><span>{quote.to.symbol} · {chainName(quote.to.chainId)}{autoResolve ? ' (resolver)' : ''}</span></div>
                                    {quote.from?.sources?.length ? (
                                        <div className="mt-2 pt-2 border-t border-slate-200 text-xs text-slate-500">
                                            <div className="font-medium text-slate-600 mb-1">Sourced from {quote.from.sources.length} chain(s):</div>
                                            {quote.from.sources.map((s: any, i: number) => (
                                                <div key={i} className="flex justify-between"><span>{chainName(s.chainId)}</span><span>{s.amount} {quote.from.symbol}</span></div>
                                            ))}
                                        </div>
                                    ) : null}
                                    <div className="flex justify-between text-slate-500 mt-1"><span>Network + bridge cost</span><span>{quote.feeUsd != null ? `~$${quote.feeUsd.toFixed(4)} (included)` : 'included'}</span></div>
                                    <div className="flex justify-between text-slate-500 mt-1"><span>Gas</span><span>you pay none</span></div>
                                    <button onClick={handleSwap} disabled={isSending} className="w-full mt-4 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white font-semibold rounded-lg py-3 transition">
                                        {isSending ? 'Swapping…' : `Confirm swap`}
                                    </button>
                                </>
                            ) : (
                                <p className="text-amber-600">{quote.quoteReason || 'Couldn’t find a route for this swap.'}</p>
                            )}
                        </div>
                    )}

                    {shown && <div className="mt-4 bg-red-50 text-red-600 text-sm rounded-lg p-3 break-words">{shown}</div>}
                    {result && (
                        <div className="mt-4 bg-emerald-50 text-emerald-700 text-sm rounded-lg p-3">
                            <p className="font-semibold">Swapped ✓</p>
                            <a href={getExplorerTxUrl(result.chainId, result.hash)} target="_blank" rel="noreferrer" className="font-mono text-xs underline break-all">{result.hash}</a>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
