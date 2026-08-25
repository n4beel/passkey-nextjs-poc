'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useRhinestoneTransfer } from '@/hooks/useRhinestoneTransfer';
import { getExplorerTxUrl } from '@/lib/explorer';

/**
 * Isolated test screen for the Model A server-prepared Money-wallet payment
 * (handle→handle or pay-by-address). Backend prepares the calls; we submit one
 * gasless Plasma user-op with the passkey; backend records it.
 */
export default function PayPage() {
    const router = useRouter();
    const { payViaBackend, isSending, error } = useRhinestoneTransfer();

    const [accessToken, setAccessToken] = useState<string | null>(null);
    const [recipient, setRecipient] = useState('');
    const [amount, setAmount] = useState('');
    const [note, setNote] = useState('');
    const [result, setResult] = useState<{ hash: string } | null>(null);
    const [localError, setLocalError] = useState<string | null>(null);

    useEffect(() => {
        const token = localStorage.getItem('accessToken');
        if (!token) {
            router.push('/');
            return;
        }
        setAccessToken(token);
    }, [router]);

    const isAddress = recipient.trim().startsWith('0x');

    const handlePay = async () => {
        setResult(null);
        setLocalError(null);
        if (!accessToken) return;
        const r = recipient.trim();
        if (!r || !amount) {
            setLocalError('Recipient and amount are required');
            return;
        }
        try {
            const res = await payViaBackend({
                accessToken,
                recipient: isAddress
                    ? { address: r }
                    : { handle: r.replace(/^@/, '') },
                amount: amount.trim(),
                note: note.trim() || undefined,
            });
            setResult(res);
        } catch (e: any) {
            setLocalError(e?.message || 'Payment failed');
        }
    };

    const shown = localError || error;

    return (
        <div className="min-h-screen bg-slate-50 p-6">
            <div className="max-w-md mx-auto">
                <button
                    onClick={() => router.push('/dashboard')}
                    className="text-sm text-slate-500 hover:text-slate-700 mb-4"
                >
                    ← Back
                </button>

                <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
                    <h1 className="text-xl font-bold text-slate-900">Pay (Money wallet)</h1>
                    <p className="text-sm text-slate-500 mt-1">
                        USDT0 on Plasma · gasless · fee-free peer payment
                    </p>

                    <label className="block text-sm font-medium text-slate-700 mt-6 mb-1">
                        Recipient
                    </label>
                    <input
                        value={recipient}
                        onChange={(e) => setRecipient(e.target.value)}
                        placeholder="@handle or 0x address"
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-black"
                    />
                    <p className="text-xs text-slate-400 mt-1">
                        {recipient.trim()
                            ? isAddress
                                ? 'Paying a raw Plasma address'
                                : 'Resolving handle → Money wallet'
                            : 'Enter a HandlePay handle or a Plasma address'}
                    </p>

                    <label className="block text-sm font-medium text-slate-700 mt-4 mb-1">
                        Amount (USDT0)
                    </label>
                    <input
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        placeholder="0.05"
                        inputMode="decimal"
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-black"
                    />

                    <label className="block text-sm font-medium text-slate-700 mt-4 mb-1">
                        Note (optional)
                    </label>
                    <input
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="lunch"
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-black"
                    />

                    <button
                        onClick={handlePay}
                        disabled={isSending}
                        className="w-full mt-6 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white font-semibold rounded-lg py-3 transition"
                    >
                        {isSending ? 'Paying…' : 'Pay'}
                    </button>

                    {shown && (
                        <div className="mt-4 bg-red-50 text-red-600 text-sm rounded-lg p-3 break-words">
                            {shown}
                        </div>
                    )}

                    {result && (
                        <div className="mt-4 bg-emerald-50 text-emerald-700 text-sm rounded-lg p-3">
                            <p className="font-semibold">Paid ✓</p>
                            <a
                                href={getExplorerTxUrl(56, result.hash)}
                                target="_blank"
                                rel="noreferrer"
                                className="font-mono text-xs underline break-all"
                            >
                                {result.hash}
                            </a>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
