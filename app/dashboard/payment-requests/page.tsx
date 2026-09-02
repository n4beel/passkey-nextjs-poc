'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { API_BASE, signedFetch } from '@/lib/api/signedFetch';
import { useRhinestoneTransfer } from '@/hooks/useRhinestoneTransfer';

/** Resolve avatar URL — prepend API_BASE if relative, use initial fallback on error */
function resolveAvatarUrl(url: string): string {
    if (!url) return '';
    if (url.startsWith('http')) return url;
    return `${API_BASE}${url}`;
}

function AvatarCircle({ username, avatarUrl, size = 'w-10 h-10' }: { username: string; avatarUrl?: string; size?: string }) {
    const [imgError, setImgError] = useState(false);
    const resolved = avatarUrl ? resolveAvatarUrl(avatarUrl) : '';

    if (!resolved || imgError) {
        const colors = ['bg-purple-500', 'bg-emerald-500', 'bg-blue-500', 'bg-pink-500', 'bg-amber-500', 'bg-cyan-500'];
        const color = colors[username.charCodeAt(0) % colors.length];
        return (
            <div className={`${size} ${color} rounded-full flex items-center justify-center text-white font-bold text-sm uppercase`}>
                {username.slice(0, 2)}
            </div>
        );
    }

    return (
        <img
            src={resolved}
            alt={username}
            className={`${size} rounded-full object-cover`}
            onError={() => setImgError(true)}
        />
    );
}

interface UserProfile {
    username: string;
    avatarUrl: string;
    wallets: {
        spot?: { evm: string | null; svm: string | null };
        money?: { evm: string | null; svm: string | null };
    };
}

interface PaymentRequest {
    _id: string;
    senderId: string;
    receiverId: string;
    senderUsername: string;
    receiverUsername: string;
    amount: string;
    tokenSymbol: string;
    tokenDecimals: number;
    tokenAddress: string;
    chainId: number;
    chainType: string;
    senderWalletAddress: string;
    receiverWalletAddress: string;
    status: 'pending' | 'approved' | 'declined';
    note?: string;
    txHash?: string;
    role: 'sender' | 'receiver';
    createdAt: string;
}

interface RecentContact {
    userId: string;
    username: string;
    lastInteraction: string;
    totalTransactions: number;
}

export default function PaymentRequestsPage() {
    const router = useRouter();
    const [tab, setTab] = useState<'requests' | 'create'>('requests');

    // PR list state
    const [requests, setRequests] = useState<PaymentRequest[]>([]);
    const [prLoading, setPrLoading] = useState(true);
    const [statusFilter, setStatusFilter] = useState('');

    // Create PR state
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<UserProfile[]>([]);
    const [searching, setSearching] = useState(false);
    const [recentContacts, setRecentContacts] = useState<RecentContact[]>([]);
    const [selectedUser, setSelectedUser] = useState<UserProfile | null>(null);
    const [createAmount, setCreateAmount] = useState('');
    const [createNote, setCreateNote] = useState('');
    const [createChainId, setCreateChainId] = useState(9745);
    const [createChainType, setCreateChainType] = useState<'evm' | 'svm'>('evm');
    const [createTokenSymbol, setCreateTokenSymbol] = useState('USDC');
    const [createTokenAddress, setCreateTokenAddress] = useState('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359');
    const [createTokenDecimals, setCreateTokenDecimals] = useState(6);
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState('');
    const [createSuccess, setCreateSuccess] = useState('');

    // Action state
    const [actionLoading, setActionLoading] = useState<string | null>(null);
    const [counts, setCounts] = useState<{ all: number; pending: number; approved: number; declined: number } | null>(null);
    const { payViaBackend } = useRhinestoneTransfer();

    // Auth check
    useEffect(() => {
        const token = localStorage.getItem('accessToken');
        if (!token) {
            router.push('/');
            return;
        }
        fetchPaymentRequests();
        fetchRecentContacts();
    }, []);

    // ── Fetch Payment Requests ──────────────────────────────────

    const fetchPaymentRequests = async () => {
        setPrLoading(true);
        try {
            const params = statusFilter ? `?status=${statusFilter}` : '';
            const res = await signedFetch(`/payment-requests${params}`, {
                auth: true,
            });
            if (res.ok) {
                const data = await res.json();
                setRequests(data.items ?? data ?? []);
                setCounts(data.counts ?? null);
            }
        } catch (e) {
            console.error('Failed to fetch PRs', e);
        } finally {
            setPrLoading(false);
        }
    };

    useEffect(() => {
        fetchPaymentRequests();
    }, [statusFilter]);

    // ── User Search ─────────────────────────────────────────────

    useEffect(() => {
        if (!searchQuery || searchQuery.length < 1) {
            setSearchResults([]);
            return;
        }

        const timeout = setTimeout(async () => {
            setSearching(true);
            try {
                const res = await signedFetch(`/onboarding/search-users?q=${encodeURIComponent(searchQuery)}`, {
                    auth: true,
                });
                if (res.ok) setSearchResults(await res.json());
            } catch (e) {
                console.error('Search failed', e);
            } finally {
                setSearching(false);
            }
        }, 300);

        return () => clearTimeout(timeout);
    }, [searchQuery]);

    // ── Recent Contacts ─────────────────────────────────────────

    const fetchRecentContacts = async () => {
        try {
            const res = await signedFetch('/transactions/recent-contacts', {
                auth: true,
            });
            if (res.ok) setRecentContacts(await res.json());
        } catch (e) {
            console.error('Failed to fetch recent contacts', e);
        }
    };

    // ── Select user from search/contacts ────────────────────────

    const selectUser = async (username: string) => {
        try {
            const res = await signedFetch(`/onboarding/user/${username}`, {
                auth: true,
            });
            if (res.ok) {
                const profile: UserProfile = await res.json();
                setSelectedUser(profile);
                setSearchQuery('');
                setSearchResults([]);
            }
        } catch (e) {
            console.error('Failed to fetch user profile', e);
        }
    };

    // ── Create Payment Request ──────────────────────────────────

    const handleCreate = async () => {
        if (!selectedUser || !createAmount) {
            setCreateError('Please select a user and enter an amount');
            return;
        }

        setCreating(true);
        setCreateError('');
        setCreateSuccess('');

        try {
            // Backend derives token/chain/addresses — we only send who + how much.
            const res = await signedFetch('/payment-requests', {
                method: 'POST',
                auth: true,
                json: {
                    handle: selectedUser.username,
                    amount: createAmount,
                    note: createNote || undefined,
                },
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.message || 'Failed to create payment request');
            }

            const created = await res.json();
            setCreateSuccess(
                `Request sent to @${selectedUser.username}! Pay link: ${created.payLink ?? ''}`,
            );
            setSelectedUser(null);
            setCreateAmount('');
            setCreateNote('');
            fetchPaymentRequests();
        } catch (e: any) {
            setCreateError(e.message);
        } finally {
            setCreating(false);
        }
    };

    // ── Decline / Approve ───────────────────────────────────────

    const handleDecline = async (prId: string) => {
        setActionLoading(prId);
        try {
            const res = await signedFetch(`/payment-requests/${prId}/decline`, {
                method: 'PATCH',
                auth: true,
            });
            if (res.ok) fetchPaymentRequests();
        } catch (e) {
            console.error('Failed to decline', e);
        } finally {
            setActionLoading(null);
        }
    };

    // Pay a request: recipient + amount come from the request; the passkey signs
    // one gasless Plasma intent (fee applied), and the backend auto-approves it.
    const handleApprove = async (pr: PaymentRequest) => {
        setActionLoading(pr._id);
        try {
            const token = localStorage.getItem('accessToken');
            if (!token) throw new Error('Not logged in');
            const res = await payViaBackend({
                accessToken: token,
                paymentRequestId: pr._id,
            });
            console.log('[pay-request] paid, hash:', res.hash);
            fetchPaymentRequests();
        } catch (e: any) {
            alert(e?.message || 'Payment failed');
            console.error('Failed to pay request', e);
        } finally {
            setActionLoading(null);
        }
    };

    // ── Render ───────────────────────────────────────────────────

    return (
        <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100">
            <div className="max-w-4xl mx-auto px-6 py-8">
                {/* Header */}
                <div className="flex items-center gap-4 mb-8">
                    <button
                        onClick={() => router.push('/dashboard')}
                        className="p-2 rounded-lg hover:bg-slate-200 transition"
                    >
                        <svg className="w-5 h-5 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                        </svg>
                    </button>
                    <div>
                        <h1 className="text-2xl font-bold text-slate-900">Payment Requests</h1>
                        <p className="text-sm text-slate-500">Request and manage payments from other Handle users</p>
                    </div>
                </div>

                {/* Tabs */}
                <div className="flex border-b border-slate-200 mb-6">
                    <button
                        onClick={() => setTab('requests')}
                        className={`px-6 py-3 text-sm font-medium border-b-2 transition ${tab === 'requests'
                            ? 'border-emerald-500 text-emerald-600'
                            : 'border-transparent text-slate-500 hover:text-slate-700'
                        }`}
                    >
                        My Requests
                    </button>
                    <button
                        onClick={() => setTab('create')}
                        className={`px-6 py-3 text-sm font-medium border-b-2 transition ${tab === 'create'
                            ? 'border-emerald-500 text-emerald-600'
                            : 'border-transparent text-slate-500 hover:text-slate-700'
                        }`}
                    >
                        + New Request
                    </button>
                </div>

                {/* ═══ TAB: My Requests ═══ */}
                {tab === 'requests' && (
                    <div>
                        {/* Status filter */}
                        <div className="flex gap-2 mb-4">
                            {['', 'pending', 'approved', 'declined'].map((s) => {
                                const badge = counts
                                    ? s === '' ? counts.all : (counts as any)[s]
                                    : null;
                                return (
                                <button
                                    key={s}
                                    onClick={() => setStatusFilter(s)}
                                    className={`px-3 py-1.5 text-xs rounded-full font-medium transition ${statusFilter === s
                                        ? 'bg-emerald-100 text-emerald-700'
                                        : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                                    }`}
                                >
                                    {(s || 'All')}{badge != null ? ` ${badge}` : ''}
                                </button>
                                );
                            })}
                        </div>

                        {prLoading ? (
                            <div className="py-12 text-center text-slate-500">Loading...</div>
                        ) : requests.length === 0 ? (
                            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-12 text-center">
                                <p className="text-slate-500">No payment requests yet</p>
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {requests.map((pr) => (
                                    <div
                                        key={pr._id}
                                        className="bg-white rounded-xl shadow-sm border border-slate-200 p-4"
                                    >
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-3">
                                                <div className={`w-10 h-10 rounded-full flex items-center justify-center text-lg ${
                                                    pr.role === 'sender' ? 'bg-orange-100' : 'bg-emerald-100'
                                                }`}>
                                                    {pr.role === 'sender' ? '📤' : '📥'}
                                                </div>
                                                <div>
                                                    <p className="font-semibold text-slate-900">
                                                        {pr.role === 'sender'
                                                            ? `@${pr.receiverUsername} requests ${pr.amount} ${pr.tokenSymbol}`
                                                            : `You requested ${pr.amount} ${pr.tokenSymbol} from @${pr.senderUsername}`
                                                        }
                                                    </p>
                                                    <div className="flex items-center gap-2 mt-1 text-xs text-slate-500">
                                                        <span className={`px-2 py-0.5 rounded-full font-medium ${
                                                            pr.status === 'pending' ? 'bg-amber-100 text-amber-700'
                                                                : pr.status === 'approved' ? 'bg-emerald-100 text-emerald-700'
                                                                    : 'bg-red-100 text-red-700'
                                                        }`}>
                                                            {pr.status}
                                                        </span>
                                                        {pr.note && <span className="italic">{pr.note}</span>}
                                                        <span>{new Date(pr.createdAt).toLocaleDateString()}</span>
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="flex items-center gap-2">
                                                <span className="text-lg font-bold text-slate-900">
                                                    {pr.amount} {pr.tokenSymbol}
                                                </span>
                                                {pr.status === 'pending' && pr.role === 'sender' && (
                                                    <div className="flex gap-2 ml-4">
                                                        <button
                                                            onClick={() => handleApprove(pr)}
                                                            disabled={actionLoading === pr._id}
                                                            className="px-3 py-1.5 bg-emerald-500 text-white text-xs rounded-lg font-medium hover:bg-emerald-600 disabled:opacity-50 transition"
                                                        >
                                                            {actionLoading === pr._id ? 'Paying…' : 'Pay'}
                                                        </button>
                                                        <button
                                                            onClick={() => handleDecline(pr._id)}
                                                            disabled={actionLoading === pr._id}
                                                            className="px-3 py-1.5 bg-red-500 text-white text-xs rounded-lg font-medium hover:bg-red-600 disabled:opacity-50 transition"
                                                        >
                                                            Decline
                                                        </button>
                                                    </div>
                                                )}
                                                {pr.txHash && (
                                                    <a
                                                        href="#"
                                                        className="text-xs text-blue-500 underline ml-2"
                                                    >
                                                        View tx
                                                    </a>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* ═══ TAB: Create Payment Request ═══ */}
                {tab === 'create' && (
                    <div className="space-y-6">
                        {/* User Search */}
                        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
                            <h3 className="font-semibold text-slate-900 mb-3">Who should pay?</h3>

                            {selectedUser ? (
                                <div className="flex items-center justify-between bg-emerald-50 rounded-lg p-3">
                                    <div className="flex items-center gap-3">
                                        <AvatarCircle username={selectedUser.username} avatarUrl={selectedUser.avatarUrl} />
                                        <div>
                                            <p className="font-semibold text-slate-900">@{selectedUser.username}</p>
                                            <p className="text-xs text-slate-500">
                                                Money: {selectedUser.wallets.money?.evm?.slice(0, 8)}...
                                            </p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => setSelectedUser(null)}
                                        className="text-slate-400 hover:text-slate-600"
                                    >
                                        ✕
                                    </button>
                                </div>
                            ) : (
                                <>
                                    <input
                                        type="text"
                                        placeholder="Search by username..."
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                        className="w-full px-4 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                                    />

                                    {/* Search Results */}
                                    {searching && <p className="text-xs text-slate-400 mt-2">Searching...</p>}
                                    {searchResults.length > 0 && (
                                        <div className="mt-2 border border-slate-200 rounded-lg overflow-hidden">
                                            {searchResults.map((u) => (
                                                <button
                                                    key={u.username}
                                                    onClick={() => selectUser(u.username)}
                                                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 text-left transition border-b border-slate-100 last:border-b-0"
                                                >
                                                    <AvatarCircle username={u.username} avatarUrl={u.avatarUrl} size="w-8 h-8" />
                                                    <div>
                                                        <p className="font-medium text-slate-900 text-sm">@{u.username}</p>
                                                        <p className="text-xs text-slate-400">
                                                            {u.wallets.money?.evm
                                                                ? `${u.wallets.money.evm.slice(0, 8)}...${u.wallets.money.evm.slice(-4)}`
                                                                : 'No money wallet'
                                                            }
                                                        </p>
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    )}

                                    {/* Recent Contacts */}
                                    {!searchQuery && recentContacts.length > 0 && (
                                        <div className="mt-4">
                                            <p className="text-xs font-medium text-slate-500 mb-2 uppercase tracking-wide">Recent Contacts</p>
                                            <div className="flex flex-wrap gap-2">
                                                {recentContacts.map((c) => (
                                                    <button
                                                        key={c.userId}
                                                        onClick={() => selectUser(c.username)}
                                                        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-50 hover:bg-slate-100 text-sm transition"
                                                    >
                                                        <span className="font-medium text-slate-700">@{c.username}</span>
                                                        <span className="text-xs text-slate-400">{c.totalTransactions} txs</span>
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>

                        {/* Amount & Details */}
                        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
                            <h3 className="font-semibold text-slate-900 mb-3">Payment Details</h3>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-xs text-slate-500 mb-1 block">Amount</label>
                                    <input
                                        type="text"
                                        placeholder="0.00"
                                        value={createAmount}
                                        onChange={(e) => setCreateAmount(e.target.value)}
                                        className="w-full px-4 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs text-slate-500 mb-1 block">Token</label>
                                    <select
                                        value={createTokenSymbol}
                                        onChange={(e) => {
                                            setCreateTokenSymbol(e.target.value);
                                            // Update address based on selection
                                            if (e.target.value === 'USDC') {
                                                setCreateTokenAddress('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359');
                                                setCreateTokenDecimals(6);
                                            }
                                        }}
                                        className="w-full px-4 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400"
                                    >
                                        <option value="USDC">USDC</option>
                                    </select>
                                </div>
                            </div>
                            <div className="mt-3">
                                <label className="text-xs text-slate-500 mb-1 block">Note (optional)</label>
                                <input
                                    type="text"
                                    placeholder="What's this for?"
                                    value={createNote}
                                    onChange={(e) => setCreateNote(e.target.value)}
                                    className="w-full px-4 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                                />
                            </div>

                            {createError && <p className="mt-3 text-sm text-red-500">{createError}</p>}
                            {createSuccess && <p className="mt-3 text-sm text-emerald-600">{createSuccess}</p>}

                            <button
                                onClick={handleCreate}
                                disabled={creating || !selectedUser || !createAmount}
                                className="mt-4 w-full py-3 bg-emerald-500 text-white rounded-lg font-semibold text-sm hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed transition"
                            >
                                {creating ? 'Sending...' : 'Send Payment Request'}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
