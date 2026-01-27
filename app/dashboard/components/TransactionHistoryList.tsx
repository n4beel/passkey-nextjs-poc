import { useState, useEffect } from 'react';

interface HistoryItem {
    chain: string;
    type: 'send' | 'receive' | 'unknown';
    token: {
        symbol: string;
        name?: string;
        decimals: number;
        address: string;
    };
    amount: string;
    hash: string; // Transaction Hash / Signature
    from: string;
    to: string;
    timestamp: string; // Date string
    status: 'confirmed' | 'pending' | 'failed';
}

interface ChainPortfolio {
    chainId: number; // or network string for svm?
    type: 'evm' | 'svm';
    address: string;
    network?: string;
    assets: any[];
}

interface TransactionHistoryListProps {
    chains: ChainPortfolio[];
    accessToken: string;
}

export default function TransactionHistoryList({ chains, accessToken }: TransactionHistoryListProps) {
    const [history, setHistory] = useState<HistoryItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!accessToken || chains.length === 0) return;
        fetchAllHistory();
    }, [chains, accessToken]);

    const fetchAllHistory = async () => {
        setLoading(true);
        try {
            const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';
            const allPromises = chains.map(async (chain) => {
                // Determine 'network' param
                // For SVM: 'devnet' or nothing (mainnet)
                // For EVM: chainId
                const networkParam = chain.type === 'evm' ? chain.chainId.toString() : (chain.network || 'mainnet');

                const query = `chainType=${chain.type}&network=${networkParam}&address=${chain.address}`;

                const res = await fetch(`${apiUrl}/transactions/history?${query}`, {
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                });

                if (!res.ok) return []; // Ignore failed chains individually
                return await res.json();
            });

            const results = await Promise.all(allPromises);
            const flatHistory: HistoryItem[] = results.flat();

            // Sort by timestamp desc
            const sorted = flatHistory.sort((a, b) =>
                new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
            );

            setHistory(sorted);
        } catch (err: any) {
            console.error("Failed to fetch history:", err);
            setError("Could not load full history.");
        } finally {
            setLoading(false);
        }
    };

    if (loading) return <div className="py-8 text-center text-slate-500">Loading history...</div>;
    // if (error) return <div className="py-4 text-center text-red-500 text-sm">{error}</div>;

    if (history.length === 0) {
        return (
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-8 text-center">
                <p className="text-slate-500">No transaction history found.</p>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <h2 className="text-xl font-bold text-slate-900">Transaction History</h2>
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                        <thead className="bg-slate-50 text-slate-500 font-medium border-b border-slate-200">
                            <tr>
                                <th className="px-6 py-3">Type</th>
                                <th className="px-6 py-3">Asset</th>
                                <th className="px-6 py-3 text-right">Amount</th>
                                <th className="px-6 py-3">From/To</th>
                                <th className="px-6 py-3 text-right">Date</th>
                                <th className="px-6 py-3 text-center">Stats</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {history.map((tx, idx) => (
                                <tr key={`${tx.hash}-${idx}`} className="hover:bg-slate-50 transition">
                                    <td className="px-6 py-4">
                                        <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-bold uppercase ${tx.type === 'receive' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
                                            }`}>
                                            {tx.type}
                                        </span>
                                        <div className="text-xs text-slate-400 mt-1 uppercase">{tx.chain}</div>
                                    </td>
                                    <td className="px-6 py-4 font-medium text-slate-900">
                                        {tx.token.symbol}
                                    </td>
                                    <td className={`px-6 py-4 text-right font-bold ${tx.type === 'receive' ? 'text-emerald-600' : 'text-slate-900'
                                        }`}>
                                        {tx.type === 'receive' ? '+' : '-'}{parseFloat(tx.amount).toFixed(4)}
                                    </td>
                                    <td className="px-6 py-4">
                                        <div className="flex flex-col text-xs font-mono text-slate-500">
                                            <span title={tx.from}>{tx.from.slice(0, 6)}...{tx.from.slice(-4)}</span>
                                            <span className="text-slate-300">↓</span>
                                            <span title={tx.to}>{tx.to.slice(0, 6)}...{tx.to.slice(-4)}</span>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4 text-right text-slate-500">
                                        {new Date(tx.timestamp).toLocaleString()}
                                    </td>
                                    <td className="px-6 py-4 text-center">
                                        <a
                                            href={getExplorerLink(tx.chain, tx.hash)}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="text-blue-500 hover:text-blue-700 text-xs underline"
                                        >
                                            View
                                        </a>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}

function getExplorerLink(chain: string, hash: string) {
    // Basic mapping, explicit mapping would be better if passed from backend
    if (chain.includes('sol') || chain === 'devnet') {
        return `https://explorer.solana.com/tx/${hash}?cluster=devnet`; // Assuming Devnet for POC
    }
    // EVM: Assume Sepolia or Polygon Amoy for POC? Or try to guess?
    // Moralis usually returns chainId hex (e.g. 0x13882 for Amoy).
    // Let's create a Helper or just link to generic blockscan if possible?

    // Better: Backend should return 'explorerUrl' property on HistoryItem? 
    // For now, return '#' or simple guess.
    return '#';
}
