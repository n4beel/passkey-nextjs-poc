'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import TransferModal from './components/TransferModal';
import OfframpModal from './components/OfframpModal';
// TransactionHistoryList removed — history is now a dedicated page at /dashboard/history
import { useDepositRegistration } from '@/hooks/useDepositRegistration';
import { useSpotDepositRegistration } from '@/hooks/useSpotDepositRegistration';
import { useSweepEnable } from '@/hooks/useSweepEnable';
import { useRhinestoneTransfer } from '@/hooks/useRhinestoneTransfer';
import { useSessionStatus } from '@/hooks/useSessionStatus';
import { useExtendSession } from '@/hooks/useExtendSession';
import { signedFetch } from '@/lib/api/signedFetch';

interface ChainBreakdown {
    chainId: number;
    type: 'evm' | 'svm';
    network: string;
    address: string;
    balance: string;
    usdValue: number;
}

interface Asset {
    symbol: string;
    name: string;
    totalBalance: string;
    totalUsdValue: string;
    price: string;
    decimals: number;
    logoUrl?: string | null;
    chains: ChainBreakdown[];
}

interface Portfolio {
    totalUsd: string;
    convertedTotals: Record<string, string>;
    assets: Asset[];
}

interface WalletAddresses {
    spotEvm: string | null;
    spotSvm: string | null;
    moneyEvm: string | null;
    moneySvm: string | null;
}

type ActiveWallet = 'spot' | 'money';

/** Map a /transactions/dashboard asset into the existing Portfolio Asset shape. */
function mapDashboardAssets(arr: any[]): Asset[] {
    return (arr ?? []).map((a) => ({
        symbol: a.symbol,
        name: a.name,
        totalBalance: a.amount,
        totalUsdValue: a.usdValue,
        price: a.price,
        decimals: a.decimals,
        logoUrl: a.logoUrl ?? null,
        chains: a.chains,
    }));
}

/**
 * Token icon: render the `logoUrl` image when present, otherwise (or if it
 * fails to load) fall back to the gradient letter avatar.
 */
function TokenIcon({
    symbol,
    logoUrl,
    gradient,
    sizeClass = 'h-12 w-12',
    textClass = 'text-lg',
}: {
    symbol: string;
    logoUrl?: string | null;
    gradient: string;
    sizeClass?: string;
    textClass?: string;
}) {
    const [errored, setErrored] = useState(false);
    if (logoUrl && !errored) {
        // eslint-disable-next-line @next/next/no-img-element
        return (
            <img
                src={logoUrl}
                alt={symbol}
                onError={() => setErrored(true)}
                className={`${sizeClass} rounded-full object-cover bg-white border border-slate-100`}
            />
        );
    }
    return (
        <div className={`${sizeClass} bg-gradient-to-br ${gradient} rounded-full flex items-center justify-center font-bold text-white ${textClass}`}>
            {symbol[0]}
        </div>
    );
}

/**
 * Activity-row avatar: the token `logoUrl` image with a small direction badge
 * (↓ incoming / ↑ outgoing), falling back to the plain arrow circle when there
 * is no logo (or it fails to load). `muted` = the tx didn't land (failed/etc.).
 */
function ActivityAvatar({
    logoUrl,
    symbol,
    incoming,
    muted,
}: {
    logoUrl?: string | null;
    symbol?: string;
    incoming: boolean;
    muted: boolean;
}) {
    const [errored, setErrored] = useState(false);
    const showImg = !!logoUrl && !errored;
    return (
        <div className="relative h-10 w-10 shrink-0">
            {showImg ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                    src={logoUrl!}
                    alt={symbol ?? ''}
                    onError={() => setErrored(true)}
                    className="h-10 w-10 rounded-full object-cover bg-white border border-slate-100"
                />
            ) : (
                <div className={`h-10 w-10 rounded-full flex items-center justify-center font-bold ${muted ? 'bg-slate-100 text-slate-400' : incoming ? 'bg-emerald-100 text-emerald-600' : 'bg-red-100 text-red-500'}`}>
                    {incoming ? '↓' : '↑'}
                </div>
            )}
            <span className={`absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full flex items-center justify-center text-[10px] leading-none border-2 border-white ${muted ? 'bg-slate-300 text-slate-700' : incoming ? 'bg-emerald-500 text-white' : 'bg-red-500 text-white'}`}>
                {incoming ? '↓' : '↑'}
            </span>
        </div>
    );
}

export default function DashboardPage() {
    const router = useRouter();
    // Consecutive 401s from the background dashboard poll before we treat the
    // session as truly dead. A single transient 401 (stale request signature, a
    // backgrounded tab during KYC) must NOT log the user out mid-flow.
    const auth401Count = useRef(0);
    const [spotPortfolio, setSpotPortfolio] = useState<Portfolio | null>(null);
    const [moneyPortfolio, setMoneyPortfolio] = useState<Portfolio | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [username, setUsername] = useState<string | null>(null);
    const [accessToken, setAccessToken] = useState<string | null>(null);

    const [selectedToken, setSelectedToken] = useState<any>(null);
    const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
    const [selectedOfframpToken, setSelectedOfframpToken] = useState<any>(null);
    const [isOfframpModalOpen, setIsOfframpModalOpen] = useState(false);
    const [activeTab, setActiveTab] = useState<'tokens' | 'unclaimed' | 'activity'>('tokens');
    const [recentActivity, setRecentActivity] = useState<any[]>([]);
    const [selectedCurrency, setSelectedCurrency] = useState<string>('USD');
    const [activeWallet, setActiveWallet] = useState<ActiveWallet>('spot');
    const [depositRegistered, setDepositRegistered] = useState(false);
    const [depositMessage, setDepositMessage] = useState<string | null>(null);
    const { registerForDeposits, isRegistering, error: depositError } = useDepositRegistration();
    const { registerForSpotDeposits, isRegistering: isSpotRegistering, error: spotDepositError } = useSpotDepositRegistration();
    const [spotDepositMessage, setSpotDepositMessage] = useState<string | null>(null);
    const [spotDepositAddress, setSpotDepositAddress] = useState<string | null>(null);
    const { enableSweep, isEnabling, error: sweepError } = useSweepEnable();
    const { deployWallet, activateSpotOnChain, isSending: isDeploying } = useRhinestoneTransfer();
    const [activateMessage, setActivateMessage] = useState<string | null>(null);
    const [deployMessage, setDeployMessage] = useState<string | null>(null);
    const [sweepEnabled, setSweepEnabled] = useState(false);
    const [sweepMessage, setSweepMessage] = useState<string | null>(null);
    const { status: sessionStatus, refresh: refreshSessionStatus } = useSessionStatus();
    const { extendSession, isExtending, error: extendError } = useExtendSession();
    const [extendMessage, setExtendMessage] = useState<string | null>(null);

    const handleExtendSession = async () => {
        setExtendMessage(null);
        try {
            const result = await extendSession();
            if (result) {
                setExtendMessage(
                    `Authorized chains: ${result.approvedChainIds.join(', ')}`,
                );
            } else {
                setExtendMessage('No new chains to authorize');
            }
            await refreshSessionStatus();
        } catch {
            // useExtendSession already surfaces error via `extendError`
        }
    };

    // Unclaimed tokens state
    const [unclaimedTokens, setUnclaimedTokens] = useState<any>(null);
    const [unclaimedLoading, setUnclaimedLoading] = useState(false);
    const [claimRecipient, setClaimRecipient] = useState<string | undefined>(undefined);
    const [claimAmount, setClaimAmount] = useState<string | undefined>(undefined);
    // True when the transfer modal is opened for a claim (Money→Spot). Forces the
    // transfer source to the Money wallet and records via /transactions/claim.
    const [isClaimMode, setIsClaimMode] = useState(false);

    // Parse wallet addresses from localStorage
    const walletAddresses = useMemo<WalletAddresses>(() => {
        try {
            const walletsData = localStorage.getItem('wallets');
            if (walletsData) {
                const wallets = JSON.parse(walletsData);
                // Initialize deposit registration state from stored wallet data
                if (wallets?.money?.depositRegistered) {
                    setDepositRegistered(true);
                }
                return {
                    spotEvm: wallets?.spot?.evm?.address || null,
                    spotSvm: wallets?.spot?.svm?.address || null,
                    moneyEvm: wallets?.money?.evm?.address || null,
                    moneySvm: wallets?.money?.svm?.address || null,
                };
            }
        } catch (e) {
            console.error('Error parsing wallet data:', e);
        }
        return { spotEvm: null, spotSvm: null, moneyEvm: null, moneySvm: null };
    }, []);

    useEffect(() => {
        const token = localStorage.getItem('accessToken');
        const storedUsername = localStorage.getItem('username');
        if (storedUsername) setUsername(storedUsername);

        if (!token) {
            router.push('/');
            return;
        }
        setAccessToken(token);
    }, []);

    // Single source for the wallet screen: /transactions/dashboard returns both
    // wallets' USD+PKR totals, the active wallet's assets, and the last 4 activity
    // items. We map it into the existing spot/money portfolio shapes so the render
    // stays the same — just now polled, so balances/activity update without a
    // manual refresh.
    const fetchDashboard = useCallback(async () => {
        if (!localStorage.getItem('accessToken')) return;
        try {
            const res = await signedFetch(
                `/transactions/dashboard?walletType=${activeWallet}`,
                { auth: true },
            );
            if (res.status === 401) {
                // Only log out after repeated 401s — a lone transient one (stale
                // signature, blip while backgrounded) must not nuke the session.
                if (++auth401Count.current >= 3) {
                    localStorage.removeItem('accessToken');
                    router.push('/');
                }
                return;
            }
            if (res.ok) {
                auth401Count.current = 0;
                const d = await res.json();
                setMoneyPortfolio((prev) => ({
                    totalUsd: d.wallets.money.usd,
                    convertedTotals: { PKR: d.wallets.money.pkr },
                    assets: activeWallet === 'money' ? mapDashboardAssets(d.assets) : (prev?.assets ?? []),
                }));
                setSpotPortfolio((prev) => ({
                    totalUsd: d.wallets.spot.usd,
                    convertedTotals: { PKR: d.wallets.spot.pkr },
                    assets: activeWallet === 'spot' ? mapDashboardAssets(d.assets) : (prev?.assets ?? []),
                }));
                setRecentActivity(d.recentActivity ?? []);
                if (activeWallet === 'money') fetchUnclaimedTokens();
            }
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, [activeWallet, router]);

    // Fetch on mount + whenever the active wallet changes, and poll every 8s.
    useEffect(() => {
        if (!accessToken) return;
        fetchDashboard();
        const id = setInterval(fetchDashboard, 8000);
        return () => clearInterval(id);
    }, [accessToken, fetchDashboard]);

    const fetchUnclaimedTokens = async () => {
        setUnclaimedLoading(true);
        try {
            const res = await signedFetch('/transactions/unclaimed', {
                auth: true,
                headers: { 'ngrok-skip-browser-warning': 'true' },
            });
            if (res.ok) setUnclaimedTokens(await res.json());
        } catch (err) {
            console.error('Failed to fetch unclaimed tokens:', err);
        } finally {
            setUnclaimedLoading(false);
        }
    };

    const handleLogout = () => {
        localStorage.removeItem('accessToken');
        localStorage.removeItem('username');
        localStorage.removeItem('wallets');
        router.push('/');
    };

    const openTransferModal = (asset: Asset, chain: ChainBreakdown) => {
        setIsClaimMode(false);
        setClaimRecipient(undefined);
        setClaimAmount(undefined);
        setSelectedToken({
            symbol: asset.symbol,
            name: asset.name,
            balance: chain.balance,
            decimals: asset.decimals,
            address: chain.address,
            chainId: chain.chainId,
            type: chain.type
        });
        setIsTransferModalOpen(true);
    };

    const getCurrencySymbol = (currency: string) => {
        const symbols: Record<string, string> = {
            'USD': '$', 'PKR': 'Rs', 'EUR': '€', 'GBP': '£',
            'INR': '₹', 'AED': 'AED', 'SAR': 'SAR', 'JPY': '¥', 'CNY': '¥'
        };
        return symbols[currency] || currency;
    };

    // Copy button component
    const CopyButton = ({ address, id }: { address: string; id: string }) => (
        <button
            onClick={() => {
                navigator.clipboard.writeText(address);
                const btn = document.getElementById(id);
                if (btn) {
                    const orig = btn.innerHTML;
                    btn.innerHTML = '<svg class="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>';
                    setTimeout(() => btn.innerHTML = orig, 2000);
                }
            }}
            id={id}
            className="p-2 hover:bg-slate-200 rounded transition text-slate-500 hover:text-slate-700"
            title="Copy address"
        >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
        </button>
    );

    // historyChains removed — history is now a dedicated page

    if (loading) return <div className="min-h-screen flex items-center justify-center">Loading...</div>;

    const walletConfig = {
        spot: {
            label: '💰 Spot Wallet',
            subtitle: 'All assets across EVM & SVM chains',
            gradient: 'from-purple-600 to-indigo-600',
            accentBorder: 'border-purple-500',
            tabActive: 'border-purple-600 text-purple-600',
        },
        money: {
            label: '🏦 Money Wallet',
            subtitle: 'Spendable stables — USDC on BSC',
            gradient: 'from-emerald-600 to-teal-600',
            accentBorder: 'border-emerald-500',
            tabActive: 'border-emerald-600 text-emerald-600',
        }
    };

    const cfg = walletConfig[activeWallet];
    const currentPortfolio = activeWallet === 'spot' ? spotPortfolio : moneyPortfolio;

    return (
        <div className="min-h-screen bg-slate-50 p-6">
            <div className="max-w-4xl mx-auto">
                {/* Header */}
                <div className="flex justify-between items-center mb-6">
                    <div className="flex items-center gap-3">
                        <button
                            onClick={() => router.push('/dashboard/avatar-select')}
                            className="w-10 h-10 rounded-full bg-emerald-100 hover:bg-emerald-200 flex items-center justify-center transition"
                            title="Change avatar"
                        >
                            <span className="text-lg">😀</span>
                        </button>
                        <div>
                            <h1 className="text-3xl font-bold text-slate-900">My Wallets</h1>
                            {username && <p className="text-slate-500">Welcome back, @{username}</p>}
                        </div>
                    </div>
                    <div className="flex items-center gap-4">
                        <button
                            onClick={() => {
                                setLoading(true);
                                if (localStorage.getItem('accessToken')) fetchDashboard();
                            }}
                            disabled={loading}
                            className="text-emerald-600 hover:text-emerald-700 font-medium flex items-center gap-2 disabled:opacity-50"
                        >
                            <svg className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                            {loading ? 'Refreshing...' : 'Refresh'}
                        </button>
                        <button onClick={() => router.push('/')} className="text-slate-600 hover:text-slate-900 font-medium">
                            Back to Home
                        </button>
                        <button onClick={handleLogout} className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-lg transition font-medium">
                            Logout
                        </button>
                    </div>
                </div>

                {/* Wallet Switcher */}
                <div className="flex gap-3 mb-6">
                    <button
                        onClick={() => { setActiveWallet('spot'); setActiveTab('tokens'); }}
                        className={`flex-1 px-5 py-4 rounded-xl font-semibold text-left transition-all border-2 ${
                            activeWallet === 'spot'
                                ? 'border-purple-500 bg-purple-50 text-purple-800 shadow-sm'
                                : 'border-slate-200 bg-white text-slate-600 hover:border-purple-300 hover:bg-purple-50/50'
                        }`}
                    >
                        <div className="flex items-center justify-between">
                            <div>
                                <span className="text-lg">💰</span>
                                <span className="ml-2 font-bold">Spot Wallet</span>
                                <p className="text-xs mt-1 opacity-70">All assets</p>
                            </div>
                            {spotPortfolio && (
                                <span className="text-lg font-bold">${spotPortfolio.totalUsd}</span>
                            )}
                        </div>
                    </button>
                    <button
                        onClick={() => { setActiveWallet('money'); setActiveTab('tokens'); }}
                        className={`flex-1 px-5 py-4 rounded-xl font-semibold text-left transition-all border-2 ${
                            activeWallet === 'money'
                                ? 'border-emerald-500 bg-emerald-50 text-emerald-800 shadow-sm'
                                : 'border-slate-200 bg-white text-slate-600 hover:border-emerald-300 hover:bg-emerald-50/50'
                        }`}
                    >
                        <div className="flex items-center justify-between">
                            <div>
                                <span className="text-lg">🏦</span>
                                <span className="ml-2 font-bold">Money Wallet</span>
                                <p className="text-xs mt-1 opacity-70">Spendable stables</p>
                            </div>
                            {moneyPortfolio && (
                                <span className="text-lg font-bold">${moneyPortfolio.totalUsd}</span>
                            )}
                        </div>
                    </button>
                </div>

                {error && <div className="bg-red-50 text-red-600 p-4 rounded-lg mb-6">{error}</div>}

                {/* New-chain re-authorization banner. Shows only when the user is already
                    registered AND one or more active EVM chains were added after their
                    last session sign. One passkey signature covers all pending chains. */}
                {sessionStatus?.needsAction && (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 mb-6">
                        <div className="flex items-start justify-between gap-4">
                            <div className="flex-1">
                                <h3 className="font-bold text-amber-900 mb-1">
                                    New chains available — authorize to enable deposits
                                </h3>
                                <p className="text-sm text-amber-800">
                                    {sessionStatus.pending.length === 1
                                        ? `${sessionStatus.pending[0].name} was added after you set up your Money wallet. Sign once to start accepting deposits from it.`
                                        : `${sessionStatus.pending.length} new chains were added after you set up your Money wallet. One signature authorizes them all.`}
                                </p>
                                <p className="text-xs text-amber-700 mt-2">
                                    Pending: {sessionStatus.pending.map((c) => `${c.name} (${c.chainId})`).join(', ')}
                                </p>
                                {extendMessage && (
                                    <p className="text-xs mt-2 text-emerald-700">{extendMessage}</p>
                                )}
                                {extendError && (
                                    <p className="text-xs mt-2 text-red-600">{extendError}</p>
                                )}
                            </div>
                            <button
                                onClick={handleExtendSession}
                                disabled={isExtending}
                                className="px-5 py-2 bg-amber-600 text-white font-semibold rounded-lg hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                            >
                                {isExtending ? 'Signing…' : 'Authorize'}
                            </button>
                        </div>
                    </div>
                )}

                {/* Active Wallet Content */}
                <div className="space-y-6">
                    {/* Balance Card */}
                    <div className={`bg-gradient-to-r ${cfg.gradient} rounded-2xl p-8 text-white shadow-lg`}>
                        <div className="flex justify-between items-start mb-2">
                            <div>
                                <p className="text-white/80 font-medium text-sm">{cfg.label}</p>
                                <p className="text-white/60 text-xs">{cfg.subtitle}</p>
                            </div>
                            {currentPortfolio?.convertedTotals && Object.keys(currentPortfolio.convertedTotals).length > 0 && (
                                <select
                                    value={selectedCurrency}
                                    onChange={(e) => setSelectedCurrency(e.target.value)}
                                    className="bg-white text-slate-900 rounded-lg px-3 py-1 text-sm font-medium border border-white/30 focus:outline-none focus:ring-2 focus:ring-white/40 cursor-pointer"
                                >
                                    <option value="USD">USD</option>
                                    {Object.keys(currentPortfolio.convertedTotals).map(currency => (
                                        <option key={currency} value={currency}>{currency}</option>
                                    ))}
                                </select>
                            )}
                        </div>
                        <h2 className="text-4xl font-bold mt-3">
                            {selectedCurrency === 'USD'
                                ? `$${currentPortfolio?.totalUsd || '0.00'}`
                                : `${getCurrencySymbol(selectedCurrency)} ${currentPortfolio?.convertedTotals?.[selectedCurrency] || '0.00'}`
                            }
                        </h2>
                    </div>

                    {/* Addresses */}
                    <div className={`bg-white rounded-xl shadow-sm border ${cfg.accentBorder} border-opacity-30 p-5`}>
                        <h3 className="text-sm font-bold text-slate-700 mb-3 uppercase tracking-wide">Addresses</h3>
                        <div className="space-y-2">
                            {activeWallet === 'spot' ? (
                                <>
                                    {walletAddresses.spotEvm && (
                                        <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                                            <div className="flex items-center gap-3">
                                                <span className="px-2 py-1 rounded text-xs font-bold uppercase bg-blue-100 text-blue-700">EVM</span>
                                                <code className="text-sm text-slate-600 font-mono">{walletAddresses.spotEvm.slice(0, 8)}...{walletAddresses.spotEvm.slice(-6)}</code>
                                            </div>
                                            <CopyButton address={walletAddresses.spotEvm} id="spot-evm-copy" />
                                        </div>
                                    )}
                                    {walletAddresses.spotSvm && (
                                        <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                                            <div className="flex items-center gap-3">
                                                <span className="px-2 py-1 rounded text-xs font-bold uppercase bg-purple-100 text-purple-700">SVM</span>
                                                <code className="text-sm text-slate-600 font-mono">{walletAddresses.spotSvm.slice(0, 8)}...{walletAddresses.spotSvm.slice(-6)}</code>
                                            </div>
                                            <CopyButton address={walletAddresses.spotSvm} id="spot-svm-copy" />
                                        </div>
                                    )}
                                </>
                            ) : (
                                <>
                                    {walletAddresses.moneyEvm && (
                                        <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                                            <div className="flex items-center gap-3">
                                                <span className="px-2 py-1 rounded text-xs font-bold uppercase bg-emerald-100 text-emerald-700">EVM</span>
                                                <code className="text-sm text-slate-600 font-mono">{walletAddresses.moneyEvm.slice(0, 8)}...{walletAddresses.moneyEvm.slice(-6)}</code>
                                            </div>
                                            <CopyButton address={walletAddresses.moneyEvm} id="money-evm-copy" />
                                        </div>
                                    )}
                                    <p className="text-xs text-slate-400 italic px-3">BSC network · USDC target</p>

                                    {/* Auto-Deposits Registration */}
                                    <div className="mt-3 p-4 bg-emerald-50 rounded-lg border border-emerald-200">
                                        {depositRegistered ? (
                                            <div className="flex items-center gap-2">
                                                <span className="text-emerald-600 text-lg">✅</span>
                                                <div>
                                                    <p className="text-sm font-semibold text-emerald-800">Auto-Deposits Enabled</p>
                                                    <p className="text-xs text-emerald-600">Stablecoins sent to your address on any chain will auto-bridge to USDC on BSC</p>
                                                </div>
                                            </div>
                                        ) : (
                                            <div>
                                                <div className="flex items-center justify-between">
                                                    <div>
                                                        <p className="text-sm font-semibold text-emerald-800">Enable Auto-Deposits</p>
                                                        <p className="text-xs text-emerald-600">Auto-bridge USDC/USDT from any chain to USDC on BSC</p>
                                                    </div>
                                                    <button
                                                        onClick={async () => {
                                                            if (!accessToken) return;
                                                            setDepositMessage(null);
                                                            try {
                                                                const result = await registerForDeposits(accessToken);
                                                                setDepositRegistered(true);
                                                                setDepositMessage(result.message);
                                                                // Persist solanaDepositAddress as money SVM address in localStorage
                                                                if (result.solanaDepositAddress) {
                                                                    try {
                                                                        const walletsData = localStorage.getItem('wallets');
                                                                        if (walletsData) {
                                                                            const wallets = JSON.parse(walletsData);
                                                                            if (wallets.money) {
                                                                                wallets.money.svm = { address: result.solanaDepositAddress };
                                                                                wallets.money.depositRegistered = true;
                                                                                localStorage.setItem('wallets', JSON.stringify(wallets));
                                                                            }
                                                                        }
                                                                    } catch (e) { /* ignore localStorage errors */ }
                                                                }
                                                            } catch (err: any) {
                                                                setDepositMessage(err?.message || 'Registration failed');
                                                            }
                                                        }}
                                                        disabled={isRegistering || !accessToken}
                                                        className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                                                    >
                                                        {isRegistering ? (
                                                            <>
                                                                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                                                                </svg>
                                                                Signing...
                                                            </>
                                                        ) : (
                                                            '🔐 Enable'
                                                        )}
                                                    </button>
                                                </div>
                                                {depositMessage && (
                                                    <p className={`text-xs mt-2 ${depositError ? 'text-red-600' : 'text-emerald-600'}`}>
                                                        {depositMessage}
                                                    </p>
                                                )}
                                                {depositError && (
                                                    <p className="text-xs mt-1 text-red-600">{depositError}</p>
                                                )}
                                            </div>
                                        )}
                                    </div>

                                    {/* Spot Auto-Deposit — settle whitelisted assets as their own token on Base */}
                                    <div className="p-4 bg-sky-50 border border-sky-200 rounded-lg">
                                        {spotDepositAddress ? (
                                            <div>
                                                <div className="flex items-center gap-3">
                                                    <div className="w-8 h-8 bg-sky-100 rounded-full flex items-center justify-center text-sky-700">✓</div>
                                                    <div>
                                                        <p className="text-sm font-semibold text-sky-800">Spot Auto-Deposit Enabled</p>
                                                        <p className="text-xs text-sky-600">Whitelisted assets sent to your spot deposit address settle as that asset on Base</p>
                                                    </div>
                                                </div>
                                                <p className="text-xs text-sky-700 mt-2 break-all">
                                                    <span className="font-semibold">Deposit address:</span> {spotDepositAddress}
                                                </p>
                                            </div>
                                        ) : (
                                            <div>
                                                <div className="flex items-center justify-between">
                                                    <div>
                                                        <p className="text-sm font-semibold text-sky-800">Enable Spot Auto-Deposit</p>
                                                        <p className="text-xs text-sky-600">Deposit ETH/BTC/USDC/USDT/DAI from Eth/Polygon/BNB/Arbitrum → settles as that asset on Base</p>
                                                    </div>
                                                    <button
                                                        onClick={async () => {
                                                            if (!accessToken) return;
                                                            setSpotDepositMessage(null);
                                                            try {
                                                                const result = await registerForSpotDeposits(accessToken);
                                                                setSpotDepositAddress(result.evmDepositAddress || result.address);
                                                                setSpotDepositMessage(result.message);
                                                            } catch (err: any) {
                                                                setSpotDepositMessage(err?.message || 'Registration failed');
                                                            }
                                                        }}
                                                        disabled={isSpotRegistering || !accessToken}
                                                        className="px-4 py-2 bg-sky-600 hover:bg-sky-700 text-white text-sm font-medium rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                                                    >
                                                        {isSpotRegistering ? (
                                                            <>
                                                                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                                                                </svg>
                                                                Signing...
                                                            </>
                                                        ) : (
                                                            '🔐 Enable'
                                                        )}
                                                    </button>
                                                </div>
                                                {spotDepositMessage && (
                                                    <p className={`text-xs mt-2 ${spotDepositError ? 'text-red-600' : 'text-sky-600'}`}>
                                                        {spotDepositMessage}
                                                    </p>
                                                )}
                                                {spotDepositError && (
                                                    <p className="text-xs mt-1 text-red-600">{spotDepositError}</p>
                                                )}
                                            </div>
                                        )}
                                    </div>

                                    {/* Activate Spot on a chain: deploy + Permit2-approve so spot funds
                                        can be withdrawn/swapped (orchestrator sources via Permit2 transferFrom). */}
                                    <div className="p-4 bg-purple-50 border border-purple-200 rounded-lg">
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <p className="text-sm font-semibold text-purple-800">Activate Spot on Arbitrum</p>
                                                <p className="text-xs text-purple-600">Deploy + approve Permit2 (USDC, USDT) — required once before you can withdraw/swap spot funds on Arbitrum</p>
                                            </div>
                                            <button
                                                onClick={async () => {
                                                    if (!accessToken) return;
                                                    setActivateMessage(null);
                                                    try {
                                                        const result = await activateSpotOnChain({
                                                            accessToken,
                                                            chainId: 42161,
                                                            tokenAddresses: [
                                                                '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // USDC (Arb)
                                                                '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // USDT (Arb)
                                                            ],
                                                        });
                                                        setActivateMessage(`Activated ✓  tx: ${result.hash}`);
                                                    } catch (err: any) {
                                                        setActivateMessage(err?.message || 'Activation failed');
                                                    }
                                                }}
                                                disabled={isDeploying || !accessToken}
                                                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                                {isDeploying ? 'Activating…' : '⚡ Activate'}
                                            </button>
                                        </div>
                                        {activateMessage && (
                                            <p className="text-xs mt-2 text-purple-700 break-all">{activateMessage}</p>
                                        )}
                                    </div>

                                    {/* TEMP (deposit debug): pre-deploy the Money wallet on Base so the
                                        first deposit only enables the session, not deploy+enable in one tx. */}
                                    <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <p className="text-sm font-semibold text-amber-800">Deploy Money Wallet (Base)</p>
                                                <p className="text-xs text-amber-600">One-time: install the wallet on-chain before the first deposit</p>
                                            </div>
                                            <button
                                                onClick={async () => {
                                                    if (!accessToken) return;
                                                    setDeployMessage(null);
                                                    try {
                                                        const r = await deployWallet({ accessToken, walletType: 'money', chainId: 8453 });
                                                        setDeployMessage(`deployed=${r.deployed} — ${r.address}`);
                                                    } catch (err: any) {
                                                        setDeployMessage(err?.message || 'Deploy failed');
                                                    }
                                                }}
                                                disabled={isDeploying || !accessToken}
                                                className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium rounded-lg transition disabled:opacity-50"
                                            >
                                                {isDeploying ? 'Deploying…' : '🚀 Deploy'}
                                            </button>
                                        </div>
                                        {deployMessage && (
                                            <p className="text-xs mt-2 text-amber-700 break-all">{deployMessage}</p>
                                        )}
                                    </div>

                                    {/* Auto-Sweep enable — non-bridgeable deposits get moved Money → Spot */}
                                    <div className="p-3 bg-indigo-50 border border-indigo-100 rounded-lg">
                                        {sweepEnabled ? (
                                            <div className="flex items-center gap-3">
                                                <span className="text-indigo-600">🧹</span>
                                                <div>
                                                    <p className="text-sm font-semibold text-indigo-800">Auto-Sweep Enabled</p>
                                                    <p className="text-xs text-indigo-600">Tokens that can’t bridge to USDC (e.g. DAI, WETH) auto-move to your Spot wallet</p>
                                                </div>
                                            </div>
                                        ) : (
                                            <div>
                                                <div className="flex items-center justify-between">
                                                    <div>
                                                        <p className="text-sm font-semibold text-indigo-800">Enable Auto-Sweep</p>
                                                        <p className="text-xs text-indigo-600">Move non-bridgeable deposits from Money → Spot automatically</p>
                                                    </div>
                                                    <button
                                                        onClick={async () => {
                                                            if (!accessToken) return;
                                                            setSweepMessage(null);
                                                            try {
                                                                const result = await enableSweep();
                                                                setSweepEnabled(true);
                                                                setSweepMessage(`Enabled on chains: ${result.chainIds.join(', ')}`);
                                                            } catch (err: any) {
                                                                setSweepMessage(err?.message || 'Sweep enable failed');
                                                            }
                                                        }}
                                                        disabled={isEnabling || !accessToken}
                                                        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                                                    >
                                                        {isEnabling ? (
                                                            <>
                                                                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                                                                </svg>
                                                                Signing...
                                                            </>
                                                        ) : (
                                                            '🔐 Enable'
                                                        )}
                                                    </button>
                                                </div>
                                                {sweepMessage && (
                                                    <p className={`text-xs mt-2 ${sweepError ? 'text-red-600' : 'text-indigo-600'}`}>
                                                        {sweepMessage}
                                                    </p>
                                                )}
                                                {sweepError && (
                                                    <p className="text-xs mt-1 text-red-600">{sweepError}</p>
                                                )}
                                            </div>
                                        )}
                                    </div>

                                    {/* Money Wallet SVM Address (Rhinestone Solana Deposit Address) */}
                                    {walletAddresses.moneySvm && (
                                        <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                                            <div className="flex items-center gap-3">
                                                <span className="px-2 py-1 rounded text-xs font-bold uppercase bg-purple-100 text-purple-700">SVM</span>
                                                <div>
                                                    <code className="text-sm text-slate-600 font-mono">{walletAddresses.moneySvm.slice(0, 8)}...{walletAddresses.moneySvm.slice(-6)}</code>
                                                    {depositRegistered && (
                                                        <p className="text-xs text-emerald-600 mt-0.5">Send SOL/USDC here → auto-bridges to USDC on BSC</p>
                                                    )}
                                                </div>
                                            </div>
                                            <CopyButton address={walletAddresses.moneySvm} id="money-svm-copy" />
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>

                    {/* Assets / Unclaimed Tabs + History Link */}
                    <div className="flex border-b border-slate-200 mb-0">
                        <button
                            onClick={() => setActiveTab('tokens')}
                            className={`px-6 py-3 text-sm font-medium border-b-2 transition ${activeTab === 'tokens'
                                ? cfg.tabActive
                                : 'border-transparent text-slate-500 hover:text-slate-700'
                            }`}
                        >
                            Assets
                        </button>
                        <button
                            onClick={() => setActiveTab('activity')}
                            className={`px-6 py-3 text-sm font-medium border-b-2 transition ${activeTab === 'activity'
                                ? cfg.tabActive
                                : 'border-transparent text-slate-500 hover:text-slate-700'
                            }`}
                        >
                            Activity
                        </button>
                        {activeWallet === 'money' && (
                            <button
                                onClick={() => setActiveTab('unclaimed')}
                                className={`px-6 py-3 text-sm font-medium border-b-2 transition ${activeTab === 'unclaimed'
                                    ? 'border-amber-500 text-amber-600'
                                    : 'border-transparent text-slate-500 hover:text-slate-700'
                                }`}
                            >
                                Unclaimed
                                {unclaimedTokens && unclaimedTokens.assets.length > 0 && (
                                    <span className="ml-1.5 bg-amber-100 text-amber-700 text-xs font-bold px-1.5 py-0.5 rounded-full">
                                        {unclaimedTokens.assets.length}
                                    </span>
                                )}
                            </button>
                        )}
                        <div className="flex-1" />
                        {activeWallet === 'money' && (
                            <button
                                onClick={() => router.push('/dashboard/payment-requests')}
                                className="px-4 py-3 text-sm font-medium text-slate-500 hover:text-slate-700 transition flex items-center gap-1.5 border-b-2 border-transparent"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
                                </svg>
                                Requests
                            </button>
                        )}
                        {activeWallet === 'money' && (
                            <button
                                onClick={() => router.push('/dashboard/getpaid')}
                                className="px-4 py-3 text-sm font-medium text-slate-500 hover:text-slate-700 transition flex items-center gap-1.5 border-b-2 border-transparent"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 9v1m0-1c-1.11 0-2.08-.402-2.599-1" />
                                </svg>
                                Get Paid
                            </button>
                        )}
                        {activeWallet === 'money' && (
                            <button
                                onClick={() => {
                                    // Money-mode off-ramp: source USDC on Base (Walapay's
                                    // rail) from the Money wallet address. The backend sees
                                    // this fromAddress is the Money (BSC) wallet and funds it
                                    // cross-chain (bridges BSC USDT -> Base USDC).
                                    setSelectedOfframpToken({
                                        symbol: 'USDC',
                                        name: 'Money Wallet',
                                        balance: moneyPortfolio?.totalUsd || '0',
                                        address: walletAddresses.moneyEvm,
                                        chainId: 8453,
                                        type: 'evm',
                                    });
                                    setIsOfframpModalOpen(true);
                                }}
                                disabled={!walletAddresses.moneyEvm}
                                className="px-4 py-3 text-sm font-medium text-emerald-600 hover:text-emerald-700 disabled:opacity-40 transition flex items-center gap-1.5 border-b-2 border-transparent"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                                </svg>
                                Withdraw to Bank
                            </button>
                        )}
                        <button
                            onClick={() => router.push('/dashboard/history')}
                            className="px-4 py-3 text-sm font-medium text-slate-500 hover:text-slate-700 transition flex items-center gap-1.5 border-b-2 border-transparent"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            History
                        </button>
                    </div>

                    {/* Tab Content */}
                    {activeTab === 'tokens' ? (
                        <div className="space-y-6">
                            {currentPortfolio && currentPortfolio.assets.length > 0 ? (
                                currentPortfolio.assets.map((asset, idx) => (
                                    <div key={idx} className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                                        <div className="bg-slate-50 px-6 py-4 border-b border-slate-200">
                                            <div className="flex items-center justify-between">
                                                <div className="flex items-center gap-4">
                                                    <TokenIcon symbol={asset.symbol} logoUrl={asset.logoUrl} gradient={cfg.gradient} />
                                                    <div>
                                                        <h3 className="font-bold text-slate-900 text-lg">{asset.name}</h3>
                                                        <p className="text-sm text-slate-500">{asset.symbol}</p>
                                                    </div>
                                                </div>
                                                <div className="text-right">
                                                    <p className="text-2xl font-bold text-slate-900">{parseFloat(asset.totalBalance).toFixed(6)}</p>
                                                    <p className="text-sm text-slate-500">${asset.totalUsdValue} USD</p>
                                                </div>
                                            </div>
                                        </div>

                                        {/* Chain Breakdown */}
                                        <div className="divide-y divide-slate-100">
                                            <div className="px-6 py-2">
                                                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Chain Breakdown</p>
                                            </div>
                                            {asset.chains.map((chain, i) => (
                                                <div key={i} className="px-6 py-4 flex items-center justify-between hover:bg-slate-50 transition">
                                                    <div className="flex items-center gap-4">
                                                        <span className={`px-2 py-1 rounded text-xs font-bold uppercase ${chain.type === 'evm' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                                                            {chain.type}
                                                        </span>
                                                        <div>
                                                            <p className="font-semibold text-slate-900">{chain.network}</p>
                                                            <p className="text-xs text-slate-500 font-mono">
                                                                {chain.address === 'native' ? 'Native Token' : `${chain.address.slice(0, 6)}...${chain.address.slice(-4)}`}
                                                            </p>
                                                        </div>
                                                    </div>
                                                    <div className="flex items-center gap-6">
                                                        <div className="text-right">
                                                            <p className="font-bold text-slate-900">{parseFloat(chain.balance).toFixed(6)}</p>
                                                            <p className="text-xs text-slate-500">${chain.usdValue.toFixed(2)}</p>
                                                        </div>
                                                        <div className="flex items-center gap-2">
                                                            <button
                                                                onClick={() => openTransferModal(asset, chain)}
                                                                disabled={parseFloat(chain.balance) === 0}
                                                                className={`px-4 py-2 text-white rounded-lg text-sm font-semibold transition ${
                                                                    parseFloat(chain.balance) === 0
                                                                        ? 'bg-slate-300 cursor-not-allowed'
                                                                        : chain.type === 'evm'
                                                                            ? 'bg-slate-900 hover:bg-slate-800'
                                                                            : 'bg-purple-600 hover:bg-purple-700'
                                                                }`}
                                                            >
                                                                Transfer
                                                            </button>
                                                            {['USDC', 'USDT'].includes(asset.symbol.toUpperCase()) && (
                                                                <button
                                                                    onClick={() => {
                                                                        setSelectedOfframpToken({
                                                                            symbol: asset.symbol,
                                                                            name: asset.name,
                                                                            balance: chain.balance,
                                                                            address: chain.address,
                                                                            chainId: chain.chainId,
                                                                            type: chain.type,
                                                                        });
                                                                        setIsOfframpModalOpen(true);
                                                                    }}
                                                                    disabled={parseFloat(chain.balance) === 0}
                                                                    className={`px-4 py-2 rounded-lg text-sm font-semibold transition ${
                                                                        parseFloat(chain.balance) === 0
                                                                            ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                                                                            : 'bg-amber-500 hover:bg-amber-600 text-white'
                                                                    }`}
                                                                >
                                                                    Off-Ramp
                                                                </button>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ))
                            ) : (
                                <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-10 text-center text-slate-500 italic">
                                    No assets found in {activeWallet === 'spot' ? 'Spot' : 'Money'} Wallet
                                </div>
                            )}
                        </div>
                    ) : activeTab === 'unclaimed' ? (
                        /* Unclaimed Tokens Tab */
                        <div className="space-y-4">
                            {unclaimedLoading ? (
                                <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-10 text-center text-slate-500">Loading unclaimed tokens...</div>
                            ) : unclaimedTokens && unclaimedTokens.assets.length > 0 ? (
                                <>
                                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-700">
                                        These tokens were deposited to your Money Wallet but are not auto-bridged. Claim them to move to your Spot Wallet.
                                    </div>
                                    {unclaimedTokens.assets.map((asset: any, idx: number) => (
                                        <div key={idx} className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                                            <div className="px-6 py-4 flex items-center justify-between">
                                                <div className="flex items-center gap-4">
                                                    <TokenIcon symbol={asset.symbol} logoUrl={asset.logoUrl} gradient="from-amber-400 to-orange-500" sizeClass="h-10 w-10" textClass="" />
                                                    <div>
                                                        <h3 className="font-bold text-slate-900">{asset.name}</h3>
                                                        <p className="text-sm text-slate-500">{asset.symbol}</p>
                                                    </div>
                                                </div>
                                                <div className="text-right">
                                                    <p className="text-lg font-bold text-slate-900">{parseFloat(asset.totalBalance).toFixed(6)}</p>
                                                    <p className="text-xs text-slate-500">${asset.totalUsdValue} USD</p>
                                                </div>
                                            </div>
                                            <div className="divide-y divide-slate-100">
                                                {asset.chains.map((chain: any, i: number) => (
                                                    <div key={i} className="px-6 py-3 flex items-center justify-between bg-slate-50">
                                                        <div className="flex items-center gap-3">
                                                            <span className={`px-2 py-0.5 rounded text-xs font-bold uppercase ${chain.type === 'evm' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                                                                {chain.type}
                                                            </span>
                                                            <span className="text-sm text-slate-700">{chain.network}</span>
                                                        </div>
                                                        <div className="flex items-center gap-3">
                                                            <span className="text-sm font-mono text-slate-700">{parseFloat(chain.balance).toFixed(6)}</span>
                                                            <button
                                                                onClick={() => {
                                                                    const spotAddr = chain.type === 'evm'
                                                                        ? asset.claimTo?.evmAddress
                                                                        : asset.claimTo?.svmAddress;
                                                                    setIsClaimMode(true);
                                                                    setClaimRecipient(spotAddr || '');
                                                                    setClaimAmount(chain.balance);
                                                                    setSelectedToken({
                                                                        symbol: asset.symbol,
                                                                        name: asset.name,
                                                                        balance: chain.balance,
                                                                        decimals: asset.decimals,
                                                                        address: chain.address,
                                                                        chainId: chain.chainId,
                                                                        type: chain.type
                                                                    });
                                                                    setIsTransferModalOpen(true);
                                                                }}
                                                                disabled={parseFloat(chain.balance) === 0}
                                                                className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition ${parseFloat(chain.balance) === 0
                                                                    ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                                                                    : 'bg-amber-500 hover:bg-amber-600 text-white'
                                                                }`}
                                                            >
                                                                Claim
                                                            </button>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    ))}
                                </>
                            ) : (
                                <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-10 text-center text-slate-500 italic">
                                    No unclaimed tokens
                                </div>
                            )}
                        </div>
                    ) : (
                        /* Activity Tab — last 4 from /transactions/dashboard (polled) */
                        <div className="space-y-3">
                            {recentActivity.length > 0 ? (
                                recentActivity.map((tx: any, idx: number) => {
                                    const incoming = tx.direction === 'incoming';
                                    const settled = tx.status === 'settled' || tx.status === 'confirmed';
                                    // A `failed`/`refunded`/`cancelled` deposit never landed in balance —
                                    // don't paint it as a green credit even though it's `incoming`.
                                    const didNotLand = tx.status === 'failed' || tx.status === 'refunded' || tx.status === 'cancelled';
                                    return (
                                        <div key={tx._id ?? idx} className="bg-white rounded-xl shadow-sm border border-slate-200 px-6 py-4 flex items-center justify-between">
                                            <div className="flex items-center gap-4">
                                                <ActivityAvatar logoUrl={tx.logoUrl} symbol={tx.asset?.symbol} incoming={incoming} muted={didNotLand} />
                                                <div>
                                                    <h3 className="font-semibold text-slate-900 text-sm font-mono">
                                                        {tx.hash ? `${tx.hash.slice(0, 6)}…${tx.hash.slice(-4)}` : (tx.category ?? 'tx')}
                                                    </h3>
                                                    <p className="text-xs text-slate-500">
                                                        <span className="capitalize">{(tx.category ?? '').replace(/-/g, ' ')}</span>
                                                        {tx.timestamp ? ` · ${new Date(tx.timestamp).toLocaleDateString()}` : ''}
                                                        {' · '}
                                                        <span className={settled ? 'text-emerald-600' : tx.status === 'failed' ? 'text-red-500' : 'text-amber-600'}>{tx.status}</span>
                                                    </p>
                                                </div>
                                            </div>
                                            <div className="text-right">
                                                <p className={`font-bold ${didNotLand ? 'text-slate-400 line-through' : incoming ? 'text-emerald-600' : 'text-slate-900'}`}>
                                                    {didNotLand ? '' : incoming ? '+' : '-'}{tx.amountDecimal ?? ''} {tx.asset?.symbol ?? ''}
                                                </p>
                                                {tx.explorerUrl && (
                                                    <a href={tx.explorerUrl} target="_blank" rel="noreferrer" className="text-xs text-emerald-600 hover:underline">explorer</a>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })
                            ) : (
                                <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-10 text-center text-slate-500 italic">
                                    No recent activity
                                </div>
                            )}
                            <button
                                onClick={() => router.push('/dashboard/history')}
                                className="w-full text-center text-sm text-emerald-600 hover:text-emerald-700 font-medium py-2"
                            >
                                View all →
                            </button>
                        </div>
                    )}
                </div>
            </div>

            <TransferModal
                isOpen={isTransferModalOpen}
                onClose={() => { setIsTransferModalOpen(false); setClaimRecipient(undefined); setClaimAmount(undefined); setIsClaimMode(false); }}
                token={selectedToken}
                accessToken={localStorage.getItem('accessToken') || ''}
                walletType={isClaimMode ? 'money' : activeWallet}
                defaultRecipient={claimRecipient}
                defaultAmount={claimAmount}
                isClaim={isClaimMode}
            />

            <OfframpModal
                isOpen={isOfframpModalOpen}
                onClose={() => setIsOfframpModalOpen(false)}
                token={selectedOfframpToken}
                accessToken={localStorage.getItem('accessToken') || ''}
            />
        </div>
    );
}
