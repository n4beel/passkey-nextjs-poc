'use client';

import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { signedFetch } from '@/lib/api/signedFetch';

// Payer view (public): the client opens the shared link, sees what to pay, and is
// sent to Peer's hosted checkout to actually pay (fiat via Wise → the ZK proof →
// USDC settles to the freelancer's Base address). Public routes — no auth,
// signature skipped.
//
// Settlement is driven by Peer's webhook to the backend, so this page just opens
// the checkout and polls our status endpoint until the request reaches a terminal
// state. No on-chain params or manual steps are handled in the browser.

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
    checkoutUrl?: string;
    quote?: {
        netReceiveAmount?: string;
        feeTotalUsd?: string;
        rate?: string;
    };
};

const STATUS_LABEL: Record<string, string> = {
    awaiting_payment: 'Awaiting payment',
    paying: 'Payment in progress…',
    proof_submitted: 'Verifying payment…',
    escrow_released: 'Funds released…',
    bridging: 'Settling to wallet…',
    settled: 'Paid ✓',
    failed: 'Failed',
    expired: 'Expired',
};

const TERMINAL = new Set(['settled', 'failed', 'expired']);

export default function PayPage() {
    // useSearchParams must sit under a Suspense boundary in the App Router.
    return (
        <Suspense fallback={<Centered>Loading…</Centered>}>
            <PayInner />
        </Suspense>
    );
}

function PayInner() {
    const { token } = useParams<{ token: string }>();
    const search = useSearchParams();
    const returned = search.get('checkout'); // 'success' | 'cancel' after Peer redirects back
    const [ctx, setCtx] = useState<PayCtx | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [redirecting, setRedirecting] = useState(false);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const load = useCallback(async () => {
        setError('');
        try {
            const res = await signedFetch(`/getpaid/pay/${token}`, { auth: false });
            if (!res.ok) throw new Error((await res.json()).message || 'Link not found');
            const data: PayCtx = await res.json();
            setCtx(data);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, [token]);

    useEffect(() => { load(); }, [load]);

    // Poll for settlement while the request is mid-flight. Peer settles the payment
    // then calls our webhook; this surfaces that to the client without a refresh.
    useEffect(() => {
        const status = ctx?.status;
        if (!status || TERMINAL.has(status)) {
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
            return;
        }
        if (!pollRef.current) {
            pollRef.current = setInterval(load, 4000);
        }
        return () => {
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        };
    }, [ctx?.status, load]);

    const payViaPeer = () => {
        if (!ctx?.checkoutUrl) return;
        setRedirecting(true);
        window.location.href = ctx.checkoutUrl;
    };

    if (loading) return <Centered>Loading…</Centered>;
    if (error && !ctx) return <Centered><span className="text-red-600">{error}</span></Centered>;
    if (!ctx) return <Centered>Not found</Centered>;

    const settled = ctx.status === 'settled';
    const terminal = TERMINAL.has(ctx.status);

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
                    <div className="flex justify-between"><span className="text-slate-400">Rate</span><span>{ctx.quote?.rate ?? '—'}</span></div>
                </div>

                <div className={`text-center text-sm rounded-lg py-2 ${settled ? 'bg-emerald-500/20 text-emerald-300' : ctx.status === 'failed' || ctx.status === 'expired' ? 'bg-red-500/20 text-red-300' : 'bg-slate-700 text-slate-300'}`}>
                    {STATUS_LABEL[ctx.status] ?? ctx.status}
                </div>

                {returned === 'cancel' && !terminal && (
                    <p className="text-center text-xs text-amber-300">Checkout cancelled — you can try again.</p>
                )}

                {ctx.payable && (
                    <button
                        className="w-full bg-emerald-500 text-slate-900 font-semibold rounded-lg py-3 disabled:opacity-60"
                        onClick={payViaPeer}
                        disabled={redirecting}
                    >
                        {redirecting ? 'Opening checkout…' : 'Pay securely via Peer'}
                    </button>
                )}

                {!ctx.payable && !terminal && (
                    <p className="text-center text-sm text-slate-400">This payment is already in progress.</p>
                )}

                {settled && (
                    <p className="text-center text-sm text-emerald-300">Payment complete. @{ctx.requesterUsername} has been paid.</p>
                )}

                {error && <p className="text-sm text-red-400 text-center">{error}</p>}

                {!terminal && (
                    <button onClick={load} className="w-full text-xs text-slate-400 underline">Refresh status</button>
                )}
            </div>
        </div>
    );
}

function Centered({ children }: { children: React.ReactNode }) {
    return <div className="min-h-screen bg-slate-900 text-slate-300 flex items-center justify-center">{children}</div>;
}
