'use client';

import { useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { signedFetch } from '@/lib/api/signedFetch';
import { useRhinestoneTransfer } from '@/hooks/useRhinestoneTransfer';

interface OfframpModalProps {
    isOpen: boolean;
    onClose: () => void;
    token: {
        symbol: string;
        name: string;
        balance: string;
        address: string;
        chainId: number;
        type: 'evm' | 'svm';
    } | null;
    accessToken: string;
    /** Deep-link: open straight to the live status of this existing payment. */
    initialPaymentId?: string;
}

// The compliance-driven flow: CDD (email + OTP + questionnaire, once) → KYC (hosted,
// once) → per-withdrawal amount → bank → KYT purpose → review → status.
type Step =
    | 'check' | 'email' | 'otp' | 'cdd' | 'kyc'
    | 'amount' | 'bank' | 'kyt' | 'review' | 'status';

const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'REFUNDED', 'EXPIRED', 'CANCELLED'];

// Money → PKR is the launch corridor.
const DEST_CURRENCY = 'PKR';
const DEST_RAIL = 'IBFT';
const SOURCE_CURRENCY = 'USDC';
const SOURCE_RAIL = 'BASE';

// CDD questionnaire options (match the designs).
const EMPLOYMENT = ['Employed', 'Self employed', 'Retired', 'Student', 'Unemployed'];
const SOURCE_OF_FUNDS = ['Salary', 'Company funds', 'Ecommerce reseller', 'Gifts', 'Government benefits', 'Inheritance', 'Investments/loans', 'Pensions/retirement', 'Sale of assets/Real Estate'];
const ACCOUNT_PURPOSE = ['Payments to friends or family abroad', 'Personal or living expenses', 'Ecommerce retail payments', 'Investment purposes', 'Operating a company', 'Protect wealth', 'Purchase goods and services', 'Receive payment for freelancing', 'Sale of assets/Real Estate'];
const MONTHLY_RANGES = ['$0-$4,999', '$5,000-$9,999', '$10,000-$49,999', '50,000+'];

const CDD_QUESTIONS = [
    { key: 'employmentStatus', title: 'Employment status', options: EMPLOYMENT, multi: false },
    { key: 'sourceOfFunds', title: 'Source of funds', options: SOURCE_OF_FUNDS, multi: false },
    { key: 'accountPurpose', title: 'Purpose of this account', options: ACCOUNT_PURPOSE, multi: false },
    { key: 'expectedMonthlyPaymentsUsd', title: 'Expected monthly payments (USD)', options: MONTHLY_RANGES, multi: false },
    { key: 'actingOnBehalfOfOther', title: 'Are you receiving or sending funds on behalf of someone other than yourself?', options: ['Yes', 'No'], multi: false },
] as const;

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
    return (
        <div className="flex items-center justify-between gap-3">
            <span className="text-slate-500">{label}</span>
            <span className="text-slate-900 font-medium text-right break-all">{value}</span>
        </div>
    );
}

const fmtN = (n: any) => (n != null && n !== '' ? Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—');

export default function OfframpModal({ isOpen, onClose, token, accessToken, initialPaymentId }: OfframpModalProps) {
    const { fundOfframpViaBackend } = useRhinestoneTransfer();
    const [step, setStep] = useState<Step>('check');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    // Compliance
    const [eligibility, setEligibility] = useState<any>(null);
    const [config, setConfig] = useState<any>(null);
    const [email, setEmail] = useState('');
    const [otpCode, setOtpCode] = useState('');
    const [devCode, setDevCode] = useState('');
    const [cdd, setCdd] = useState<Record<string, string>>({});
    const [cddQ, setCddQ] = useState(0);
    const [kycStatus, setKycStatus] = useState('');
    const [kycLink, setKycLink] = useState('');

    // Withdrawal
    const [amount, setAmount] = useState('');
    const [rate, setRate] = useState<any>(null);
    const [banks, setBanks] = useState<any[]>([]);
    const [selectedBankId, setSelectedBankId] = useState('');
    const [showAddBank, setShowAddBank] = useState(false);
    const [bankForm, setBankForm] = useState({ bankName: '', iban: '', firstName: '', lastName: '' });
    const [purpose, setPurpose] = useState('');
    const [paymentId, setPaymentId] = useState('');
    const [payment, setPayment] = useState<any>(null);

    const call = useCallback(async (path: string, opts: any = {}) => {
        const res = await signedFetch(path, { auth: true, ...opts });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.message || `${path} failed (${res.status})`);
        return data;
    }, []);

    // ── route to the right step based on the backend's compliance state
    const routeFromEligibility = useCallback((el: any) => {
        const next = el?.nextStep;
        if (next === 'email') setStep(el?.emailVerified ? 'cdd' : 'email');
        else if (next === 'cdd') setStep('cdd');
        else if (next === 'kyc') { setKycStatus(el?.kycStatus || ''); setKycLink(el?.kycLink || ''); setStep('kyc'); }
        else setStep('amount'); // withdraw
    }, []);

    // ── on open: load eligibility + config, then route (or deep-link to status)
    useEffect(() => {
        if (!isOpen) return;
        if (initialPaymentId) { setPaymentId(initialPaymentId); setStep('status'); return; }
        (async () => {
            setLoading(true); setError('');
            try {
                const [el, cfg] = await Promise.all([call('/offramp/eligibility'), call('/offramp/config')]);
                setEligibility(el); setConfig(cfg); setEmail(el?.email || '');
                routeFromEligibility(el);
            } catch (e: any) { setError(e.message); } finally { setLoading(false); }
        })();
    }, [isOpen, initialPaymentId, call, routeFromEligibility]);

    // ── status polling (reflects the real Walapay status)
    useEffect(() => {
        if (step !== 'status' || !paymentId) return;
        let active = true;
        const poll = async () => {
            try {
                const p = await call(`/offramp/payment/${paymentId}`);
                if (active) { setPayment(p); if (TERMINAL_STATUSES.includes(String(p.status || '').toUpperCase())) return; }
            } catch { /* keep polling */ }
            if (active) setTimeout(poll, 4000);
        };
        poll();
        return () => { active = false; };
    }, [step, paymentId, call]);

    // ── live rate on amount change (debounced)
    useEffect(() => {
        if (step !== 'amount') return;
        const amt = parseFloat(amount);
        if (!amt || amt <= 0) { setRate(null); return; }
        const t = setTimeout(async () => {
            try {
                const r = await call(`/offramp/rate?sourceCurrency=${SOURCE_CURRENCY}&destinationCurrency=${DEST_CURRENCY}&amount=${amt}&sourceRail=${SOURCE_RAIL}&destinationRail=${DEST_RAIL}`);
                setRate(r);
            } catch { setRate(null); }
        }, 500);
        return () => clearTimeout(t);
    }, [amount, step, call]);

    const wrap = (fn: () => Promise<void>) => async () => {
        setLoading(true); setError('');
        try { await fn(); } catch (e: any) { setError(e.message); } finally { setLoading(false); }
    };

    const sendOtp = wrap(async () => {
        const r = await call('/offramp/email/send-otp', { method: 'POST', json: { email } });
        setDevCode(r?.devCode || ''); setStep('otp');
    });
    const verifyOtp = wrap(async () => {
        await call('/offramp/email/verify-otp', { method: 'POST', json: { code: otpCode } });
        setStep('cdd'); setCddQ(0);
    });
    const answerCdd = (value: string) => {
        const q = CDD_QUESTIONS[cddQ];
        const next = { ...cdd, [q.key]: value };
        setCdd(next);
        if (cddQ < CDD_QUESTIONS.length - 1) { setCddQ(cddQ + 1); return; }
        // last question → save
        (async () => {
            setLoading(true); setError('');
            try {
                await call('/offramp/cdd', { method: 'POST', json: {
                    employmentStatus: next.employmentStatus, sourceOfFunds: next.sourceOfFunds,
                    accountPurpose: next.accountPurpose, expectedMonthlyPaymentsUsd: next.expectedMonthlyPaymentsUsd,
                    actingOnBehalfOfOther: next.actingOnBehalfOfOther === 'Yes',
                } });
                const el = await call('/offramp/eligibility'); setEligibility(el); routeFromEligibility(el);
            } catch (e: any) { setError(e.message); } finally { setLoading(false); }
        })();
    };
    const startKyc = wrap(async () => {
        // register the Walapay customer (hosted KYC) if not already, then open the link
        let link = kycLink;
        if (!eligibility?.kycStatus || eligibility.kycStatus === 'NOT_STARTED' || !link) {
            const r = await call('/offramp/customer', { method: 'POST', json: { email: email || eligibility?.email } });
            link = r?.kycLink || r?.kycUrl || '';
            setKycStatus(r?.status || 'NOT_STARTED');
        }
        setKycLink(link);
        if (link) window.open(link, '_blank', 'noopener');
    });
    // poll KYC status while on the kyc step
    useEffect(() => {
        if (step !== 'kyc') return;
        let active = true;
        const poll = async () => {
            try {
                const s = await call('/offramp/customer/status');
                if (!active) return;
                setKycStatus(s?.status || ''); if (s?.kycLink) setKycLink(s.kycLink);
                if (String(s?.status).toUpperCase() === 'APPROVED') { setStep('amount'); return; }
            } catch { /* keep polling */ }
            if (active) setTimeout(poll, 5000);
        };
        poll();
        return () => { active = false; };
    }, [step, call]);

    const loadBanks = wrap(async () => {
        const list = await call('/offramp/bank-accounts');
        setBanks(Array.isArray(list) ? list : []);
        if (Array.isArray(list) && list.length && !selectedBankId) setSelectedBankId(String(list[0].id));
    });
    const addBank = wrap(async () => {
        const addr = { streetLine1: '—', city: 'Karachi', stateRegionOrProvince: 'Sindh', postalCode: '74000', countryCode: 'PK' };
        const r = await call('/offramp/bank-account', { method: 'POST', json: {
            currencyCode: DEST_CURRENCY, isThirdParty: false,
            bank: { name: bankForm.bankName, iban: bankForm.iban.trim(), type: 'CHECKING', address: addr },
            accountHolder: { firstName: bankForm.firstName, lastName: bankForm.lastName, type: 'INDIVIDUAL', address: addr },
        } });
        setShowAddBank(false); setSelectedBankId(String(r.id));
        const list = await call('/offramp/bank-accounts'); setBanks(Array.isArray(list) ? list : []);
    });
    const confirmWithdraw = wrap(async () => {
        const created = await call('/offramp/payment', { method: 'POST', json: {
            sourceCurrency: SOURCE_CURRENCY, amount: parseFloat(amount), sourceRail: SOURCE_RAIL,
            fromAddress: token?.address, destinationCurrency: DEST_CURRENCY, destinationRail: DEST_RAIL,
            destinationAccountId: selectedBankId, paymentReason: purpose,
        } });
        setPaymentId(created.id);
        await fundOfframpViaBackend({ accessToken, paymentId: created.id });
        setStep('status');
    });

    if (!isOpen || !token) return null;
    const recv = rate?.calculatedAmount?.destinationAmount;
    const rateVal = rate?.midMarketRate;

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[92vh] overflow-y-auto">
                <div className="flex items-center justify-between p-5 border-b border-slate-200 sticky top-0 bg-white z-10">
                    <div>
                        <h2 className="text-lg font-bold text-slate-900">Withdraw to Bank</h2>
                        <p className="text-xs text-slate-500">Money wallet → {DEST_CURRENCY}</p>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg">
                        <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                </div>

                <div className="p-5">
                    {error && <div className="bg-red-50 text-red-600 p-3 rounded-lg mb-4 text-sm">{error}</div>}

                    {step === 'check' && <div className="py-10 text-center text-slate-400">Loading…</div>}

                    {/* ── CDD: email ── */}
                    {step === 'email' && (
                        <div className="space-y-4">
                            <div className="text-center"><h3 className="text-lg font-bold text-slate-900">Verify a way to reach you</h3><p className="text-sm text-slate-500 mt-1">One-time — used to verify it's you. Withdraw to your bank anytime after.</p></div>
                            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@email.com" className="w-full px-4 py-3 border border-slate-300 rounded-lg" />
                            <button onClick={sendOtp} disabled={loading || !email} className="w-full py-3 bg-slate-900 text-white rounded-lg font-semibold disabled:opacity-50">{loading ? 'Sending…' : 'Continue'}</button>
                        </div>
                    )}

                    {/* ── CDD: OTP ── */}
                    {step === 'otp' && (
                        <div className="space-y-4">
                            <div className="text-center"><h3 className="text-lg font-bold text-slate-900">Enter the code</h3><p className="text-sm text-slate-500 mt-1">Sent to <strong>{email}</strong></p></div>
                            {devCode && <div className="bg-amber-50 text-amber-700 text-xs rounded-lg p-2 text-center">Dev code (email not configured): <strong>{devCode}</strong></div>}
                            <input value={otpCode} onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="6-digit code" inputMode="numeric" className="w-full px-4 py-3 border border-slate-300 rounded-lg text-center text-2xl tracking-[0.4em] font-mono" />
                            <button onClick={verifyOtp} disabled={loading || otpCode.length < 4} className="w-full py-3 bg-slate-900 text-white rounded-lg font-semibold disabled:opacity-50">{loading ? 'Verifying…' : 'Verify'}</button>
                            <button onClick={() => setStep('email')} className="w-full text-sm text-slate-500">Change email</button>
                        </div>
                    )}

                    {/* ── CDD: questionnaire ── */}
                    {step === 'cdd' && (() => {
                        const q = CDD_QUESTIONS[cddQ];
                        return (
                            <div className="space-y-4">
                                <div className="flex gap-1">{CDD_QUESTIONS.map((_, i) => <div key={i} className={`h-1 flex-1 rounded-full ${i <= cddQ ? 'bg-emerald-500' : 'bg-slate-200'}`} />)}</div>
                                <p className="text-xs text-slate-400">Additional information</p>
                                <h3 className="text-xl font-bold text-slate-900">{q.title}</h3>
                                <div className="flex flex-wrap gap-2">
                                    {q.options.map((opt) => (
                                        <button key={opt} onClick={() => answerCdd(opt)} disabled={loading}
                                            className={`px-4 py-2.5 rounded-full text-sm font-medium border transition ${cdd[q.key] === opt ? 'bg-emerald-500 text-white border-emerald-500' : 'bg-white text-slate-700 border-slate-300 hover:border-emerald-400'}`}>
                                            {opt}
                                        </button>
                                    ))}
                                </div>
                                {cddQ > 0 && <button onClick={() => setCddQ(cddQ - 1)} className="text-sm text-slate-500">Back</button>}
                                {loading && <p className="text-xs text-slate-400">Saving…</p>}
                            </div>
                        );
                    })()}

                    {/* ── KYC (hosted) ── */}
                    {step === 'kyc' && (() => {
                        const st = String(kycStatus || '').toUpperCase();
                        const rejected = st === 'REJECTED';
                        const review = ['SUBMITTED', 'UNDER_REVIEW', 'PENDING'].includes(st);
                        return (
                            <div className="space-y-4 text-center">
                                <div className={`w-16 h-16 rounded-full mx-auto flex items-center justify-center ${rejected ? 'bg-red-100' : review ? 'bg-amber-100' : 'bg-emerald-100'}`}>
                                    {rejected ? '❌' : review ? '⏳' : '🪪'}
                                </div>
                                <h3 className="text-lg font-bold text-slate-900">{rejected ? 'Verification unsuccessful' : review ? 'Under review' : 'Verify your identity'}</h3>
                                <p className="text-sm text-slate-500">{rejected ? "We couldn't verify your identity. Please try again." : review ? "A specialist is reviewing your details — usually within 24 hours. We'll update this automatically." : 'Verify once to unlock bank withdrawals. Opens a secure verification page.'}</p>
                                {!review && (
                                    <button onClick={startKyc} disabled={loading} className="w-full py-3 bg-slate-900 text-white rounded-lg font-semibold disabled:opacity-50">
                                        {loading ? 'Starting…' : rejected ? 'Try again' : 'Continue verification'}
                                    </button>
                                )}
                                {kycLink && !review && <a href={kycLink} target="_blank" rel="noopener noreferrer" className="block text-sm text-emerald-600 underline">Open verification page</a>}
                                {review && <p className="text-xs text-slate-400">Checking status…</p>}
                            </div>
                        );
                    })()}

                    {/* ── Amount ── */}
                    {step === 'amount' && (
                        <div className="space-y-4">
                            <div className="text-center"><p className="text-sm text-slate-500">You send</p>
                                <div className="flex items-center justify-center gap-1 mt-1"><span className="text-3xl font-bold text-emerald-600">$</span>
                                    <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0" inputMode="decimal" className="text-4xl font-bold text-slate-900 w-40 text-center outline-none" />
                                </div>
                                <p className="text-slate-400 mt-1">≈ {recv != null ? fmtN(recv) : '0'} {DEST_CURRENCY}</p>
                                {rateVal && <p className="text-xs text-slate-400 mt-1">1 USD = {fmtN(rateVal)} {DEST_CURRENCY}</p>}
                            </div>
                            {config && parseFloat(amount) > 0 && parseFloat(amount) < config.minAmountUsd && <p className="text-xs text-red-500 text-center">Min withdrawal ${config.minAmountUsd}</p>}
                            <button onClick={() => { setStep('bank'); loadBanks(); }} disabled={!amount || parseFloat(amount) < (config?.minAmountUsd || 1) || !recv} className="w-full py-3 bg-slate-900 text-white rounded-lg font-semibold disabled:opacity-50">Continue</button>
                        </div>
                    )}

                    {/* ── Bank ── */}
                    {step === 'bank' && !showAddBank && (
                        <div className="space-y-3">
                            <h3 className="text-lg font-bold text-slate-900">Select bank account</h3>
                            <p className="text-xs text-slate-500">Sending ≈ {fmtN(recv)} {DEST_CURRENCY}</p>
                            <button onClick={() => setShowAddBank(true)} className="w-full py-2.5 bg-emerald-50 text-emerald-700 rounded-lg font-medium border border-emerald-200">+ Add Bank Account</button>
                            {banks.length === 0 && <p className="text-sm text-slate-400 text-center py-4">No saved accounts — add one to continue.</p>}
                            {banks.map((b) => (
                                <button key={b.id} onClick={() => setSelectedBankId(String(b.id))} className={`w-full text-left p-3 rounded-lg border ${selectedBankId === String(b.id) ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200'}`}>
                                    <p className="font-medium text-slate-900">{b.accountHolder}</p>
                                    <p className="text-xs text-slate-500">{b.bankName} · {b.currencyCode}</p>
                                </button>
                            ))}
                            <button onClick={() => { setPurpose(config?.paymentPurposes?.[0]?.value || ''); setStep('kyt'); }} disabled={!selectedBankId} className="w-full py-3 bg-slate-900 text-white rounded-lg font-semibold disabled:opacity-50">Continue</button>
                        </div>
                    )}
                    {step === 'bank' && showAddBank && (
                        <div className="space-y-3">
                            <h3 className="text-lg font-bold text-slate-900">Add bank account</h3>
                            <div><label className="text-xs text-slate-500">Bank</label>
                                <select value={bankForm.bankName} onChange={(e) => setBankForm({ ...bankForm, bankName: e.target.value })} className="w-full px-3 py-2.5 border border-slate-300 rounded-lg">
                                    <option value="">Select a bank…</option>
                                    {(config?.supportedBanks || []).map((b: any) => <option key={b.name} value={b.name}>{b.name}</option>)}
                                </select>
                            </div>
                            <div><label className="text-xs text-slate-500">IBAN (24 chars)</label><input value={bankForm.iban} onChange={(e) => setBankForm({ ...bankForm, iban: e.target.value.toUpperCase() })} placeholder="PK36…" className="w-full px-3 py-2.5 border border-slate-300 rounded-lg font-mono text-sm" /></div>
                            <div className="grid grid-cols-2 gap-2">
                                <div><label className="text-xs text-slate-500">First name</label><input value={bankForm.firstName} onChange={(e) => setBankForm({ ...bankForm, firstName: e.target.value })} className="w-full px-3 py-2.5 border border-slate-300 rounded-lg" /></div>
                                <div><label className="text-xs text-slate-500">Last name</label><input value={bankForm.lastName} onChange={(e) => setBankForm({ ...bankForm, lastName: e.target.value })} className="w-full px-3 py-2.5 border border-slate-300 rounded-lg" /></div>
                            </div>
                            <p className="text-xs text-slate-400">Account title as registered with the bank.</p>
                            <button onClick={addBank} disabled={loading || !bankForm.bankName || bankForm.iban.length < 20 || !bankForm.firstName} className="w-full py-3 bg-slate-900 text-white rounded-lg font-semibold disabled:opacity-50">{loading ? 'Saving…' : 'Save Account'}</button>
                            <button onClick={() => setShowAddBank(false)} className="w-full text-sm text-slate-500">Cancel</button>
                        </div>
                    )}

                    {/* ── KYT: purpose ── */}
                    {step === 'kyt' && (
                        <div className="space-y-3">
                            <h3 className="text-lg font-bold text-slate-900">Purpose of payment</h3>
                            <p className="text-xs text-slate-500">Required for every withdrawal.</p>
                            {(config?.paymentPurposes || []).map((p: any) => (
                                <button key={p.value} onClick={() => setPurpose(p.value)} className={`w-full text-left p-3 rounded-lg border ${purpose === p.value ? 'border-emerald-500 bg-emerald-50 text-emerald-800' : 'border-slate-200 text-slate-700'}`}>{p.label}</button>
                            ))}
                            <button onClick={() => setStep('review')} disabled={!purpose} className="w-full py-3 bg-slate-900 text-white rounded-lg font-semibold disabled:opacity-50">Continue</button>
                        </div>
                    )}

                    {/* ── Review ── */}
                    {step === 'review' && (
                        <div className="space-y-4">
                            <h3 className="text-lg font-bold text-slate-900">Review withdrawal</h3>
                            <div className="bg-slate-900 text-white rounded-2xl p-5 text-center">
                                <p className="text-xs text-slate-400">Recipient gets</p>
                                <p className="text-3xl font-bold">{fmtN(recv)} <span className="text-lg text-slate-300">{DEST_CURRENCY}</span></p>
                            </div>
                            <div className="bg-slate-50 rounded-xl p-4 space-y-2 text-sm">
                                <DetailRow label="You send" value={`$${fmtN(amount)} ${SOURCE_CURRENCY}`} />
                                <DetailRow label="Rate" value={`1 USD = ${fmtN(rateVal)} ${DEST_CURRENCY}`} />
                                <DetailRow label="Total fee" value={rate?.calculatedAmount?.totalFeeInSourceCurrency != null ? `${fmtN(rate.calculatedAmount.totalFeeInSourceCurrency)} ${SOURCE_CURRENCY}` : '—'} />
                                <DetailRow label="Purpose" value={config?.paymentPurposes?.find((p: any) => p.value === purpose)?.label || purpose} />
                                <DetailRow label="Bank" value={banks.find((b) => String(b.id) === selectedBankId)?.accountHolder || '—'} />
                            </div>
                            <button onClick={confirmWithdraw} disabled={loading} className="w-full py-3 bg-emerald-600 text-white rounded-lg font-semibold disabled:opacity-50">{loading ? 'Confirming…' : 'Slide to Confirm'}</button>
                            <button onClick={() => setStep('kyt')} className="w-full text-sm text-slate-500">Back</button>
                        </div>
                    )}

                    {/* ── Status ── */}
                    {step === 'status' && (() => {
                        const st = String(payment?.status || 'PENDING').toUpperCase();
                        const done = st === 'COMPLETED';
                        const failed = ['FAILED', 'EXPIRED', 'REFUNDED', 'CANCELLED'].includes(st);
                        const pending = !done && !failed;
                        const short = (s: any) => (s ? `${String(s).slice(0, 8)}…${String(s).slice(-6)}` : '—');
                        const dt = (d: any) => (d ? new Date(d).toLocaleString() : '—');
                        const effRate = payment?.exchangeRate ?? (payment?.destinationAmount && payment?.sourceAmount ? payment.destinationAmount / payment.sourceAmount : null);
                        return (
                            <div className="space-y-5">
                                <div className="text-center space-y-3">
                                    <div className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto ${done ? 'bg-emerald-100' : failed ? 'bg-red-100' : 'bg-amber-100'}`}>
                                        {done ? <svg className="w-8 h-8 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg> : failed ? <svg className="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg> : <svg className="w-8 h-8 text-amber-600 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
                                    </div>
                                    <h3 className="text-xl font-bold text-slate-900">{done ? 'Withdrawal Complete' : failed ? 'Withdrawal Failed' : 'Your withdrawal is on its way'}</h3>
                                </div>
                                <div className="bg-slate-900 text-white rounded-2xl p-5 text-center">
                                    <p className="text-xs text-slate-400 mb-1">{done ? 'Amount Delivered' : 'Amount Received'}</p>
                                    <p className="text-3xl font-bold">{fmtN(payment?.destinationAmount)} <span className="text-lg text-slate-300">{payment?.destinationCurrency}</span></p>
                                </div>
                                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2 text-sm">
                                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">Transaction Details</p>
                                    <DetailRow label="Transaction ID" value={<span className="font-mono text-xs">{payment?.walapayPaymentId || '—'}</span>} />
                                    <DetailRow label="Status" value={<span className={`font-semibold ${done ? 'text-emerald-600' : failed ? 'text-red-600' : 'text-amber-600'}`}>{st.charAt(0) + st.slice(1).toLowerCase()}</span>} />
                                    <DetailRow label="You Send" value={`${fmtN(payment?.sourceAmount)} ${payment?.sourceCurrency || ''}`} />
                                    <DetailRow label="Exchange Rate" value={effRate ? `1 ${payment?.sourceCurrency} = ${fmtN(effRate)} ${payment?.destinationCurrency}` : '—'} />
                                    <DetailRow label="Fee" value={payment?.feeAmount != null ? `${fmtN(payment?.feeAmount)} ${payment?.sourceCurrency}` : '—'} />
                                    <DetailRow label="Payment Reason" value={payment?.paymentReason ? String(payment.paymentReason).replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()) : '—'} />
                                    <DetailRow label="Date Created" value={dt(payment?.createdAt)} />
                                    {done && <DetailRow label="Completed" value={dt(payment?.completedAt)} />}
                                </div>
                                {pending && <p className="text-xs text-amber-700 text-center bg-amber-50 rounded-lg py-2">⏳ Processing your withdrawal — usually completes within a few minutes.</p>}
                                {failed && <p className="text-xs text-red-600 text-center bg-red-50 rounded-lg py-2">Bank temporarily unavailable — funds returned to your Money Wallet.</p>}
                                <button onClick={onClose} className="w-full py-3 bg-slate-900 text-white rounded-lg font-semibold">{pending ? 'Back to Home' : 'Done'}</button>
                            </div>
                        );
                    })()}
                </div>
            </div>
        </div>
    );
}
