'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { signedFetch } from '@/lib/api/signedFetch';
import { API_BASE } from '@/lib/api/config';

// Get Paid (freelancer side): create an inbound payment request that a foreign
// client pays via Peer/ZKP2P, and see the resulting requests. Mirrors the
// redesigned app flow so we can drive the whole thing from the POC:
//   currency + amount → per-provider quote (pick a rail) → recipient (saved or
//   inline) → purpose → create → shareable pay-link + downloadable invoice.
// Payer side lives at /getpaid/pay/[token]; invoice PDF is a public backend URL.

type Currency = {
    code: string;
    symbol: string;
    name: string;
    isDefault?: boolean;
    minAmount: string;
    maxAmount: string;
};

type PlatformQuote = {
    platform: string;
    displayName: string;
    netReceive?: string;
    rate?: string;
};

type Address = {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
};

type Recipient = {
    _id: string;
    name: string;
    email?: string;
    phone?: string;
    address?: Address;
    requestsCount?: number;
    lastUsedAt?: string;
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
    invoiceToken?: string;
    invoiceUrl?: string;
    invoiceNumber?: string;
    checkoutUrl?: string;
    expiresAt?: string;
    quote?: { netReceiveAmount?: string };
    createdAt: string;
};

type Counts = { all: number; paid: number; unpaid: number; expired: number };

const CYCLES = ['weekly', 'monthly', 'quarterly', 'custom'];
const HISTORY_TABS: Array<keyof Counts> = ['all', 'paid', 'unpaid', 'expired'];

const STATUS_COLOR: Record<string, string> = {
    awaiting_payment: 'bg-amber-100 text-amber-700',
    paying: 'bg-blue-100 text-blue-700',
    proof_submitted: 'bg-blue-100 text-blue-700',
    escrow_released: 'bg-blue-100 text-blue-700',
    bridging: 'bg-blue-100 text-blue-700',
    settled: 'bg-emerald-100 text-emerald-700',
    failed: 'bg-red-100 text-red-700',
    expired: 'bg-slate-100 text-slate-500',
};

// Public invoice PDF lives on the backend (no auth); build a direct link so it
// resolves against whichever API the POC points at (local vs staging).
const invoiceLink = (token?: string) =>
    token ? `${API_BASE}/getpaid/invoice/${token}` : undefined;

export default function GetPaidPage() {
    const router = useRouter();
    const [tab, setTab] = useState<'create' | 'requests'>('create');

    // ---- reference data ----
    const [currencies, setCurrencies] = useState<Currency[]>([]);
    const [purposes, setPurposes] = useState<string[]>([]);
    const [recipients, setRecipients] = useState<Recipient[]>([]);

    // ---- form ----
    const [currency, setCurrency] = useState('USD');
    const [amount, setAmount] = useState('100');
    const [platforms, setPlatforms] = useState<PlatformQuote[]>([]);
    const [platform, setPlatform] = useState('');
    const [quoting, setQuoting] = useState(false);

    const [recipientMode, setRecipientMode] = useState<'saved' | 'new'>('new');
    const [recipientId, setRecipientId] = useState('');
    const [rName, setRName] = useState('');
    const [rEmail, setREmail] = useState('');
    const [rPhone, setRPhone] = useState('');
    const [rAddr, setRAddr] = useState<Address>({});
    const [saveRecipient, setSaveRecipient] = useState(true);

    const [purpose, setPurpose] = useState('');
    const [type, setType] = useState<'one-time' | 'recurring'>('one-time');
    const [billingCycle, setBillingCycle] = useState('monthly');
    const [customIntervalDays, setCustomIntervalDays] = useState('30');
    const [note, setNote] = useState('');
    const [agreedToTerms, setAgreedToTerms] = useState(false);

    const [creating, setCreating] = useState(false);
    const [error, setError] = useState('');
    const [created, setCreated] = useState<GetPaidRequest | null>(null);
    const [copied, setCopied] = useState(false);

    // ---- history ----
    const [historyTab, setHistoryTab] = useState<keyof Counts>('all');
    const [counts, setCounts] = useState<Counts>({ all: 0, paid: 0, unpaid: 0, expired: 0 });
    const [requests, setRequests] = useState<GetPaidRequest[]>([]);
    const [loading, setLoading] = useState(true);

    const selectedCurrency = currencies.find((c) => c.code === currency);

    const invalidateQuote = () => { setPlatforms([]); setPlatform(''); };

    const fetchRequests = useCallback(async (which: keyof Counts) => {
        setLoading(true);
        try {
            const res = await signedFetch(`/getpaid/requests?status=${which}&page=1&limit=50`, { auth: true });
            if (res.ok) {
                const d = await res.json();
                setRequests(d.requests ?? []);
                if (d.counts) setCounts(d.counts);
            }
        } catch (e) {
            console.error('fetch getpaid requests failed', e);
        } finally {
            setLoading(false);
        }
    }, []);

    const fetchRecipients = useCallback(async () => {
        try {
            const res = await signedFetch('/getpaid/recipients', { auth: true });
            if (res.ok) setRecipients(await res.json());
        } catch { /* non-fatal */ }
    }, []);

    // Initial load: currencies, purposes, recipients, and the first history tab.
    useEffect(() => {
        (async () => {
            try {
                const res = await signedFetch('/getpaid/currencies', { auth: true });
                if (res.ok) {
                    const list: Currency[] = await res.json();
                    setCurrencies(list);
                    const def = list.find((c) => c.isDefault) ?? list[0];
                    if (def) setCurrency(def.code);
                }
            } catch { /* non-fatal */ }
            try {
                const res = await signedFetch('/getpaid/purposes', { auth: true });
                if (res.ok) {
                    const d = await res.json();
                    setPurposes([...(d.defaults ?? []), ...(d.custom ?? [])]);
                }
            } catch { /* non-fatal */ }
        })();
        fetchRecipients();
        fetchRequests('all');
    }, [fetchRecipients, fetchRequests]);

    const getQuote = async () => {
        setError('');
        invalidateQuote();
        if (!amount || Number(amount) <= 0) { setError('Enter an amount'); return; }
        setQuoting(true);
        try {
            const res = await signedFetch('/getpaid/quote', {
                method: 'POST',
                auth: true,
                json: { amount, currency },
            });
            if (!res.ok) throw new Error((await res.json()).message || 'Quote failed');
            const d = await res.json();
            const list: PlatformQuote[] = d.platforms ?? [];
            setPlatforms(list);
            if (list.length === 0) setError('No providers can fill this amount right now');
            else setPlatform(list[0].platform); // preselect the best
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Something went wrong');
        } finally {
            setQuoting(false);
        }
    };

    const resetForm = () => {
        setPurpose(''); setNote(''); invalidateQuote();
        setRName(''); setREmail(''); setRPhone(''); setRAddr({}); setRecipientId('');
        setAgreedToTerms(false);
    };

    const handleCreate = async () => {
        setError('');
        setCreated(null);
        if (!platform) { setError('Get a quote and pick a provider'); return; }
        if (!purpose) { setError('Pick a payment purpose'); return; }
        if (recipientMode === 'saved' && !recipientId) { setError('Choose a saved client'); return; }
        if (recipientMode === 'new' && !rName) { setError('Enter the client’s name'); return; }
        if (!agreedToTerms) { setError('You must agree to the terms'); return; }
        setCreating(true);
        try {
            // Optionally persist an inline recipient first so it becomes reusable.
            let useRecipientId = recipientMode === 'saved' ? recipientId : '';
            let inlineRecipient: Record<string, unknown> | undefined;
            if (recipientMode === 'new') {
                const address = Object.values(rAddr).some(Boolean) ? rAddr : undefined;
                const body = { name: rName, email: rEmail || undefined, phone: rPhone || undefined, address };
                if (saveRecipient) {
                    const rres = await signedFetch('/getpaid/recipients', { method: 'POST', auth: true, json: body });
                    if (rres.ok) { useRecipientId = (await rres.json())._id; }
                    else inlineRecipient = body; // fall back to inline if save failed
                } else {
                    inlineRecipient = body;
                }
            }

            const res = await signedFetch('/getpaid/requests', {
                method: 'POST',
                auth: true,
                json: {
                    amount,
                    currency,
                    platform,
                    purpose,
                    ...(useRecipientId ? { recipientId: useRecipientId } : {}),
                    ...(inlineRecipient ? { recipient: inlineRecipient } : {}),
                    agreedToTerms,
                    type,
                    ...(type === 'recurring'
                        ? { billingCycle, ...(billingCycle === 'custom' ? { customIntervalDays: Number(customIntervalDays) } : {}) }
                        : {}),
                    note: note || undefined,
                },
            });
            if (!res.ok) throw new Error((await res.json()).message || 'Create failed');
            const doc: GetPaidRequest = await res.json();
            setCreated(doc);
            resetForm();
            fetchRecipients();
            fetchRequests(historyTab);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Something went wrong');
        } finally {
            setCreating(false);
        }
    };

    const payUrl = (r: GetPaidRequest) =>
        r.payLinkUrl || `${window.location.origin}/getpaid/pay/${r.payLinkToken}`;

    const copyLink = async (url: string) => {
        try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* */ }
    };

    const sym = selectedCurrency?.symbol ?? '';

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
                    <button onClick={() => { setTab('requests'); fetchRequests(historyTab); }}
                        className={`px-6 py-3 text-sm font-medium border-b-2 transition ${tab === 'requests' ? 'border-emerald-500 text-emerald-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
                        My Requests
                    </button>
                </div>

                {tab === 'create' && (
                    <div className="space-y-4">
                        {created && (
                            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
                                <p className="font-semibold text-emerald-800 mb-2">
                                    Request created — share this link with {created.payerName}
                                    {created.invoiceNumber ? ` · ${created.invoiceNumber}` : ''}
                                </p>
                                <div className="flex items-center gap-2">
                                    <input readOnly value={payUrl(created)} className="flex-1 text-xs bg-white border border-emerald-200 rounded px-2 py-1.5 text-slate-700" />
                                    <button onClick={() => copyLink(payUrl(created))} className="text-xs bg-emerald-600 text-white rounded px-3 py-1.5">{copied ? 'Copied' : 'Copy'}</button>
                                </div>
                                <div className="mt-2 flex items-center gap-4">
                                    <button onClick={() => router.push(`/getpaid/pay/${created.payLinkToken}`)} className="text-xs text-emerald-700 underline">Open payer view →</button>
                                    {invoiceLink(created.invoiceToken) && (
                                        <a href={invoiceLink(created.invoiceToken)} target="_blank" rel="noreferrer" className="text-xs text-emerald-700 underline">Download invoice ↓</a>
                                    )}
                                </div>
                            </div>
                        )}

                        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 space-y-4">
                            {/* amount + currency */}
                            <div className="grid grid-cols-2 gap-3">
                                <Field label="Currency">
                                    <select value={currency} onChange={(e) => { setCurrency(e.target.value); invalidateQuote(); }} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500">
                                        {currencies.length === 0 && <option value="USD">USD</option>}
                                        {currencies.map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
                                    </select>
                                </Field>
                                <Field label={`Amount${selectedCurrency ? ` (${selectedCurrency.minAmount}–${selectedCurrency.maxAmount})` : ''}`}>
                                    <input type="number" value={amount} onChange={(e) => { setAmount(e.target.value); invalidateQuote(); }} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500" />
                                </Field>
                            </div>

                            <button onClick={getQuote} disabled={quoting} className="w-full text-sm border border-slate-300 rounded-lg py-2 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                                {quoting ? 'Fetching providers…' : 'Get providers & rates'}
                            </button>

                            {/* provider cards */}
                            {platforms.length > 0 && (
                                <div>
                                    <span className="text-xs font-medium text-slate-500 mb-1 block">Provider (client pays from)</span>
                                    <div className="space-y-2">
                                        {platforms.map((p) => (
                                            <button key={p.platform} onClick={() => setPlatform(p.platform)}
                                                className={`w-full flex items-center justify-between rounded-lg border px-3 py-2 text-left transition ${platform === p.platform ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200 hover:border-slate-300'}`}>
                                                <span className="text-sm font-medium text-slate-900">{p.displayName}</span>
                                                <span className="text-right">
                                                    <span className="block text-sm font-semibold text-slate-900">{p.netReceive ?? '—'} USDC</span>
                                                    {p.rate && <span className="block text-[11px] text-slate-500">rate {p.rate}</span>}
                                                </span>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* recipient */}
                            <div className="border-t border-slate-100 pt-4">
                                <div className="flex items-center justify-between mb-2">
                                    <span className="text-xs font-medium text-slate-500">Client (who is paying you)</span>
                                    <div className="flex gap-1 text-xs">
                                        <button onClick={() => setRecipientMode('new')} className={`px-2 py-0.5 rounded ${recipientMode === 'new' ? 'bg-slate-800 text-white' : 'text-slate-500'}`}>New</button>
                                        <button onClick={() => setRecipientMode('saved')} className={`px-2 py-0.5 rounded ${recipientMode === 'saved' ? 'bg-slate-800 text-white' : 'text-slate-500'}`}>Saved</button>
                                    </div>
                                </div>

                                {recipientMode === 'saved' ? (
                                    <select value={recipientId} onChange={(e) => setRecipientId(e.target.value)} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500">
                                        <option value="">Select a saved client…</option>
                                        {recipients.map((r) => <option key={r._id} value={r._id}>{r.name}{r.email ? ` (${r.email})` : ''}</option>)}
                                    </select>
                                ) : (
                                    <div className="space-y-3">
                                        <input value={rName} onChange={(e) => setRName(e.target.value)} placeholder="Client name (required)" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500" />
                                        <div className="grid grid-cols-2 gap-3">
                                            <input value={rEmail} onChange={(e) => setREmail(e.target.value)} placeholder="Email (optional)" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500" />
                                            <input value={rPhone} onChange={(e) => setRPhone(e.target.value)} placeholder="Phone (optional)" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500" />
                                        </div>
                                        <div className="grid grid-cols-2 gap-3">
                                            <input value={rAddr.line1 ?? ''} onChange={(e) => setRAddr({ ...rAddr, line1: e.target.value })} placeholder="Address line 1" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500" />
                                            <input value={rAddr.line2 ?? ''} onChange={(e) => setRAddr({ ...rAddr, line2: e.target.value })} placeholder="Address line 2" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500" />
                                            <input value={rAddr.city ?? ''} onChange={(e) => setRAddr({ ...rAddr, city: e.target.value })} placeholder="City" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500" />
                                            <input value={rAddr.state ?? ''} onChange={(e) => setRAddr({ ...rAddr, state: e.target.value })} placeholder="State / region" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500" />
                                            <input value={rAddr.postalCode ?? ''} onChange={(e) => setRAddr({ ...rAddr, postalCode: e.target.value })} placeholder="Postal code" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500" />
                                            <input value={rAddr.country ?? ''} onChange={(e) => setRAddr({ ...rAddr, country: e.target.value })} placeholder="Country" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500" />
                                        </div>
                                        <label className="flex items-center gap-2 text-xs text-slate-600">
                                            <input type="checkbox" checked={saveRecipient} onChange={(e) => setSaveRecipient(e.target.checked)} />
                                            Save this client for next time
                                        </label>
                                    </div>
                                )}
                            </div>

                            {/* purpose */}
                            <Field label="Payment purpose">
                                <input list="purposes" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="UI Design Services" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500" />
                                <datalist id="purposes">{purposes.map((p) => <option key={p} value={p} />)}</datalist>
                            </Field>

                            {/* type */}
                            <div className="grid grid-cols-2 gap-3">
                                <Field label="Type">
                                    <select value={type} onChange={(e) => setType(e.target.value as 'one-time' | 'recurring')} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500">
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
                            {type === 'recurring' && billingCycle === 'custom' && (
                                <Field label="Custom interval (days)">
                                    <input type="number" value={customIntervalDays} onChange={(e) => setCustomIntervalDays(e.target.value)} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500" />
                                </Field>
                            )}

                            <Field label="Note (optional)">
                                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Contract work for Jan 2026" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500" />
                            </Field>

                            <label className="flex items-center gap-2 text-sm text-slate-700">
                                <input type="checkbox" checked={agreedToTerms} onChange={(e) => setAgreedToTerms(e.target.checked)} />
                                I agree to the Get Paid terms
                            </label>

                            {error && <p className="text-sm text-red-600">{error}</p>}

                            <button onClick={handleCreate} disabled={creating} className="w-full bg-emerald-600 text-white rounded-lg py-2.5 font-medium hover:bg-emerald-700 disabled:opacity-50">
                                {creating ? 'Creating…' : `Create request${platform ? ` · ${sym}${amount}` : ''}`}
                            </button>
                        </div>
                    </div>
                )}

                {tab === 'requests' && (
                    <div>
                        {/* history tabs with counts */}
                        <div className="flex gap-2 mb-4">
                            {HISTORY_TABS.map((t) => (
                                <button key={t} onClick={() => { setHistoryTab(t); fetchRequests(t); }}
                                    className={`px-3 py-1.5 rounded-full text-xs font-medium capitalize transition ${historyTab === t ? 'bg-slate-800 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:border-slate-300'}`}>
                                    {t} <span className="opacity-70">({counts[t] ?? 0})</span>
                                </button>
                            ))}
                        </div>

                        {loading ? (
                            <div className="py-12 text-center text-slate-500">Loading…</div>
                        ) : requests.length === 0 ? (
                            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-12 text-center text-slate-500">No requests here</div>
                        ) : (
                            <div className="space-y-3">
                                {requests.map((r) => (
                                    <div key={r._id} className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <p className="font-semibold text-slate-900">{r.payerName} · {r.purpose}</p>
                                                <p className="text-xs text-slate-500">{r.sourceAmount} {r.sourceCurrency} via {r.sourceRail} → {r.quote?.netReceiveAmount ?? '—'} {r.receiveTokenSymbol}{r.invoiceNumber ? ` · ${r.invoiceNumber}` : ''}</p>
                                            </div>
                                            <span className={`text-xs px-2 py-1 rounded-full font-medium ${STATUS_COLOR[r.status] ?? 'bg-slate-100 text-slate-500'}`}>{r.status}</span>
                                        </div>
                                        <div className="mt-3 flex flex-wrap items-center gap-2">
                                            {['awaiting_payment', 'paying', 'proof_submitted', 'escrow_released', 'bridging'].includes(r.status) && (
                                                <>
                                                    <input readOnly value={payUrl(r)} className="flex-1 min-w-[8rem] text-xs bg-slate-50 border border-slate-200 rounded px-2 py-1.5 text-slate-600" />
                                                    <button onClick={() => copyLink(payUrl(r))} className="text-xs bg-slate-800 text-white rounded px-3 py-1.5">Copy</button>
                                                    <button onClick={() => router.push(`/getpaid/pay/${r.payLinkToken}`)} className="text-xs text-emerald-700 underline whitespace-nowrap">pay →</button>
                                                </>
                                            )}
                                            {invoiceLink(r.invoiceToken) && (
                                                <a href={invoiceLink(r.invoiceToken)} target="_blank" rel="noreferrer" className="text-xs text-slate-600 underline whitespace-nowrap">invoice ↓</a>
                                            )}
                                        </div>
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
