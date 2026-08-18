'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { signedFetch } from '@/lib/api/signedFetch';

// Payer view (public): the client opens the shared link, sees what to pay, and
// completes the onramp via Peer. Public routes — no auth, signature skipped.
//
// The real signalIntent + Wise payment + ZK proof run in Peer's SDK/PeerAuth on
// this device (a follow-up: wire @zkp2p/sdk in the browser). For now this page
// resolves the live quote + signal params and lets us drive POST /signaled with
// a real intent hash, so the backend paying→settled path is fully exercisable.

type PayCtx = {
    requesterUsername: string;
    payerName: string;
    purpose: string;
    sourceAmount: string;
    sourceCurrency: string;
    sourceRail: string;
    receiveTokenSymbol: string;
    note?: string;
    status: string;
    payable: boolean;
    quote?: {
        netReceiveAmount?: string;
        feeTotalUsd?: string;
        rate?: string;
        source?: string;
        quoteExpiresAt?: string;
    };
    signal?: {
        depositId?: number;
        amount?: string;
        toAddress?: string;
        processorName?: string;
        payeeDetails?: string;
        fiatCurrencyCode?: string;
        conversionRate?: string;
        escrowAddress?: string;
        orchestratorAddress?: string;
        referrerFeeConfig?: { recipient: string; feeBps: number };
    };
};

const STATUS_LABEL: Record<string, string> = {
    awaiting_payment: 'Awaiting payment',
    paying: 'Payment in progress…',
    settled: 'Paid ✓',
    failed: 'Failed',
    expired: 'Expired',
};

export default function PayPage() {
    const { token } = useParams<{ token: string }>();
    const [ctx, setCtx] = useState<PayCtx | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [intentHash, setIntentHash] = useState('');
    const [depositId, setDepositId] = useState('');
    const [busy, setBusy] = useState(false);
    const [showSignal, setShowSignal] = useState(false);

    const load = useCallback(async () => {
        setError('');
        try {
            const res = await signedFetch(`/getpaid/pay/${token}`, { auth: false });
            if (!res.ok) throw new Error((await res.json()).message || 'Link not found');
            const data: PayCtx = await res.json();
            setCtx(data);
            if (data.signal?.depositId != null) setDepositId(String(data.signal.depositId));
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, [token]);

    useEffect(() => { load(); }, [load]);

    const reportSignaled = async () => {
        if (!intentHash) { setError('Paste the intent hash returned by signalIntent'); return; }
        setBusy(true); setError('');
        try {
            const res = await signedFetch(`/getpaid/pay/${token}/signaled`, {
                method: 'POST',
                auth: false,
                json: { intentHash, depositId: depositId ? Number(depositId) : undefined },
            });
            if (!res.ok) throw new Error((await res.json()).message || 'Failed to report');
            await load();
        } catch (e: any) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };

    if (loading) return <Centered>Loading…</Centered>;
    if (error && !ctx) return <Centered><span className="text-red-600">{error}</span></Centered>;
    if (!ctx) return <Centered>Not found</Centered>;

    const settled = ctx.status === 'settled';

    return (
        <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center p-4">
            <div className="w-full max-w-md bg-slate-800 rounded-2xl p-6 space-y-5">
                <div className="text-center">
                    <p className="text-slate-400 text-sm">Pay @{ctx.requesterUsername}</p>
                    <p className="text-3xl font-bold mt-1">{ctx.sourceAmount} {ctx.sourceCurrency}</p>
                    <p className="text-slate-400 text-sm mt-1">for {ctx.purpose} · via {ctx.sourceRail}</p>
                </div>

                <div className="bg-slate-900/60 rounded-xl p-4 text-sm space-y-1">
                    <div className="flex justify-between"><span className="text-slate-400">They receive</span><span className="font-semibold">{ctx.quote?.netReceiveAmount ?? '—'} {ctx.receiveTokenSymbol}</span></div>
                    <div className="flex justify-between"><span className="text-slate-400">Total fees</span><span>${ctx.quote?.feeTotalUsd ?? '—'}</span></div>
                    <div className="flex justify-between"><span className="text-slate-400">Rate · source</span><span>{ctx.quote?.rate ?? '—'} · {ctx.quote?.source ?? '—'}</span></div>
                </div>

                <div className={`text-center text-sm rounded-lg py-2 ${settled ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-700 text-slate-300'}`}>
                    {STATUS_LABEL[ctx.status] ?? ctx.status}
                </div>

                {ctx.payable && !settled && ctx.signal && (
                    <div className="space-y-3">
                        <button
                            className="w-full bg-emerald-500 text-slate-900 font-semibold rounded-lg py-3"
                            onClick={() => alert('Real signalIntent runs Peer\'s SDK + PeerAuth here (browser wiring TODO). For now, complete it in Peer and paste the intent hash below.')}
                        >
                            Pay securely via Peer
                        </button>

                        <button onClick={() => setShowSignal((s) => !s)} className="text-xs text-slate-400 underline">
                            {showSignal ? 'Hide' : 'Show'} signalIntent params
                        </button>
                        {showSignal && (
                            <pre className="text-[10px] bg-slate-900 rounded-lg p-3 overflow-x-auto text-slate-300">{JSON.stringify(ctx.signal, null, 2)}</pre>
                        )}

                        <div className="border-t border-slate-700 pt-3 space-y-2">
                            <p className="text-xs text-slate-400">After signalling in Peer, report the intent so settlement can track it:</p>
                            <input value={intentHash} onChange={(e) => setIntentHash(e.target.value)} placeholder="intentHash (0x…)" className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs" />
                            <input value={depositId} onChange={(e) => setDepositId(e.target.value)} placeholder="depositId" className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs" />
                            <button onClick={reportSignaled} disabled={busy} className="w-full bg-slate-700 rounded py-2 text-sm disabled:opacity-50">{busy ? 'Reporting…' : 'Report signalled intent'}</button>
                        </div>
                    </div>
                )}

                {!ctx.payable && !settled && (
                    <p className="text-center text-sm text-amber-300">Not payable right now (no live liquidity or already in progress).</p>
                )}

                {error && <p className="text-sm text-red-400 text-center">{error}</p>}

                <button onClick={load} className="w-full text-xs text-slate-400 underline">Refresh status</button>
            </div>
        </div>
    );
}

function Centered({ children }: { children: React.ReactNode }) {
    return <div className="min-h-screen bg-slate-900 text-slate-300 flex items-center justify-center">{children}</div>;
}
