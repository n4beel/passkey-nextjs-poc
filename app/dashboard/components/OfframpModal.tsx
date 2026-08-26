'use client';

import { useState, useEffect } from 'react';
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
}

type Step = 'check' | 'register' | 'kyc-pending' | 'add-bank' | 'payment' | 'funding' | 'status' | 'success';

const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'REFUNDED', 'EXPIRED', 'CANCELLED'];

/** One label/value row in the transaction-details block. */
function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div className="flex items-center justify-between gap-3">
            <span className="text-slate-500">{label}</span>
            <span className="text-slate-900 font-medium text-right break-all">{value}</span>
        </div>
    );
}

const SUPPORTED_RAILS: Record<string, string> = {
    'svm': 'SOLANA',
    'evm': 'POLYGON', // Default for EVM, could be mapped by chainId
};

// Map chainId to Walapay rail names
const CHAIN_RAIL_MAP: Record<number, string> = {
    137: 'POLYGON',    // Polygon Mainnet
    80002: 'POLYGON',  // Polygon Amoy (testnet)
    1: 'ETHEREUM',     // Ethereum
    11155111: 'ETHEREUM', // Sepolia
    8453: 'BASE',      // Base
    84532: 'BASE',     // Base Sepolia
};

// Map destination currency to Walapay rail
const DEST_RAIL_MAP: Record<string, string> = {
    PKR: 'IBFT',
};

const getDestRail = (currency: string) => DEST_RAIL_MAP[currency] || 'LOCAL';

export default function OfframpModal({ isOpen, onClose, token, accessToken }: OfframpModalProps) {
    const { fundOfframpViaBackend } = useRhinestoneTransfer();
    const [step, setStep] = useState<Step>('check');
    const [fundHash, setFundHash] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    // Live payment record (polled on the status screen).
    const [payment, setPayment] = useState<any>(null);

    // Customer registration
    const [kycLink, setKycLink] = useState('');
    const [kycStatus, setKycStatus] = useState('');
    const [regForm, setRegForm] = useState({
        firstName: '',
        lastName: '',
        email: '',
        phone: '',
        dateOfBirth: '',
        streetLine1: '',
        city: '',
        stateRegion: '',
        postalCode: '',
        countryCode: 'US',
        idType: 'PASSPORT',
        idNumber: '',
        idCountry: 'US',
    });
    const [idFrontImage, setIdFrontImage] = useState<string>(''); // Data URI

    const handleIdImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.size < 10 * 1024) {
            setError('ID image must be at least 10KB');
            return;
        }
        if (file.size > 50 * 1024 * 1024) {
            setError('ID image must be under 50MB');
            return;
        }
        const reader = new FileReader();
        reader.onloadend = () => {
            setIdFrontImage(reader.result as string);
            setError('');
        };
        reader.readAsDataURL(file);
    };

    // Bank account
    const [bankAccounts, setBankAccounts] = useState<any[]>([]);
    const [selectedBankId, setSelectedBankId] = useState('');
    const [showAddBank, setShowAddBank] = useState(false);
    const [bankForm, setBankForm] = useState({
        currencyCode: 'USD',
        bankName: '',
        accountNumber: '',
        routingNumber: '',
        iban: '',
        bankType: 'CHECKING' as 'CHECKING' | 'SAVING',
        holderFirstName: '',
        holderLastName: '',
        holderEmail: '',
        streetLine1: '',
        city: '',
        stateRegion: '',
        postalCode: '',
        countryCode: 'US',
        label: '',
    });

    // Payment
    const [amount, setAmount] = useState('');
    const [destCurrency, setDestCurrency] = useState('USD');
    const [rate, setRate] = useState<any>(null);
    const [fundingInstructions, setFundingInstructions] = useState<any>(null);
    const [paymentId, setPaymentId] = useState('');

    useEffect(() => {
        if (isOpen && token) {
            checkCustomerStatus();
        }
    }, [isOpen]);

    const resetState = () => {
        setStep('check');
        setError('');
        setAmount('');
        setRate(null);
        setFundingInstructions(null);
        setPaymentId('');
        setFundHash('');
        setSelectedBankId('');
        setShowAddBank(false);
    };

    const handleClose = () => {
        resetState();
        onClose();
    };

    // ==========================================
    // Step 1: Check customer status
    // ==========================================
    const checkCustomerStatus = async () => {
        setLoading(true);
        setError('');
        try {
            const res = await signedFetch('/offramp/customer/status', { auth: true });
            if (!res.ok) throw new Error('Failed to check status');
            const data = await res.json();

            if (!data.registered) {
                setStep('register');
            } else {
                const status = (data.status || '').toUpperCase();
                if (status === 'APPROVED' || status === 'ACTIVE') {
                    await fetchBankAccounts();
                    setStep('add-bank');
                } else if (status === 'PENDING' || status === '' || !data.status) {
                    setKycLink(data.kycLink);
                    setKycStatus('PENDING');
                    setStep('kyc-pending');
                } else {
                    setError(`KYC status: ${data.status}. Please contact support.`);
                    setStep('register');
                }
            }
        } catch (err: any) {
            setError(err.message);
            setStep('register');
        } finally {
            setLoading(false);
        }
    };

    // ==========================================
    // Step 2: Register customer
    // ==========================================
    const registerCustomer = async () => {
        if (!regForm.firstName || !regForm.lastName || !regForm.email || !regForm.phone || !regForm.dateOfBirth || !regForm.idNumber || !idFrontImage) {
            setError('All fields are required (including ID front image)');
            return;
        }
        // Validate phone E.164
        if (!/^\+\d{7,15}$/.test(regForm.phone)) {
            setError('Phone must be in E.164 format (e.g. +14155551234)');
            return;
        }
        // Validate date format
        if (!/^\d{4}-\d{2}-\d{2}$/.test(regForm.dateOfBirth)) {
            setError('Date of birth must be YYYY-MM-DD');
            return;
        }
        setLoading(true);
        setError('');
        try {
            const res = await signedFetch('/offramp/customer', {
                method: 'POST',
                auth: true,
                json: {
                    firstName: regForm.firstName,
                    lastName: regForm.lastName,
                    email: regForm.email,
                    phone: regForm.phone,
                    dateOfBirth: regForm.dateOfBirth,
                    address: {
                        streetLine1: regForm.streetLine1,
                        city: regForm.city,
                        stateRegionOrProvince: regForm.stateRegion,
                        postalCode: regForm.postalCode,
                        countryCode: regForm.countryCode,
                    },
                    governmentIssuedIdentification: {
                        type: regForm.idType,
                        number: regForm.idNumber,
                        countryCode: regForm.idCountry,
                        frontImage: idFrontImage,
                    },
                },
            });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.message || 'Registration failed');
            }
            const data = await res.json();
            setKycLink(data.kycLink);
            setKycStatus(data.status);
            if (data.status === 'APPROVED') {
                await fetchBankAccounts();
                setStep('add-bank');
            } else {
                setStep('kyc-pending');
            }
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    // ==========================================
    // Step 3: Bank account management
    // ==========================================
    const fetchBankAccounts = async () => {
        try {
            const res = await signedFetch('/offramp/bank-accounts', { auth: true });
            if (res.ok) {
                const data = await res.json();
                setBankAccounts(data);
                if (data.length > 0) {
                    setSelectedBankId(data[0].id);
                }
            }
        } catch (err) {
            console.error('Failed to fetch bank accounts:', err);
        }
    };

    const addBankAccount = async () => {
        setLoading(true);
        setError('');
        try {
            const res = await signedFetch('/offramp/bank-account', {
                method: 'POST',
                auth: true,
                json: {
                    currencyCode: bankForm.currencyCode,
                    isThirdParty: false,
                    bank: {
                        name: bankForm.bankName,
                        ...(bankForm.accountNumber && { accountNumber: bankForm.accountNumber }),
                        ...(bankForm.routingNumber && { routingNumber: bankForm.routingNumber }),
                        ...(bankForm.iban && { iban: bankForm.iban }),
                        type: bankForm.bankType,
                        address: {
                            streetLine1: bankForm.streetLine1,
                            city: bankForm.city,
                            stateRegionOrProvince: bankForm.stateRegion,
                            postalCode: bankForm.postalCode,
                            countryCode: bankForm.countryCode,
                        },
                    },
                    accountHolder: {
                        firstName: bankForm.holderFirstName,
                        lastName: bankForm.holderLastName,
                        email: bankForm.holderEmail,
                        type: 'INDIVIDUAL',
                        address: {
                            streetLine1: bankForm.streetLine1,
                            city: bankForm.city,
                            stateRegionOrProvince: bankForm.stateRegion,
                            postalCode: bankForm.postalCode,
                            countryCode: bankForm.countryCode,
                        },
                    },
                    label: bankForm.label,
                },
            });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.message || 'Failed to add bank account');
            }
            await fetchBankAccounts();
            setShowAddBank(false);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    // ==========================================
    // Step 4: Get rate & create payment
    // ==========================================
    const fetchRate = async () => {
        if (!amount || parseFloat(amount) < 5) return;
        setLoading(true);
        setError('');
        try {
            const rail = token?.type === 'svm' ? 'SOLANA' : (CHAIN_RAIL_MAP[token?.chainId || 0] || 'POLYGON');
            const res = await signedFetch(
                `/offramp/rate?sourceCurrency=${token?.symbol}&destinationCurrency=${destCurrency}&amount=${amount}&sourceRail=${rail}&destinationRail=${getDestRail(destCurrency)}`,
                { auth: true },
            );
            if (res.ok) {
                const data = await res.json();
                setRate(data);
            } else {
                const data = await res.json();
                console.warn('Rate fetch error:', data.message);
            }
        } catch (err) {
            console.error('Failed to fetch rate:', err);
        } finally {
            setLoading(false);
        }
    };

    const createPayment = async () => {
        if (!selectedBankId || !amount || parseFloat(amount) < 5) {
            setError('Please select a bank account and enter an amount (minimum 5 USDC)');
            return;
        }
        setLoading(true);
        setError('');
        try {
            const rail = token?.type === 'svm' ? 'SOLANA' : (CHAIN_RAIL_MAP[token?.chainId || 0] || 'POLYGON');

            // fromAddress MUST be the wallet that actually holds the source token
            // (the Spot wallet on Base for USDC) — the backend picks the signing
            // wallet by matching it. token.address is that holding address; fall
            // back to localStorage only if it's somehow missing.
            let fromAddress = token?.address || '';
            if (!fromAddress) {
                try {
                    const walletData = localStorage.getItem('wallet');
                    if (walletData) {
                        const wallet = JSON.parse(walletData);
                        fromAddress = token?.type === 'svm' ? wallet?.svm?.address : wallet?.evm?.address;
                    }
                } catch (e) {
                    console.error('Error getting wallet address:', e);
                }
            }

            const res = await signedFetch('/offramp/payment', {
                method: 'POST',
                auth: true,
                json: {
                    sourceCurrency: token?.symbol,
                    amount: parseFloat(amount),
                    sourceRail: rail,
                    fromAddress,
                    destinationCurrency: destCurrency,
                    destinationRail: getDestRail(destCurrency),
                    destinationAccountId: selectedBankId,
                },
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.message || 'Failed to create payment');
            }

            const data = await res.json();
            setPaymentId(data.id);
            setFundingInstructions(data.fundingInstructions);
            setStep('funding');
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    // ==========================================
    // Step 5: Fund the payment from the wallet (passkey-signed)
    // ==========================================
    const fundPayment = async () => {
        if (!paymentId) return;
        setLoading(true);
        setError('');
        try {
            const res = await fundOfframpViaBackend({ accessToken, paymentId });
            setFundHash(res.hash);
            // Move to the live status screen — it polls until the payout settles.
            setStep('status');
        } catch (err: any) {
            setError(err.message || 'Funding failed');
        } finally {
            setLoading(false);
        }
    };

    // Poll the payment on the status screen until it reaches a terminal state, so
    // the UI animates on-its-way → complete (or failed) like the mobile designs.
    useEffect(() => {
        if (step !== 'status' || !paymentId) return;
        let active = true;
        const poll = async () => {
            try {
                const res = await signedFetch(`/offramp/payment/${paymentId}`, { auth: true });
                if (res.ok && active) {
                    const p = await res.json();
                    setPayment(p);
                    if (TERMINAL_STATUSES.includes(String(p.status || '').toUpperCase())) return;
                }
            } catch { /* keep polling */ }
            if (active) setTimeout(poll, 2000);
        };
        poll();
        return () => { active = false; };
    }, [step, paymentId]);

    if (!isOpen || !token) return null;

    const getRailName = () => {
        if (token.type === 'svm') return 'SOLANA';
        return CHAIN_RAIL_MAP[token.chainId] || 'POLYGON';
    };

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
                {/* Header */}
                <div className="flex items-center justify-between p-6 border-b border-slate-200">
                    <div>
                        <h2 className="text-xl font-bold text-slate-900">Off-Ramp</h2>
                        <p className="text-sm text-slate-500">{token.symbol} → Fiat</p>
                    </div>
                    <button onClick={handleClose} className="p-2 hover:bg-slate-100 rounded-lg transition">
                        <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                <div className="p-6">
                    {error && (
                        <div className="bg-red-50 text-red-600 p-3 rounded-lg mb-4 text-sm">{error}</div>
                    )}

                    {/* Loading */}
                    {loading && step === 'check' && (
                        <div className="flex items-center justify-center py-10">
                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-600"></div>
                            <span className="ml-3 text-slate-500">Checking status...</span>
                        </div>
                    )}

                    {/* ==================== REGISTER ==================== */}
                    {step === 'register' && (
                        <div className="space-y-3">
                            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                                <p className="text-sm text-amber-800">
                                    <strong>First time?</strong> Complete registration for KYC verification.
                                </p>
                            </div>

                            {/* Name */}
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-medium text-slate-600 mb-1">First Name</label>
                                    <input type="text" value={regForm.firstName} onChange={(e) => setRegForm({ ...regForm, firstName: e.target.value })}
                                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 text-slate-900" />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-slate-600 mb-1">Last Name</label>
                                    <input type="text" value={regForm.lastName} onChange={(e) => setRegForm({ ...regForm, lastName: e.target.value })}
                                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 text-slate-900" />
                                </div>
                            </div>

                            {/* Email & Phone */}
                            <div>
                                <label className="block text-xs font-medium text-slate-600 mb-1">Email</label>
                                <input type="email" value={regForm.email} onChange={(e) => setRegForm({ ...regForm, email: e.target.value })}
                                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 text-slate-900" />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-medium text-slate-600 mb-1">Phone (E.164)</label>
                                    <input type="tel" value={regForm.phone} onChange={(e) => setRegForm({ ...regForm, phone: e.target.value })}
                                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 text-slate-900"
                                        placeholder="+14155551234" />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-slate-600 mb-1">Date of Birth</label>
                                    <input type="date" value={regForm.dateOfBirth} onChange={(e) => setRegForm({ ...regForm, dateOfBirth: e.target.value })}
                                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 text-slate-900" />
                                </div>
                            </div>

                            {/* Address */}
                            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide pt-1">Address</p>
                            <div>
                                <input type="text" value={regForm.streetLine1} onChange={(e) => setRegForm({ ...regForm, streetLine1: e.target.value })}
                                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 text-slate-900"
                                    placeholder="Street address" />
                            </div>
                            <div className="grid grid-cols-3 gap-3">
                                <div>
                                    <input type="text" value={regForm.city} onChange={(e) => setRegForm({ ...regForm, city: e.target.value })}
                                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900" placeholder="City" />
                                </div>
                                <div>
                                    <input type="text" value={regForm.stateRegion} onChange={(e) => setRegForm({ ...regForm, stateRegion: e.target.value })}
                                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900" placeholder="State" />
                                </div>
                                <div>
                                    <input type="text" value={regForm.postalCode} onChange={(e) => setRegForm({ ...regForm, postalCode: e.target.value })}
                                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900" placeholder="Zip" />
                                </div>
                            </div>
                            <div>
                                <label className="block text-xs font-medium text-slate-600 mb-1">Country Code</label>
                                <input type="text" value={regForm.countryCode} onChange={(e) => setRegForm({ ...regForm, countryCode: e.target.value })}
                                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900" maxLength={2} />
                            </div>

                            {/* Government ID */}
                            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide pt-1">Government ID</p>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-medium text-slate-600 mb-1">ID Type</label>
                                    <select value={regForm.idType} onChange={(e) => setRegForm({ ...regForm, idType: e.target.value })}
                                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900">
                                        <option value="PASSPORT">Passport</option>
                                        <option value="NATIONAL_ID">National ID</option>
                                        <option value="DRIVERS_LICENSE">Driver&apos;s License</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-slate-600 mb-1">ID Country</label>
                                    <input type="text" value={regForm.idCountry} onChange={(e) => setRegForm({ ...regForm, idCountry: e.target.value })}
                                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900" maxLength={2} />
                                </div>
                            </div>
                            <div>
                                <label className="block text-xs font-medium text-slate-600 mb-1">ID Number</label>
                                <input type="text" value={regForm.idNumber} onChange={(e) => setRegForm({ ...regForm, idNumber: e.target.value })}
                                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 text-slate-900" />
                            </div>
                            <div>
                                <label className="block text-xs font-medium text-slate-600 mb-1">Front of ID (photo/scan)</label>
                                <input type="file" accept="image/*" onChange={handleIdImageUpload}
                                    className="w-full text-sm text-slate-500 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-emerald-50 file:text-emerald-700 hover:file:bg-emerald-100" />
                                {idFrontImage && (
                                    <p className="text-xs text-emerald-600 mt-1">✓ Image uploaded</p>
                                )}
                            </div>

                            <button onClick={registerCustomer} disabled={loading}
                                className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-semibold transition disabled:opacity-50">
                                {loading ? 'Registering...' : 'Register & Start KYC'}
                            </button>
                        </div>
                    )}

                    {/* ==================== KYC PENDING ==================== */}
                    {step === 'kyc-pending' && (
                        <div className="space-y-4 text-center">
                            <div className="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mx-auto">
                                <svg className="w-8 h-8 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                            </div>
                            <h3 className="text-lg font-bold text-slate-900">KYC Verification Pending</h3>
                            <p className="text-sm text-slate-500">
                                Complete your identity verification to start off-ramping.
                            </p>
                            {kycLink && (
                                <a href={kycLink} target="_blank" rel="noopener noreferrer"
                                    className="inline-block px-6 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-semibold transition">
                                    Complete KYC →
                                </a>
                            )}
                            <button onClick={checkCustomerStatus}
                                className="block w-full py-2 text-emerald-600 hover:text-emerald-700 font-medium text-sm">
                                {loading ? 'Checking...' : 'Refresh Status'}
                            </button>
                        </div>
                    )}

                    {/* ==================== BANK ACCOUNT ==================== */}
                    {step === 'add-bank' && !showAddBank && (
                        <div className="space-y-4">
                            <h3 className="font-bold text-slate-900">Select Bank Account</h3>

                            {bankAccounts.length > 0 ? (
                                <div className="space-y-2">
                                    {bankAccounts.map((acc) => (
                                        <label key={acc.id}
                                            className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition ${
                                                selectedBankId === acc.id ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200 hover:border-slate-300'
                                            }`}>
                                            <input type="radio" name="bank" value={acc.id}
                                                checked={selectedBankId === acc.id}
                                                onChange={() => setSelectedBankId(acc.id)}
                                                className="text-emerald-600" />
                                            <div>
                                                <p className="font-medium text-slate-900">{acc.label || acc.bankName}</p>
                                                <p className="text-xs text-slate-500">{acc.accountNumber} · {acc.currencyCode}</p>
                                            </div>
                                        </label>
                                    ))}
                                </div>
                            ) : (
                                <p className="text-sm text-slate-500">No bank accounts yet. Add one to continue.</p>
                            )}

                            <div className="flex gap-3">
                                <button onClick={() => setShowAddBank(true)}
                                    className="flex-1 py-3 border border-emerald-600 text-emerald-600 hover:bg-emerald-50 rounded-lg font-semibold transition">
                                    + Add Bank
                                </button>
                                {bankAccounts.length > 0 && (
                                    <button onClick={() => setStep('payment')} disabled={!selectedBankId}
                                        className="flex-1 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-semibold transition disabled:opacity-50">
                                        Continue →
                                    </button>
                                )}
                            </div>
                        </div>
                    )}

                    {/* ==================== ADD BANK FORM ==================== */}
                    {step === 'add-bank' && showAddBank && (
                        <div className="space-y-3">
                            <div className="flex items-center justify-between">
                                <h3 className="font-bold text-slate-900">Add Bank Account</h3>
                                <button onClick={() => setShowAddBank(false)} className="text-sm text-slate-500 hover:text-slate-700">
                                    ← Back
                                </button>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-medium text-slate-600 mb-1">Currency</label>
                                    <select value={bankForm.currencyCode} onChange={(e) => setBankForm({ ...bankForm, currencyCode: e.target.value })}
                                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900">
                                        <option value="USD">USD</option>
                                        <option value="EUR">EUR</option>
                                        <option value="GBP">GBP</option>
                                        <option value="PHP">PHP</option>
                                        <option value="BRL">BRL</option>
                                        <option value="MXN">MXN</option>
                                        <option value="PKR">PKR</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-slate-600 mb-1">Account Type</label>
                                    <select value={bankForm.bankType} onChange={(e) => setBankForm({ ...bankForm, bankType: e.target.value as any })}
                                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900">
                                        <option value="CHECKING">Checking</option>
                                        <option value="SAVING">Saving</option>
                                    </select>
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-medium text-slate-600 mb-1">Bank Name</label>
                                <input type="text" value={bankForm.bankName} onChange={(e) => setBankForm({ ...bankForm, bankName: e.target.value })}
                                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900" placeholder="e.g. Chase" />
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-medium text-slate-600 mb-1">Account Number</label>
                                    <input type="text" value={bankForm.accountNumber} onChange={(e) => setBankForm({ ...bankForm, accountNumber: e.target.value })}
                                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900" />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-slate-600 mb-1">Routing Number</label>
                                    <input type="text" value={bankForm.routingNumber} onChange={(e) => setBankForm({ ...bankForm, routingNumber: e.target.value })}
                                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900" />
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-medium text-slate-600 mb-1">IBAN {bankForm.currencyCode === 'PKR' && <span className="text-red-500">*</span>}</label>
                                <input type="text" value={bankForm.iban} onChange={(e) => setBankForm({ ...bankForm, iban: e.target.value })}
                                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900"
                                    placeholder="e.g. PK36SCBL0000001123456702" />
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-medium text-slate-600 mb-1">Holder First Name</label>
                                    <input type="text" value={bankForm.holderFirstName} onChange={(e) => setBankForm({ ...bankForm, holderFirstName: e.target.value })}
                                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900" />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-slate-600 mb-1">Holder Last Name</label>
                                    <input type="text" value={bankForm.holderLastName} onChange={(e) => setBankForm({ ...bankForm, holderLastName: e.target.value })}
                                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900" />
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-medium text-slate-600 mb-1">Holder Email</label>
                                <input type="email" value={bankForm.holderEmail} onChange={(e) => setBankForm({ ...bankForm, holderEmail: e.target.value })}
                                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900" />
                            </div>

                            <div>
                                <label className="block text-xs font-medium text-slate-600 mb-1">Street Address</label>
                                <input type="text" value={bankForm.streetLine1} onChange={(e) => setBankForm({ ...bankForm, streetLine1: e.target.value })}
                                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900" />
                            </div>

                            <div className="grid grid-cols-3 gap-3">
                                <div>
                                    <label className="block text-xs font-medium text-slate-600 mb-1">City</label>
                                    <input type="text" value={bankForm.city} onChange={(e) => setBankForm({ ...bankForm, city: e.target.value })}
                                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900" />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-slate-600 mb-1">State</label>
                                    <input type="text" value={bankForm.stateRegion} onChange={(e) => setBankForm({ ...bankForm, stateRegion: e.target.value })}
                                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900" />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-slate-600 mb-1">Zip</label>
                                    <input type="text" value={bankForm.postalCode} onChange={(e) => setBankForm({ ...bankForm, postalCode: e.target.value })}
                                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900" />
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-medium text-slate-600 mb-1">Country Code</label>
                                <input type="text" value={bankForm.countryCode} onChange={(e) => setBankForm({ ...bankForm, countryCode: e.target.value })}
                                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900" maxLength={2} />
                            </div>

                            <div>
                                <label className="block text-xs font-medium text-slate-600 mb-1">Label (optional)</label>
                                <input type="text" value={bankForm.label} onChange={(e) => setBankForm({ ...bankForm, label: e.target.value })}
                                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900" placeholder="e.g. My US Account" />
                            </div>

                            <button onClick={addBankAccount} disabled={loading}
                                className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-semibold transition disabled:opacity-50">
                                {loading ? 'Adding...' : 'Add Bank Account'}
                            </button>
                        </div>
                    )}

                    {/* ==================== PAYMENT ==================== */}
                    {step === 'payment' && (
                        <div className="space-y-4">
                            <h3 className="font-bold text-slate-900">Off-Ramp Payment</h3>

                            <div className="bg-slate-50 p-4 rounded-lg space-y-2">
                                <div className="flex justify-between text-sm">
                                    <span className="text-slate-500">Token</span>
                                    <span className="font-medium text-slate-900">{token.symbol}</span>
                                </div>
                                <div className="flex justify-between text-sm">
                                    <span className="text-slate-500">Chain</span>
                                    <span className="font-medium text-slate-900">{getRailName()}</span>
                                </div>
                                <div className="flex justify-between text-sm">
                                    <span className="text-slate-500">Available</span>
                                    <span className="font-medium text-slate-900">{parseFloat(token.balance).toFixed(4)}</span>
                                </div>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">Amount ({token.symbol})</label>
                                <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)}
                                    onBlur={fetchRate}
                                    max={parseFloat(token.balance)}
                                    step="0.01"
                                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 text-slate-900"
                                    placeholder="0.00" />
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">Destination Currency</label>
                                <select value={destCurrency} onChange={(e) => setDestCurrency(e.target.value)}
                                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-slate-900">
                                    <option value="USD">USD</option>
                                    <option value="EUR">EUR</option>
                                    <option value="GBP">GBP</option>
                                    <option value="PHP">PHP</option>
                                    <option value="BRL">BRL</option>
                                    <option value="MXN">MXN</option>
                                    <option value="PKR">PKR</option>
                                </select>
                            </div>

                            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                                <p className="text-sm text-blue-800">
                                    💡 Minimum amount: <strong>5 {token.symbol}</strong>
                                </p>
                            </div>

                            {rate && (() => {
                                // Walapay's rate response uses midMarketRate + calculatedAmount.destinationAmount.
                                const rateVal = rate.midMarketRate ?? rate.exchangeRate ?? rate.rate;
                                const recv = rate.calculatedAmount?.destinationAmount ?? rate.destinationAmount;
                                const fee = rate.calculatedAmount?.totalFeeInSourceCurrency;
                                const fmtN = (n: any) => (n != null ? Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }) : null);
                                return (
                                    <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 space-y-1">
                                        <p className="text-sm text-emerald-800">
                                            Rate: <strong>1 {token.symbol} ≈ {fmtN(rateVal) ?? '—'} {destCurrency}</strong>
                                        </p>
                                        {recv != null && (
                                            <p className="text-sm text-emerald-800">
                                                You receive: <strong>≈ {fmtN(recv)} {destCurrency}</strong>
                                            </p>
                                        )}
                                        {fee != null && (
                                            <p className="text-xs text-emerald-700">Total fee: {fmtN(fee)} {token.symbol}</p>
                                        )}
                                    </div>
                                );
                            })()}

                            <div className="flex gap-3">
                                <button onClick={() => setStep('add-bank')}
                                    className="flex-1 py-3 border border-slate-300 text-slate-700 hover:bg-slate-50 rounded-lg font-semibold transition">
                                    ← Back
                                </button>
                                <button onClick={createPayment} disabled={loading || !amount || parseFloat(amount) < 5}
                                    className="flex-1 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-semibold transition disabled:opacity-50">
                                    {loading ? 'Creating...' : 'Create Payment'}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* ==================== FUNDING INSTRUCTIONS ==================== */}
                    {step === 'funding' && fundingInstructions && !fundHash && (
                        <div className="space-y-4 text-center">
                            <h3 className="text-lg font-bold text-slate-900">Fund your off-ramp</h3>
                            <p className="text-sm text-slate-500">
                                Send <strong>{fundingInstructions.amount} {fundingInstructions.currencyCode}</strong> on <strong>{fundingInstructions.chain}</strong> from your wallet to complete the payout.
                            </p>

                            <button
                                onClick={fundPayment}
                                disabled={loading}
                                className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg font-semibold transition">
                                {loading
                                    ? 'Funding…'
                                    : `Fund ${fundingInstructions.amount} ${fundingInstructions.currencyCode} from wallet`}
                            </button>

                            <details className="text-left">
                                <summary className="text-xs text-slate-500 cursor-pointer">Or send manually</summary>
                                <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 mt-2">
                                    <p className="text-xs text-slate-500 mb-2">Deposit Address ({fundingInstructions.chain})</p>
                                    <code className="text-sm text-slate-900 break-all font-mono">
                                        {fundingInstructions.toAddress}
                                    </code>
                                    <button
                                        onClick={() => navigator.clipboard.writeText(fundingInstructions.toAddress)}
                                        className="mt-2 block text-xs text-emerald-600 hover:text-emerald-700 font-medium">
                                        📋 Copy Address
                                    </button>
                                    <p className="text-xs text-amber-700 mt-2">
                                        ⚠️ Send exactly <strong>{fundingInstructions.amount} {fundingInstructions.currencyCode}</strong> on <strong>{fundingInstructions.chain}</strong>.
                                    </p>
                                </div>
                            </details>
                        </div>
                    )}

                    {step === 'funding' && fundHash && (
                        <div className="space-y-4 text-center">
                            <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto">
                                <svg className="w-8 h-8 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                            </div>
                            <h3 className="text-lg font-bold text-slate-900">Funded!</h3>
                            <p className="text-sm text-slate-500">
                                Your payout is on its way. Track its status in payment history.
                            </p>
                            <code className="text-xs text-slate-500 break-all font-mono block bg-slate-50 rounded-lg p-2">
                                {fundHash}
                            </code>
                            <button onClick={handleClose}
                                className="w-full py-3 bg-slate-900 hover:bg-slate-800 text-white rounded-lg font-semibold transition">
                                Done
                            </button>
                        </div>
                    )}

                    {/* Fallback for funding without instructions (sandbox) */}
                    {step === 'funding' && !fundingInstructions && (
                        <div className="space-y-4 text-center">
                            <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto">
                                <svg className="w-8 h-8 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                            </div>
                            <h3 className="text-lg font-bold text-slate-900">Payment Created!</h3>
                            <p className="text-sm text-slate-500">
                                Your off-ramp payment has been submitted. Track its status in the payment history.
                            </p>
                            <button onClick={handleClose}
                                className="w-full py-3 bg-slate-900 hover:bg-slate-800 text-white rounded-lg font-semibold transition">
                                Done
                            </button>
                        </div>
                    )}

                    {/* Live withdrawal status (on its way → complete / failed) */}
                    {step === 'status' && (() => {
                        const st = String(payment?.status || 'PENDING').toUpperCase();
                        const done = st === 'COMPLETED';
                        const failed = ['FAILED', 'EXPIRED', 'REFUNDED', 'CANCELLED'].includes(st);
                        const pending = !done && !failed;
                        const fmt = (n: any) => (n != null && n !== '' ? Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—');
                        const short = (s: any) => (s ? `${String(s).slice(0, 8)}…${String(s).slice(-6)}` : '—');
                        const dt = (d: any) => (d ? new Date(d).toLocaleString() : '—');
                        return (
                            <div className="space-y-5">
                                <div className="text-center space-y-3">
                                    <div className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto ${done ? 'bg-emerald-100' : failed ? 'bg-red-100' : 'bg-amber-100'}`}>
                                        {done ? (
                                            <svg className="w-8 h-8 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                        ) : failed ? (
                                            <svg className="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                        ) : (
                                            <svg className="w-8 h-8 text-amber-600 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                        )}
                                    </div>
                                    <h3 className="text-xl font-bold text-slate-900">
                                        {done ? 'Withdrawal Complete' : failed ? 'Withdrawal Failed' : 'Your withdrawal is on its way'}
                                    </h3>
                                </div>

                                {/* Amount ticket */}
                                <div className="bg-slate-900 text-white rounded-2xl p-5 text-center">
                                    <p className="text-xs text-slate-400 mb-1">{done ? 'Amount Delivered' : 'Amount Received'}</p>
                                    <p className="text-3xl font-bold tracking-tight">
                                        {fmt(payment?.destinationAmount)} <span className="text-lg font-semibold text-slate-300">{payment?.destinationCurrency}</span>
                                    </p>
                                    <div className="border-t border-dashed border-slate-700 my-3" />
                                    <p className="text-[11px] text-slate-400">Bank destination</p>
                                    <p className="text-sm font-medium">{payment?.destinationRail || 'Bank'} · {short(payment?.destinationAccountId)}</p>
                                </div>

                                {/* Transaction details */}
                                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2 text-sm">
                                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">Transaction Details</p>
                                    <DetailRow label="Transaction ID" value={short(payment?.walapayPaymentId)} />
                                    <DetailRow label="You Send" value={`${fmt(payment?.sourceAmount)} ${payment?.sourceCurrency || ''}`} />
                                    <DetailRow label="Rate" value={(() => {
                                        const r = payment?.exchangeRate ?? (payment?.destinationAmount && payment?.sourceAmount ? payment.destinationAmount / payment.sourceAmount : null);
                                        return r ? `1 ${payment?.sourceCurrency} ≈ ${fmt(r)} ${payment?.destinationCurrency}` : '—';
                                    })()} />
                                    <DetailRow label="Fee" value={payment?.feeAmount != null ? `${fmt(payment?.feeAmount)} ${payment?.sourceCurrency}` : '—'} />
                                    <DetailRow label="Created" value={dt(payment?.createdAt)} />
                                    {done && <DetailRow label="Completed" value={dt(payment?.completedAt)} />}
                                </div>

                                {pending && (
                                    <p className="text-xs text-amber-700 text-center bg-amber-50 rounded-lg py-2 px-3">
                                        ⏳ Processing your withdrawal — usually completes within a few minutes.
                                    </p>
                                )}
                                {failed && (
                                    <p className="text-xs text-red-600 text-center bg-red-50 rounded-lg py-2 px-3">
                                        Bank temporarily unavailable — funds returned to your Money Wallet.
                                    </p>
                                )}

                                <button onClick={handleClose}
                                    className="w-full py-3 bg-slate-900 hover:bg-slate-800 text-white rounded-lg font-semibold transition">
                                    {pending ? 'Back to Home' : 'Done'}
                                </button>
                            </div>
                        );
                    })()}
                </div>
            </div>
        </div>
    );
}
