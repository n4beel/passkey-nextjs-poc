'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useRhinestoneTransfer } from '@/hooks/useRhinestoneTransfer';
import { getExplorerTxUrl } from '@/lib/explorer';

type Direction = 'money-to-spot' | 'spot-to-money';

/**
 * Isolated test screen for Move — shift USDT0 between the user's Money and Spot
 * wallets (same-chain Plasma, 0.1% fee deducted).
 */
export default function MovePage() {
    const router = useRouter();
    const { moveViaBackend, isSending, error } = useRhinestoneTransfer();

    const [accessToken, setAccessToken] = useState<string | null>(null);
    const [direction, setDirection] = useState<Direction>('money-to-spot');
    const [amount, setAmount] = useState('');
    const [result, setResult] = useState<{ hash: string } | null>(null);
    const [localError, setLocalError] = useState<string | null>(null);

    useEffect(() => {
        const token = localStorage.getItem('accessToken');
        if (!token) { router.push('/'); return; }
        setAccessToken(token);
    }, [router]);

    const handleMove = async () => {
        setResult(null);
        setLocalError(null);
        if (!accessToken) return;
        if (!amount) { setLocalError('Enter an amount'); return; }
        try {
            const res = await moveViaBackend({ accessToken, direction, amount: amount.trim() });
            setResult(res);
        } catch (e: any) {
            setLocalError(e?.message || 'Move failed');
        }
    };

    const shown = localError || error;

    return (
        <div className="min-h-screen bg-slate-50 p-6">
            <div className="max-w-md mx-auto">
                <button onClick={() => router.push('/dashboard')} className="text-sm text-slate-500 hover:text-slate-700 mb-4">← Back</button>

                <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
                    <h1 className="text-xl font-bold text-slate-900">Move</h1>
                    <p className="text-sm text-slate-500 mt-1">USDT0 between Money ↔ Spot · Plasma · 0.1% fee deducted</p>

                    <div className="grid grid-cols-2 gap-2 mt-6">
                        {(['money-to-spot', 'spot-to-money'] as Direction[]).map((d) => (
                            <button
                                key={d}
                                onClick={() => setDirection(d)}
                                className={`rounded-lg py-3 text-sm font-medium border transition ${direction === d
                                    ? 'bg-emerald-600 text-white border-emerald-600'
                                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'}`}
                            >
                                {d === 'money-to-spot' ? 'Money → Spot' : 'Spot → Money'}
                            </button>
                        ))}
                    </div>

                    <label className="block text-sm font-medium text-slate-700 mt-4 mb-1">Amount (USDT0)</label>
                    <input
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        placeholder="10"
                        inputMode="decimal"
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-black"
                    />

                    <button
                        onClick={handleMove}
                        disabled={isSending}
                        className="w-full mt-6 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white font-semibold rounded-lg py-3 transition"
                    >
                        {isSending ? 'Moving…' : 'Move'}
                    </button>

                    {shown && <div className="mt-4 bg-red-50 text-red-600 text-sm rounded-lg p-3 break-words">{shown}</div>}
                    {result && (
                        <div className="mt-4 bg-emerald-50 text-emerald-700 text-sm rounded-lg p-3">
                            <p className="font-semibold">Moved ✓</p>
                            <a href={getExplorerTxUrl(56, result.hash)} target="_blank" rel="noreferrer" className="font-mono text-xs underline break-all">{result.hash}</a>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
