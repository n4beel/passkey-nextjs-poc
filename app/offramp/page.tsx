'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { signedFetch } from '@/lib/api/signedFetch';
import OfframpModal from '../dashboard/components/OfframpModal';

/**
 * Standalone off-ramp page — a shareable link that shows just the off-ramp modal
 * (Money wallet → bank) and its live status. `/offramp` opens the full flow;
 * `/offramp?payment=<id>` deep-links straight to a payment's live status screen
 * (which polls the backend, which reflects the real Walapay status).
 */
export default function OfframpStandalonePage() {
    const router = useRouter();
    const [token, setToken] = useState<any>(null);
    const [accessToken, setAccessToken] = useState('');
    const [initialPaymentId, setInitialPaymentId] = useState<string | undefined>(undefined);
    const [err, setErr] = useState('');

    useEffect(() => {
        const at = typeof window !== 'undefined' ? localStorage.getItem('accessToken') || '' : '';
        setAccessToken(at);
        const pid = typeof window !== 'undefined'
            ? new URLSearchParams(window.location.search).get('payment') || undefined
            : undefined;
        setInitialPaymentId(pid);
        (async () => {
            try {
                const res = await signedFetch('/wallet/config', { auth: true });
                if (!res.ok) { setErr('Please log in first.'); return; }
                const cfg = await res.json();
                // Money-mode: source USDC on Base from the Money wallet address; the
                // backend recognizes the Money (BSC) address and funds cross-chain.
                setToken({
                    symbol: 'USDC',
                    name: 'Money Wallet',
                    balance: '1000',
                    address: cfg.moneyAddress || '',
                    chainId: 8453,
                    type: 'evm',
                });
            } catch {
                setErr('Please log in first.');
            }
        })();
    }, []);

    if (err) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center gap-3 text-slate-500">
                <p>{err}</p>
                <a href="/" className="px-4 py-2 bg-emerald-600 text-white rounded-lg font-medium">Go to login</a>
            </div>
        );
    }
    if (!token) {
        return <div className="min-h-screen flex items-center justify-center text-slate-400">Loading off-ramp…</div>;
    }

    return (
        <div className="min-h-screen bg-slate-100">
            <OfframpModal
                isOpen={true}
                onClose={() => router.push('/dashboard')}
                token={token}
                accessToken={accessToken}
                initialPaymentId={initialPaymentId}
            />
        </div>
    );
}
