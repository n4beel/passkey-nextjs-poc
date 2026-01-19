'use client';

import { useState } from 'react';
import Link from 'next/link';
import { createEVMWallet } from '@/lib/evm-wallet';

import { startRegistration } from '@simplewebauthn/browser';

// We won't use the hook anymore for SVM
// import { useWallet } from '@lazorkit/wallet';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3001/api/v1';

export default function WalletTestPage() {
    // EVM State
    const [evmLoading, setEvmLoading] = useState(false);
    const [evmWallet, setEvmWallet] = useState<any>(null);
    const [evmX, setEvmX] = useState('');
    const [evmY, setEvmY] = useState('');
    const [evmCredId, setEvmCredId] = useState('');

    // SVM State
    const [svmLoading, setSvmLoading] = useState(false);
    const [svmWallet, setSvmWallet] = useState<any>(null);
    const [svmUsername, setSvmUsername] = useState('svm_user_' + Math.floor(Math.random() * 1000));
    const [loginUsername, setLoginUsername] = useState('');
    const [svmStep, setSvmStep] = useState('');

    const [error, setError] = useState('');

    const handleCreateEVMWallet = async () => {
        setEvmLoading(true);
        setError('');
        try {
            if (!evmX || !evmY || !evmCredId) {
                throw new Error('Please enter X, Y coordinates and Credential ID');
            }
            const wallet = await createEVMWallet({
                x: evmX,
                y: evmY,
                credentialId: evmCredId
            });
            setEvmWallet(wallet);
        } catch (err: any) {
            console.error('EVM Wallet creation error:', err);
            setError(err.message || 'Failed to create EVM wallet');
        } finally {
            setEvmLoading(false);
        }
    };

    const handleLoginAndCreateSVM = async () => {
        if (!loginUsername) {
            setError('Please enter a username to login');
            return;
        }
        setSvmLoading(true);
        setError('');
        setSvmStep('Getting login options...');

        try {
            // 1. Get Login Options
            const optsRes = await fetch(`${API_BASE}/auth/passkey/login/options`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: loginUsername })
            });

            if (!optsRes.ok) {
                const err = await optsRes.json();
                throw new Error(err.message || 'Failed to get login options');
            }
            const options = await optsRes.json();

            // 2. Authenticate (Browser Popup)
            setSvmStep('Authenticating...');
            const { startAuthentication } = await import('@simplewebauthn/browser');
            const authResp = await startAuthentication(options);

            // 3. Verify Login & Get Wallet Data
            setSvmStep('Verifying...');
            const verifyRes = await fetch(`${API_BASE}/auth/passkey/login/verify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: loginUsername,
                    credential: authResp
                })
            });

            if (!verifyRes.ok) throw new Error('Failed to verify login');
            const verifyData = await verifyRes.json();

            // 4. Use Wallet from Backend
            if (verifyData.wallet && verifyData.wallet.svm) {
                setSvmWallet({
                    address: verifyData.wallet.svm.address,
                    // Backend might return more details if needed, but address is key
                    walletId: "Derived on Backend",
                    credentialId: "From Auth"
                });
                setSvmStep('Success!');
            } else {
                throw new Error("Backend did not return wallet data. Ensure backend is running the latest version.");
            }

        } catch (err: any) {
            console.error('Login error:', err);
            setError(err.message || 'Login failed');
            setSvmStep('Failed');
        } finally {
            setSvmLoading(false);
        }
    };

    const handleCreateSVMWallet = async () => {
        setSvmLoading(true);
        setError('');
        setSvmStep('Initializing...');
        try {
            // 0. Fetch Usecase ID (Required for reservation)
            setSvmStep('Fetching usecases...');
            const usecasesRes = await fetch(`${API_BASE}/onboarding/usecases`);
            if (!usecasesRes.ok) throw new Error('Failed to fetch usecases');
            const usecases = await usecasesRes.json();
            if (!usecases || usecases.length === 0) throw new Error('No usecases found');
            const usecaseId = usecases[0].id;

            // 1. Reserve Username (Simulated for test)
            setSvmStep('Reserving username...');
            const reserveRes = await fetch(`${API_BASE}/onboarding/reserve-username`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: svmUsername,
                    usecaseId: usecaseId
                })
            });
            if (!reserveRes.ok) {
                const errData = await reserveRes.json();
                throw new Error(errData.message || 'Failed to reserve username');
            }
            const { reservationToken } = await reserveRes.json();

            // 2. Get Registration Options
            setSvmStep('Getting options...');
            const optsRes = await fetch(`${API_BASE}/auth/passkey/register/options`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reservationToken })
            });
            if (!optsRes.ok) throw new Error('Failed to get options');
            const options = await optsRes.json();

            // 3. Create Passkey (Browser Native Popup)
            setSvmStep('Creating Passkey (Check popup)...');
            const attResp = await startRegistration(options);

            // 4. Verify & Get Wallet
            setSvmStep('Verifying...');
            const verifyRes = await fetch(`${API_BASE}/auth/passkey/register/verify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    reservationToken,
                    credential: attResp,
                    deviceInfo: { platform: 'web', userAgent: navigator.userAgent }
                })
            });
            if (!verifyRes.ok) throw new Error('Failed to verify passkey');
            const verifyData = await verifyRes.json();

            // 5. Use Wallet from Backend
            if (verifyData.wallet && verifyData.wallet.svm) {
                setSvmWallet({
                    address: verifyData.wallet.svm.address,
                    walletId: "Derived on Backend",
                    credentialId: "From Auth"
                });
                setSvmStep('Success!');
            } else {
                throw new Error('Backend did not return wallet data. Please update backend.');
            }

        } catch (err: any) {
            console.error('SVM Wallet creation error:', err);
            setError(err.message || 'Failed to create SVM wallet');
            setSvmStep('Failed');
        } finally {
            setSvmLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-pink-900 p-8">
            <div className="max-w-4xl mx-auto">
                <Link href="/" className="text-white/70 hover:text-white mb-8 inline-block">
                    ← Back to Home
                </Link>

                <h1 className="text-4xl font-bold text-white mb-2">Phase 3: Wallet Test (Dev Mode)</h1>
                <p className="text-gray-300 mb-8">Test EVM and SVM wallet creation</p>

                {error && (
                    <div className="bg-red-500/20 border border-red-500/50 text-red-200 p-4 rounded-lg mb-8">
                        🚨 {error}
                    </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    {/* EVM Section */}
                    <div className="bg-white/10 backdrop-blur-lg border border-white/20 rounded-2xl p-6">
                        <h2 className="text-2xl font-bold text-white mb-4">EVM Wallet (ZeroDev)</h2>
                        <div className="space-y-4">
                            <input
                                type="text"
                                placeholder="Public Key X Coordinate (hex)"
                                className="w-full bg-white/5 border border-white/10 rounded p-3 text-white"
                                value={evmX}
                                onChange={e => setEvmX(e.target.value)}
                            />
                            <input
                                type="text"
                                placeholder="Public Key Y Coordinate (hex)"
                                className="w-full bg-white/5 border border-white/10 rounded p-3 text-white"
                                value={evmY}
                                onChange={e => setEvmY(e.target.value)}
                            />
                            <input
                                type="text"
                                placeholder="Credential ID"
                                className="w-full bg-white/5 border border-white/10 rounded p-3 text-white"
                                value={evmCredId}
                                onChange={e => setEvmCredId(e.target.value)}
                            />
                            <button
                                onClick={handleCreateEVMWallet}
                                className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-lg transition-colors"
                            >
                                {evmLoading ? 'Creating...' : 'Create EVM Wallet'}
                            </button>

                            {/* EVM Results */}
                            {evmWallet && (
                                <div className="mt-4 p-4 bg-green-900/30 border border-green-500/30 rounded-lg">
                                    <p className="text-sm text-gray-300">Address:</p>
                                    <p className="font-mono text-green-400 break-all">{evmWallet.address}</p>
                                    <p className="text-sm text-gray-300 mt-2">Chain ID:</p>
                                    <p className="font-mono text-green-400">{evmWallet.chainId}</p>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* SVM Section */}
                    <div className="bg-white/10 backdrop-blur-lg border border-white/20 rounded-2xl p-6">
                        <h2 className="text-2xl font-bold text-white mb-4">SVM Wallet (Lazorkit Local)</h2>
                        <p className="text-gray-300 mb-4">Creates a Solana wallet using your Passkey.</p>

                        {/* Tab-like structure for Register vs Login */}
                        <div className="space-y-6">

                            {/* Option A: New Account */}
                            <div className="border border-white/10 p-4 rounded-lg bg-black/20">
                                <h3 className="text-sm font-bold text-purple-300 mb-3 uppercase tracking-wider">Option A: New Test Account</h3>
                                <input
                                    type="text"
                                    placeholder="Test Username"
                                    className="w-full bg-white/5 border border-white/10 rounded p-3 text-white mb-3"
                                    value={svmUsername}
                                    onChange={e => setSvmUsername(e.target.value)}
                                />
                                <button
                                    onClick={handleCreateSVMWallet}
                                    disabled={svmLoading}
                                    className="w-full bg-purple-600 hover:bg-purple-500 text-white font-semibold py-3 rounded-lg transition-colors disabled:opacity-50"
                                >
                                    {svmLoading && !loginUsername ? (svmStep || 'Processing...') : '☀️ Create via New Registration'}
                                </button>
                            </div>

                            <div className="text-center text-gray-500">- OR -</div>

                            {/* Option B: Login */}
                            <div className="border border-white/10 p-4 rounded-lg bg-black/20">
                                <h3 className="text-sm font-bold text-blue-300 mb-3 uppercase tracking-wider">Option B: Existing User</h3>
                                <input
                                    type="text"
                                    placeholder="Existing Username (Phase 2)"
                                    className="w-full bg-white/5 border border-white/10 rounded p-3 text-white mb-3"
                                    value={loginUsername}
                                    onChange={e => setLoginUsername(e.target.value)}
                                />
                                <button
                                    onClick={handleLoginAndCreateSVM}
                                    disabled={svmLoading && !!loginUsername}
                                    className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-lg transition-colors disabled:opacity-50"
                                >
                                    {svmLoading && !!loginUsername ? (svmStep || 'Processing...') : '🔐 Login & Derive Wallet'}
                                </button>
                            </div>


                            {svmWallet && (
                                <div className="mt-4 p-4 bg-purple-900/30 border border-purple-500/30 rounded-lg">
                                    <p className="text-sm text-gray-300">Solana Devnet Address:</p>
                                    <p className="font-mono text-purple-400 break-all text-lg font-bold">{svmWallet.address}</p>

                                    <div className="mt-2 text-xs text-gray-400">
                                        <p>Wallet ID: {svmWallet.walletId}</p>
                                        <p className="truncate">Cred ID: {svmWallet.credentialId}</p>
                                    </div>

                                    <a
                                        href={`https://explorer.solana.com/address/${svmWallet.address}?cluster=devnet`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-block mt-3 text-sm text-purple-300 hover:text-white underline"
                                    >
                                        View on Explorer ↗
                                    </a>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                <div className="mt-8 bg-white/5 rounded-xl p-6">
                    <h3 className="text-lg font-bold text-yellow-500 mb-2">💡 How to Get Values:</h3>
                    <ul className="text-sm text-gray-300 space-y-1">
                        <li>• <strong>EVM:</strong> Use values from Phase 2 login / manual input.</li>
                        <li>• <strong>SVM (New):</strong> Registers a new passkey.</li>
                        <li>• <strong>SVM (Existing):</strong> Uses your existing passkey from Phase 2. Ensure backend supports returning raw keys on login.</li>
                    </ul>
                </div>
            </div>
        </div>
    );
}
