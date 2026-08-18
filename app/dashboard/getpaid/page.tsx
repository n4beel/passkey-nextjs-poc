'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { signedFetch } from '@/lib/api/signedFetch';

// Get Paid (freelancer side): create an inbound payment request that a foreign
// client pays via Peer/ZKP2P, and see the resulting requests. Mirrors the real
// app so we can drive the whole flow from the POC. Payer side lives at
// /getpaid/pay/[token].

type Quote = {
    source: 'peer' | 'placeholder';
    sourceAmount: string;
    sourceCurrency: string;
    receiveTokenSymbol: string;
    netReceiveAmount: string;
    rate: string;
    feeZkp2pBps: number;
    feeBridgeBps: number;
    feeHandleBps: number;
    feeTotalUsd?: string;
};

type GetPaidRequest = {
    _id: string;
    payerName: string;
    purpose: string;
    sourceAmount: string;
    sourceCurrency: string;
    sourceRail: string;
    receiveTokenSymbol: string;
    type: string;
    status: string;
    payLinkToken: string;
    payLinkUrl?: string;
    quote?: { netReceiveAmount?: string };
    createdAt: string;
};

const RAILS = ['wise', 'revolut', 'venmo', 'cashapp', 'paypal', 'zelle'];
const CYCLES = ['weekly', 'monthly', 'quarterly', 'custom'];

const STATUS_COLOR: Record<string, string> = {
    awaiting_payment: 'bg-amber-100 text-amber-700',
    paying: 'bg-blue-100 text-blue-700',
    settled: 'bg-emerald-100 text-emerald-700',
    failed: 'bg-red-100 text-red-700',
    expired: 'bg-slate-100 text-slate-500',
};

export default function GetPaidPage() {
    const router = useRouter();
    const [tab, setTab] = useState<'create' | 'requests'>('create');

    // form
    const [payerName, setPayerName] = useState('');
    const [purpose, setPurpose] = useState('');
    const [amount, setAmount] = useState('100');
    const [rail, setRail] = useState('wise');
    const [type, setType] = useState<'one-time' | 'recurring'>('one-time');
    const [billingCycle, setBillingCycle] = useState('monthly');
    const [note, setNote] = useState('');

    const [quote, setQuote] = useState<Quote | null>(null);
    const [quoting, setQuoting] = useState(false);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState('');
    const [created, setCreated] = useState<GetPaidRequest | null>(null);
    const [copied, setCopied] = useState(false);

    // list
    const [requests, setRequests] = useState<GetPaidRequest[]>([]);
    const [loading, setLoading] = useState(true);
    const [purposes, setPurposes] = useState<string[]>([]);

    const fetchRequests = useCallback(async () => {
        setLoading(true);
        try {
            const res = await signedFetch('/getpaid/requests', { auth: true });
            if (res.ok) setRequests(await res.json());
        } catch (e) {
            console.error('fetch getpaid requests failed', e);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchRequests();
        (async () => {
            try {
                const res = await signedFetch('/getpaid/purposes', { auth: true });
                if (res.ok) {
                    const d = await res.json();
                    setPurposes([...(d.defaults ?? []), ...(d.custom ?? [])]);
                }
            } catch { /* non-fatal */ }
        })();
    }, [fetchRequests]);

    const getQuote = async () => {
        setError('');
        setQuote(null);
        if (!amount || Number(amount) <= 0) { setError('Enter an amount'); return; }
        setQuoting(true);
        try {
            const res = await signedFetch('/getpaid/quote', {
                method: 'POST',
                auth: true,
                json: { sourceAmount: amount, sourceRail: rail, sourceCurrency: 'USD' },
            });
            if (!res.ok) throw new Error((await res.json()).message || 'Quote failed');
            setQuote(await res.json());
        } catch (e: any) {
            setError(e.message);
        } finally {
            setQuoting(false);
        }
    };

    const handleCreate = async () => {
        setError('');
        setCreated(null);
        if (!payerName) { setError('Who is sending the money?'); return; }
        if (!purpose) { setError('Pick a payment purpose'); return; }
        if (!amount || Number(amount) <= 0) { setError('Enter an amount'); return; }
        setCreating(true);
        try {
            const res = await signedFetch('/getpaid/requests', {
                method: 'POST',
                auth: true,
                json: {
                    payerName,
                    purpose,
                    sourceAmount: amount,
                    sourceRail: rail,
                    sourceCurrency: 'USD',
                    type,
                    ...(type === 'recurring' ? { billingCycle } : {}),
                    note: note || undefined,
                },
            });
            if (!res.ok) throw new Error((await res.json()).message || 'Create failed');
            const doc: GetPaidRequest = await res.json();
            setCreated(doc);
            setPayerName(''); setPurpose(''); setNote(''); setQuote(null);
            fetchRequests();
        } catch (e: any) {
            setError(e.message);
        } finally {
            setCreating(false);
        }
    };

    const payUrl = (r: GetPaidRequest) =>
        r.payLinkUrl || `${window.location.origin}/getpaid/pay/${r.payLinkToken}`;

    const copyLink = async (url: string) => {
        try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* */ }
    };

    return (
        <div className="min-h-screen bg-slate-50">
            <div className="max-w-2xl mx-auto p-6">
                <div className="flex items-center gap-3 mb-6">
                    <button onClick={() => router.push('/dashboard')} className="text-slate-500 hover:text-slate-700">←</button>
                    <h1 className="text-2xl font-bold text-slate-900">Get Paid</h1>
                </div>

                {/* Tabs */}
                <div className="flex border-b border-slate-200 mb-6">
                    <button onClick={() => setTab('create')}
                        className={`px-6 py-3 text-sm font-medium border-b-2 transition ${tab === 'create' ? 'border-emerald-500 text-emerald-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
                        + New Request
                    </button>
                    <button onClick={() => setTab('requests')}
                        className={`px-6 py-3 text-sm font-medium border-b-2 transition ${tab === 'requests' ? 'border-emerald-500 text-emerald-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
                        My Requests
                    </button>
                </div>

                {tab === 'create' && (
                    <div className="space-y-4">
                        {created && (
                            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
                                <p className="font-semibold text-emerald-800 mb-2">Request created — share this link with {created.payerName}</p>
                                <div className="flex items-center gap-2">
                                    <input readOnly value={payUrl(created)} className="flex-1 text-xs bg-white border border-emerald-200 rounded px-2 py-1.5 text-slate-700" />
                                    <button onClick={() => copyLink(payUrl(created))} className="text-xs bg-emerald-600 text-white rounded px-3 py-1.5">{copied ? 'Copied' : 'Copy'}</button>
                                </div>
                                <button onClick={() => router.push(`/getpaid/pay/${created.payLinkToken}`)} className="mt-2 text-xs text-emerald-700 underline">Open payer view →</button>
                            </div>
                        )}

                        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 space-y-4">
                            <Field label="Who will send the money?">
                                <input value={payerName} onChange={(e) => setPayerName(e.target.value)} placeholder="Simon" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500" />
                            </Field>

                            <Field label="Payment purpose">
                                <input list="purposes" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="UI Design Services" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500" />
                                <datalist id="purposes">{purposes.map((p) => <option key={p} value={p} />)}</datalist>
                            </Field>

                            <div className="grid grid-cols-2 gap-3">
                                <Field label="Amount (USD)">
                                    <input type="number" value={amount} onChange={(e) => { setAmount(e.target.value); setQuote(null); }} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500" />
                                </Field>
                                <Field label="From (rail)">
                                    <select value={rail} onChange={(e) => { setRail(e.target.value); setQuote(null); }} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500">
                                        {RAILS.map((r) => <option key={r} value={r}>{r}</option>)}
                                    </select>
                                </Field>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <Field label="Type">
                                    <select value={type} onChange={(e) => setType(e.target.value as any)} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500">
                                        <option value="one-time">one-time</option>
                                        <option value="recurring">recurring</option>
                                    </select>
                                </Field>
                                {type === 'recurring' && (
                                    <Field label="Billing cycle">
                                        <select value={billingCycle} onChange={(e) => setBillingCycle(e.target.value)} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500">
                                            {CYCLES.map((c) => <option key={c} value={c}>{c}</option>)}
                                        </select>
                                    </Field>
                                )}
                            </div>

                            <Field label="Note (optional)">
                                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Contract work for Jan 2026" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500" />
                            </Field>

                            <button onClick={getQuote} disabled={quoting} className="w-full text-sm border border-slate-300 rounded-lg py-2 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                                {quoting ? 'Quoting…' : 'Preview quote'}
                            </button>

                            {quote && (
                                <div className="bg-slate-50 rounded-lg p-3 text-sm">
                                    <div className="flex justify-between font-semibold text-slate-900">
                                        <span>You receive</span>
                                        <span>{quote.netReceiveAmount} {quote.receiveTokenSymbol}</span>
                                    </div>
                                    <div className="mt-1 text-xs text-slate-500 space-y-0.5">
                                        <div className="flex justify-between"><span>Total fees</span><span>${quote.feeTotalUsd}</span></div>
                                        <div className="flex justify-between"><span>ZKP2P / Handle bps</span><span>{quote.feeZkp2pBps} / {quote.feeHandleBps}</span></div>
                                        <div className="flex justify-between"><span>Rate · source</span><span>{quote.rate} · {quote.source}</span></div>
                                    </div>
                                </div>
                            )}

                            {error && <p className="text-sm text-red-600">{error}</p>}

                            <button onClick={handleCreate} disabled={creating} className="w-full bg-emerald-600 text-white rounded-lg py-2.5 font-medium hover:bg-emerald-700 disabled:opacity-50">
                                {creating ? 'Creating…' : 'Create request'}
                            </button>
                        </div>
                    </div>
                )}

                {tab === 'requests' && (
                    <div>
                        {loading ? (
                            <div className="py-12 text-center text-slate-500">Loading…</div>
                        ) : requests.length === 0 ? (
                            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-12 text-center text-slate-500">No requests yet</div>
                        ) : (
                            <div className="space-y-3">
                                {requests.map((r) => (
                                    <div key={r._id} className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <p className="font-semibold text-slate-900">{r.payerName} · {r.purpose}</p>
                                                <p className="text-xs text-slate-500">{r.sourceAmount} {r.sourceCurrency} via {r.sourceRail} → {r.quote?.netReceiveAmount ?? '—'} {r.receiveTokenSymbol}</p>
                                            </div>
                                            <span className={`text-xs px-2 py-1 rounded-full font-medium ${STATUS_COLOR[r.status] ?? 'bg-slate-100 text-slate-500'}`}>{r.status}</span>
                                        </div>
                                        {r.status === 'awaiting_payment' && (
                                            <div className="mt-3 flex items-center gap-2">
                                                <input readOnly value={payUrl(r)} className="flex-1 text-xs bg-slate-50 border border-slate-200 rounded px-2 py-1.5 text-slate-600" />
                                                <button onClick={() => copyLink(payUrl(r))} className="text-xs bg-slate-800 text-white rounded px-3 py-1.5">Copy</button>
                                                <button onClick={() => router.push(`/getpaid/pay/${r.payLinkToken}`)} className="text-xs text-emerald-700 underline whitespace-nowrap">pay →</button>
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="block">
            <span className="text-xs font-medium text-slate-500 mb-1 block">{label}</span>
            {children}
        </label>
    );
}
