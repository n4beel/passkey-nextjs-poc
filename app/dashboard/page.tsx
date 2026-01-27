'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import TransferModal from './components/TransferModal';

interface Balance {
    symbol: string;
    name: string;
    balance: string;
    decimals: number;
    address: string;
}

interface ChainPortfolio {
    chainId: number;
    type: 'evm' | 'svm';
    address: string;
    network?: string;
    assets: Balance[];
}

interface Portfolio {
    totalUsd: string;
    chains: ChainPortfolio[];
}

export default function DashboardPage() {
    const router = useRouter();
    const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [username, setUsername] = useState<string | null>(null);

    const [selectedToken, setSelectedToken] = useState<any>(null);
    const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);

    useEffect(() => {
        const token = localStorage.getItem('accessToken');
        const storedUsername = localStorage.getItem('username');
        if (storedUsername) setUsername(storedUsername);

        if (!token) {
            router.push('/');
            return;
        }

        fetchBalances(token);
    }, []);

    const fetchBalances = async (token: string) => {
        try {
            const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';
            const res = await fetch(`${apiUrl}/transactions/balances`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (res.status === 401) {
                localStorage.removeItem('accessToken');
                router.push('/');
                return;
            }

            if (!res.ok) throw new Error('Failed to fetch balances');
            const data = await res.json();
            setPortfolio(data);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const handleLogout = () => {
        localStorage.removeItem('accessToken');
        localStorage.removeItem('username');
        router.push('/');
    };

    const openTransferModal = (asset: Balance, chain: ChainPortfolio) => {
        setSelectedToken({ ...asset, chainId: chain.chainId, type: chain.type });
        setIsTransferModalOpen(true);
    };

    if (loading) return <div className="min-h-screen flex items-center justify-center">Loading...</div>;

    return (
        <div className="min-h-screen bg-slate-50 p-6">
            <div className="max-w-4xl mx-auto">
                <div className="flex justify-between items-center mb-8">
                    <div>
                        <h1 className="text-3xl font-bold text-slate-900">My Wallets</h1>
                        {username && <p className="text-slate-500">Welcome back, @{username}</p>}
                    </div>
                    <div className="flex items-center gap-4">
                        <button
                            onClick={() => {
                                setLoading(true);
                                const token = localStorage.getItem('accessToken');
                                if (token) fetchBalances(token);
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

                {error && <div className="bg-red-50 text-red-600 p-4 rounded-lg mb-6">{error}</div>}

                {portfolio ? (
                    <div className="space-y-6">
                        {/* Total Balance Card */}
                        <div className="bg-gradient-to-r from-emerald-600 to-teal-600 rounded-2xl p-8 text-white shadow-lg">
                            <p className="text-emerald-100 font-medium mb-1">Total Balance</p>
                            <h2 className="text-4xl font-bold">${portfolio.totalUsd}</h2>
                        </div>

                        {/* Chains */}
                        {portfolio.chains.map((chain, idx) => (
                            <div key={idx} className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                                <div className="bg-slate-50 px-6 py-4 border-b border-slate-200 flex justify-between items-center">
                                    <div className="flex items-center gap-3">
                                        <span className={`px-2 py-0.5 rounded text-xs font-bold uppercase ${chain.type === 'evm' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                                            {chain.type}
                                        </span>
                                        <span className="font-bold text-slate-700">{chain.network || `Chain ${chain.chainId}`}</span>
                                    </div>
                                    <div className="flex items-center gap-2 text-sm text-slate-500 font-mono">
                                        <span className="opacity-50 text-xs">Address:</span>
                                        {chain.address.slice(0, 6)}...{chain.address.slice(-4)}
                                        <button
                                            onClick={() => {
                                                navigator.clipboard.writeText(chain.address);
                                                const btn = document.getElementById(`copy-btn-${idx}`);
                                                if (btn) {
                                                    const originalHTML = btn.innerHTML;
                                                    btn.innerHTML = `<svg class="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>`;
                                                    setTimeout(() => btn.innerHTML = originalHTML, 2000);
                                                }
                                            }}
                                            id={`copy-btn-${idx}`}
                                            className="p-1 hover:bg-slate-100 rounded transition text-slate-400 hover:text-slate-600"
                                            title="Copy Address"
                                        >
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                                        </button>
                                    </div>
                                </div>

                                <div className="divide-y divide-slate-100">
                                    {chain.assets.map((asset, i) => (
                                        <div key={i} className="px-6 py-4 flex items-center justify-between hover:bg-slate-50 transition">
                                            <div className="flex items-center gap-4">
                                                <div className="h-10 w-10 bg-slate-100 rounded-full flex items-center justify-center font-bold text-slate-500">
                                                    {asset.symbol[0]}
                                                </div>
                                                <div>
                                                    <p className="font-bold text-slate-900">{asset.name}</p>
                                                    <p className="text-xs text-slate-500">{asset.symbol}</p>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-6">
                                                <div className="text-right">
                                                    <p className="font-bold text-slate-900">{parseFloat(asset.balance).toFixed(4)}</p>
                                                    <p className="text-xs text-slate-500">Balance</p>
                                                </div>
                                                <button
                                                    onClick={() => openTransferModal(asset, chain)}
                                                    className={`px-4 py-2 text-white rounded-lg text-sm font-semibold transition ${chain.type === 'evm'
                                                            ? 'bg-slate-900 hover:bg-slate-800'
                                                            : 'bg-purple-600 hover:bg-purple-700'
                                                        }`}
                                                >
                                                    Transfer
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                    {chain.assets.length === 0 && (
                                        <div className="p-6 text-center text-slate-500 italic">No assets found</div>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="text-center p-10">No portfolio data found.</div>
                )}
            </div>

            <TransferModal
                isOpen={isTransferModalOpen}
                onClose={() => setIsTransferModalOpen(false)}
                token={selectedToken}
                accessToken={localStorage.getItem('accessToken') || ''}
            />
        </div>
    );
}
