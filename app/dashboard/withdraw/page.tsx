'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useRhinestoneTransfer } from '@/hooks/useRhinestoneTransfer';
import { signedFetch } from '@/lib/api/signedFetch';

type WalletType = 'money' | 'spot';

/** One withdrawable spot position: an asset on a specific chain, with its balance. */
type Holding = {
    key: string; // `${symbol}-${chainId}`
    symbol: string;
    chainId: number;
    network: string;
    balance: string; // human-readable
    usdValue: number;
};

/** EVM chains you can withdraw TO. Same chain as the asset = same-chain withdraw;
 *  a different one bridges the asset (cross-chain). Backend validates the asset
 *  actually exists on the chosen destination. */
const DEST_CHAINS: { id: number; name: string }[] = [
    { id: 8453, name: 'Base' },
    { id: 42161, name: 'Arbitrum' },
    { id: 10, name: 'Optimism' },
    { id: 137, name: 'Polygon' },
    { id: 1, name: 'Ethereum' },
];

/** Block explorer tx URL by chainId (for the success link). */
function explorerTx(chainId: number, hash: string): string {
    const base: Record<number, string> = {
        9745: 'https://plasmascan.to/tx/',
        8453: 'https://basescan.org/tx/',
        42161: 'https://arbiscan.io/tx/',
        10: 'https://optimistic.etherscan.io/tx/',
        137: 'https://polygonscan.com/tx/',
        1: 'https://etherscan.io/tx/',
    };
    return (base[chainId] ?? 'https://blockscan.com/tx/') + hash;
}

/**
 * Isolated test screen for Withdraw — send funds OUT to an external EVM address.
 * Money withdraws USDT0 on Plasma; Spot withdraws a chosen holding on its own
 * chain. Same-chain, 0.1% fee deducted.
 *
 * Spot assets/chains are NOT free-typed — you pick from the wallet's real
 * holdings (asset + chain, from /transactions/dashboard), so you can't submit a
 * symbol/chain you don't actually hold (which just simulation-fails on balance).
 */
export default function WithdrawPage() {
    const router = useRouter();
    const { withdrawViaBackend, isSending, error } = useRhinestoneTransfer();

    const [accessToken, setAccessToken] = useState<string | null>(null);
    const [walletType, setWalletType] = useState<WalletType>('money');
    // Money only: what the recipient receives — USDT (direct) or USDC (same-chain swap on BSC).
    const [outputToken, setOutputToken] = useState<'USDT' | 'USDC'>('USDT');
    const [toAddress, setToAddress] = useState('');
    const [amount, setAmount] = useState('');
    const [result, setResult] = useState<{ hash: string; chainId: number } | null>(null);
    const [localError, setLocalError] = useState<string | null>(null);

    // Spot holdings (asset × chain) fetched from the dashboard.
    const [holdings, setHoldings] = useState<Holding[]>([]);
    const [loadingHoldings, setLoadingHoldings] = useState(false);
    const [selectedKey, setSelectedKey] = useState<string>('');
    // Manual fallback when no holdings are detected (keeps the flow usable).
    const [manual, setManual] = useState(false);
    const [manualSymbol, setManualSymbol] = useState('USDC');
    const [manualChainId, setManualChainId] = useState('8453');

    // Destination chain to RECEIVE on. Defaults to the asset's own chain
    // (same-chain); choosing a different chain makes it a cross-chain withdraw.
    const [destChainId, setDestChainId] = useState<string>('');

    const selected = holdings.find((h) => h.key === selectedKey) ?? null;
    // The effective asset + chain that will be submitted for a spot withdraw.
    const spotSymbol = manual ? manualSymbol : selected?.symbol ?? '';
    const spotChainId = manual ? manualChainId : selected ? String(selected.chainId) : '';
    const isCrossChain =
        walletType === 'spot' && !!destChainId && !!spotChainId && destChainId !== spotChainId;

    useEffect(() => {
        const token = localStorage.getItem('accessToken');
        if (!token) { router.push('/'); return; }
        setAccessToken(token);
    }, [router]);

    /** Flatten dashboard assets → one entry per (asset, EVM chain) with a balance. */
    const fetchHoldings = useCallback(async () => {
        setLoadingHoldings(true);
        try {
            const res = await signedFetch(
                '/transactions/dashboard?walletType=spot',
                { auth: true },
            );
            if (!res.ok) return;
            const d = await res.json();
            const flat: Holding[] = [];
            for (const a of (d.assets ?? []) as any[]) {
                for (const c of (a.chains ?? []) as any[]) {
                    if (c.type !== 'evm') continue; // withdraw is EVM-only
                    if (!(parseFloat(c.balance) > 0)) continue; // skip empties
                    flat.push({
                        key: `${a.symbol}-${c.chainId}`,
                        symbol: a.symbol,
                        chainId: c.chainId,
                        network: c.network ?? String(c.chainId),
                        balance: c.balance,
                        usdValue: c.usdValue ?? 0,
                    });
                }
            }
            flat.sort((x, y) => y.usdValue - x.usdValue);
            setHoldings(flat);
            setManual(flat.length === 0); // no holdings → manual fallback
            setSelectedKey((prev) =>
                flat.find((h) => h.key === prev)?.key ?? flat[0]?.key ?? '',
            );
        } catch {
            /* leave holdings empty; manual fallback covers it */
            setManual(true);
        } finally {
            setLoadingHoldings(false);
        }
    }, []);

    // Load holdings when the user switches to the Spot tab.
    useEffect(() => {
        if (walletType === 'spot' && accessToken) fetchHoldings();
    }, [walletType, accessToken, fetchHoldings]);

    // Default the destination chain to the asset's own chain (same-chain) whenever
    // the selected asset/chain changes.
    useEffect(() => {
        if (spotChainId) setDestChainId(spotChainId);
    }, [spotChainId]);

    const handleWithdraw = async () => {
        setResult(null);
        setLocalError(null);
        if (!accessToken) return;
        if (!toAddress) { setLocalError('Enter a destination address'); return; }
        if (!amount) { setLocalError('Enter an amount'); return; }
        if (walletType === 'spot' && (!spotSymbol || !spotChainId)) {
            setLocalError('Pick an asset to withdraw');
            return;
        }
        try {
            const res = await withdrawViaBackend({
                accessToken,
                walletType,
                toAddress: toAddress.trim(),
                amount: amount.trim(),
                ...(walletType === 'money'
                    ? { outputToken }
                    : {
                        symbol: spotSymbol.trim(),
                        chainId: parseInt(spotChainId, 10),
                        // Only send destChainId when it differs — same-chain otherwise.
                        ...(isCrossChain ? { destChainId: parseInt(destChainId, 10) } : {}),
                    }),
            });
            // Money is on BSC now; spot cross-chain fills on the destination chain.
            const resultChainId =
                walletType === 'money' ? 56 : parseInt(isCrossChain ? destChainId : spotChainId, 10);
            setResult({ hash: res.hash, chainId: resultChainId });
        } catch (e: any) {
            setLocalError(e?.message || 'Withdraw failed');
        }
    };

    const shown = localError || error;
    const input = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-black';

    return (
        <div className="min-h-screen bg-slate-50 p-6">
            <div className="max-w-md mx-auto">
                <button onClick={() => router.push('/dashboard')} className="text-sm text-slate-500 hover:text-slate-700 mb-4">← Back</button>

                <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
                    <h1 className="text-xl font-bold text-slate-900">Withdraw</h1>
                    <p className="text-sm text-slate-500 mt-1">Send to an external address · 0.1% fee deducted · spot can bridge cross-chain</p>

                    <div className="grid grid-cols-2 gap-2 mt-6">
                        {(['money', 'spot'] as WalletType[]).map((w) => (
                            <button
                                key={w}
                                onClick={() => setWalletType(w)}
                                className={`rounded-lg py-3 text-sm font-medium border transition ${walletType === w
                                    ? 'bg-emerald-600 text-white border-emerald-600'
                                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'}`}
                            >
                                {w === 'money' ? 'Money (USDT/BSC)' : 'Spot (asset chain)'}
                            </button>
                        ))}
                    </div>

                    {walletType === 'money' && (
                        <div className="mt-4">
                            <label className="block text-sm font-medium text-slate-700 mb-1">Recipient receives</label>
                            <div className="grid grid-cols-2 gap-2">
                                {(['USDT', 'USDC'] as const).map((t) => (
                                    <button
                                        key={t}
                                        onClick={() => setOutputToken(t)}
                                        className={`rounded-lg py-2.5 text-sm font-medium border transition ${outputToken === t
                                            ? 'bg-emerald-600 text-white border-emerald-600'
                                            : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'}`}
                                    >
                                        {t}{t === 'USDC' ? ' · swap' : ' · direct'}
                                    </button>
                                ))}
                            </div>
                            {outputToken === 'USDC' && (
                                <p className="mt-1 text-xs text-amber-600">
                                    USDC is delivered via a same-chain swap on BSC (0.5% slippage) — no bridge.
                                </p>
                            )}
                        </div>
                    )}

                    {walletType === 'spot' && (
                        <div className="mt-4">
                            <div className="flex items-center justify-between mb-1">
                                <label className="block text-sm font-medium text-slate-700">Asset to withdraw</label>
                                <button
                                    onClick={fetchHoldings}
                                    disabled={loadingHoldings}
                                    className="text-xs text-emerald-700 hover:underline disabled:opacity-50"
                                >
                                    {loadingHoldings ? 'Loading…' : '↻ Refresh'}
                                </button>
                            </div>

                            {!manual ? (
                                <>
                                    <select
                                        value={selectedKey}
                                        onChange={(e) => setSelectedKey(e.target.value)}
                                        className={input}
                                    >
                                        {holdings.map((h) => (
                                            <option key={h.key} value={h.key}>
                                                {h.symbol} on {h.network} — {h.balance} (${h.usdValue.toFixed(2)})
                                            </option>
                                        ))}
                                    </select>
                                    {selected && (
                                        <div className="mt-1 flex items-center justify-between text-xs text-slate-500">
                                            <span>Available: {selected.balance} {selected.symbol}</span>
                                            <button
                                                onClick={() => setAmount(selected.balance)}
                                                className="text-emerald-700 hover:underline"
                                            >
                                                Max
                                            </button>
                                        </div>
                                    )}
                                    <button
                                        onClick={() => setManual(true)}
                                        className="mt-2 text-xs text-slate-400 hover:text-slate-600 hover:underline"
                                    >
                                        Enter manually instead
                                    </button>
                                </>
                            ) : (
                                <>
                                    <div className="grid grid-cols-2 gap-2">
                                        <input
                                            value={manualSymbol}
                                            onChange={(e) => setManualSymbol(e.target.value)}
                                            placeholder="Symbol (USDC)"
                                            className={input}
                                        />
                                        <input
                                            value={manualChainId}
                                            onChange={(e) => setManualChainId(e.target.value)}
                                            placeholder="Chain ID (8453)"
                                            inputMode="numeric"
                                            className={input}
                                        />
                                    </div>
                                    <p className="mt-1 text-xs text-amber-600">
                                        {holdings.length === 0
                                            ? 'No spot holdings detected — enter the asset + chain manually.'
                                            : 'Manual entry — make sure you actually hold this asset on this chain.'}
                                    </p>
                                    {holdings.length > 0 && (
                                        <button
                                            onClick={() => setManual(false)}
                                            className="mt-1 text-xs text-emerald-700 hover:underline"
                                        >
                                            Pick from my holdings instead
                                        </button>
                                    )}
                                </>
                            )}
                        </div>
                    )}

                    {walletType === 'spot' && (
                        <div className="mt-4">
                            <label className="block text-sm font-medium text-slate-700 mb-1">Receive on chain</label>
                            <select
                                value={destChainId}
                                onChange={(e) => setDestChainId(e.target.value)}
                                className={input}
                            >
                                {/* Always allow the asset's own chain (same-chain) even if not in the preset list. */}
                                {spotChainId && !DEST_CHAINS.some((c) => String(c.id) === spotChainId) && (
                                    <option value={spotChainId}>Source chain ({spotChainId})</option>
                                )}
                                {DEST_CHAINS.map((c) => (
                                    <option key={c.id} value={String(c.id)}>
                                        {c.name}{String(c.id) === spotChainId ? ' (same chain)' : ''}
                                    </option>
                                ))}
                            </select>
                            {isCrossChain && (
                                <p className="mt-1 text-xs text-amber-600">
                                    Cross-chain: {spotSymbol || 'the asset'} is bridged to the destination and
                                    delivered net of bridge + 0.1% fees. Small amounts may be uneconomical.
                                </p>
                            )}
                        </div>
                    )}

                    <label className="block text-sm font-medium text-slate-700 mt-4 mb-1">Destination address</label>
                    <input
                        value={toAddress}
                        onChange={(e) => setToAddress(e.target.value)}
                        placeholder="0x…"
                        className={input + ' font-mono text-sm'}
                    />

                    <label className="block text-sm font-medium text-slate-700 mt-4 mb-1">
                        Amount ({walletType === 'money' ? 'USDT' : spotSymbol || 'token'})
                        {walletType === 'money' && outputToken === 'USDC' && (
                            <span className="text-slate-400 font-normal"> → swapped to USDC</span>
                        )}
                    </label>
                    <input
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        placeholder="10"
                        inputMode="decimal"
                        className={input}
                    />

                    <button
                        onClick={handleWithdraw}
                        disabled={isSending}
                        className="w-full mt-6 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white font-semibold rounded-lg py-3 transition"
                    >
                        {isSending ? 'Withdrawing…' : 'Withdraw'}
                    </button>

                    {shown && <div className="mt-4 bg-red-50 text-red-600 text-sm rounded-lg p-3 break-words">{shown}</div>}
                    {result && (
                        <div className="mt-4 bg-emerald-50 text-emerald-700 text-sm rounded-lg p-3">
                            <p className="font-semibold">Withdrawn ✓</p>
                            <a href={explorerTx(result.chainId, result.hash)} target="_blank" rel="noreferrer" className="font-mono text-xs underline break-all">{result.hash}</a>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
