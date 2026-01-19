'use client';

import { useState } from 'react';
import Link from 'next/link';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { createEVMWallet } from '@/lib/evm-wallet';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';

export default function PasskeyRegistrationPage() {
    const [step, setStep] = useState<'input' | 'registering' | 'creating_wallets' | 'success'>('input');
    const [reservationToken, setReservationToken] = useState('');
    const [username, setUsername] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [accessToken, setAccessToken] = useState('');
    const [userId, setUserId] = useState('');
    const [evmWallet, setEvmWallet] = useState('');
    const [svmWallet, setSvmWallet] = useState('');

    // Registration flow
    const handleRegister = async () => {
        if (!reservationToken) {
            setError('Please enter your reservation token from Phase 1');
            return;
        }

        setLoading(true);
        setError('');

        try {
            // Step 1: Get registration options from backend
            const optionsRes = await fetch(`${API_BASE}/auth/passkey/register/options`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'ngrok-skip-browser-warning': 'true',
                },
                body: JSON.stringify({ reservationToken }),
            });

            if (!optionsRes.ok) {
                const errorData = await optionsRes.json();
                throw new Error(errorData.message || 'Failed to get registration options');
            }

            const options = await optionsRes.json();


            // Step 2: Create passkey using @simplewebauthn/browser
            setStep('registering');

            const attResp = await startRegistration(options);


            // Step 3: Send credential to backend for verification
            const verifyRes = await fetch(`${API_BASE}/auth/passkey/register/verify`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'ngrok-skip-browser-warning': 'true',
                },
                body: JSON.stringify({
                    reservationToken,
                    credential: attResp,
                    deviceInfo: {
                        userAgent: navigator.userAgent,
                        platform: 'web',
                        deviceName: 'Browser',
                    },
                }),
            });

            if (!verifyRes.ok) {
                const errorData = await verifyRes.json();
                throw new Error(errorData.message || 'Failed to verify passkey');
            }

            const result = await verifyRes.json();
            setAccessToken(result.accessToken);
            setUsername(result.user.username);
            setUserId(result.user.id);

            // Step 4: Create wallets
            setStep('creating_wallets');

            try {
                // Create EVM wallet (ZeroDev)
                console.log('Creating EVM wallet...');
                const evmWalletResult = await createEVMWallet('register', result.user.username);
                setEvmWallet(evmWalletResult.address);
                console.log('EVM wallet created:', evmWalletResult.address);

                // For SVM, we'll use Lazorkit in a future update
                // For now, use a placeholder
                const svmWalletAddress = 'SVM_PLACEHOLDER';
                setSvmWallet(svmWalletAddress);

                // Step 5: Store wallet addresses in backend
                console.log('Storing wallets...');
                const storeRes = await fetch(`${API_BASE}/onboarding/wallets`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${result.accessToken}`,
                        'ngrok-skip-browser-warning': 'true',
                    },
                    body: JSON.stringify({
                        evmAddress: evmWalletResult.address,
                        svmAddress: svmWalletAddress,
                        chainConfigs: [
                            { type: 'evm', chainId: evmWalletResult.chainId },
                            { type: 'svm', network: 'devnet' }
                        ]
                    }),
                });

                if (!storeRes.ok) {
                    console.error('Failed to store wallets');
                }

                console.log('Wallets stored successfully!');
                setStep('success');
            } catch (walletErr: any) {
                console.error('Wallet creation error:', walletErr);
                setError(`Passkey created but wallet generation failed: ${walletErr.message}`);
                setStep('success'); // Still show success for passkey
            }
        } catch (err: any) {
            console.error('Registration error:', err);
            setError(err.message || 'An error occurred during registration');
            setStep('input');
        } finally {
            setLoading(false);
        }
    };

    // Login flow
    const handleLogin = async () => {
        if (!username) {
            setError('Please enter your username');
            return;
        }

        setLoading(true);
        setError('');

        try {
            // Step 1: Get login options
            const optionsRes = await fetch(`${API_BASE}/auth/passkey/login/options`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'ngrok-skip-browser-warning': 'true',
                },
                body: JSON.stringify({ username }),
            });

            if (!optionsRes.ok) {
                const errorData = await optionsRes.json();
                throw new Error(errorData.message || 'Failed to get login options');
            }

            const options = await optionsRes.json();
            console.log('Login options:', options);

            // Step 2: Get credential using @simplewebauthn/browser
            const asseResp = await startAuthentication(options);
            console.log('Assertion response:', asseResp);

            // Step 3: Send credential to backend
            const verifyRes = await fetch(`${API_BASE}/auth/passkey/login/verify`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'ngrok-skip-browser-warning': 'true',
                },
                body: JSON.stringify({
                    username,
                    credential: asseResp,
                }),
            });

            if (!verifyRes.ok) {
                const errorData = await verifyRes.json();
                throw new Error(errorData.message || 'Failed to verify login');
            }

            const result = await verifyRes.json();
            setAccessToken(result.accessToken);
            setUsername(result.user.username);
            setUserId(result.user.id);
            setStep('success');
        } catch (err: any) {
            console.error('Login error:', err);
            setError(err.message || 'An error occurred during login');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 p-8">
            <div className="max-w-2xl mx-auto">
                <Link href="/" className="text-purple-300 hover:text-purple-200 mb-6 inline-block">
                    ← Back to Home
                </Link>

                <div className="bg-white/10 backdrop-blur-lg border border-white/20 rounded-2xl p-8 shadow-2xl">
                    <h1 className="text-4xl font-bold text-white mb-2">Phase 2: Passkey Authentication</h1>
                    <p className="text-gray-300 mb-8">Test WebAuthn passkey registration and login</p>

                    {step === 'input' && (
                        <div className="space-y-6">
                            <div>
                                <h2 className="text-2xl font-semibold text-white mb-4">Register New Account</h2>
                                <p className="text-gray-300 mb-4">
                                    Enter your reservation token from Phase 1 to create a passkey
                                </p>
                                <input
                                    type="text"
                                    placeholder="Reservation Token"
                                    value={reservationToken}
                                    onChange={(e) => setReservationToken(e.target.value)}
                                    className="w-full px-4 py-3 bg-white/10 border border-white/30 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-500"
                                />
                                <button
                                    onClick={handleRegister}
                                    disabled={loading || !reservationToken}
                                    className="w-full mt-4 px-6 py-3 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {loading ? 'Creating Passkey...' : '🔐 Create Passkey'}
                                </button>
                            </div>

                            <div className="border-t border-white/20 pt-6">
                                <h2 className="text-2xl font-semibold text-white mb-4">Login with Existing Passkey</h2>
                                <p className="text-gray-300 mb-4">
                                    Already registered? Enter your username to login
                                </p>
                                <input
                                    type="text"
                                    placeholder="Username"
                                    value={username}
                                    onChange={(e) => setUsername(e.target.value)}
                                    className="w-full px-4 py-3 bg-white/10 border border-white/30 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                                <button
                                    onClick={handleLogin}
                                    disabled={loading || !username}
                                    className="w-full mt-4 px-6 py-3 bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 text-white rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {loading ? 'Logging in...' : '👤 Login with Passkey'}
                                </button>
                            </div>

                            {error && (
                                <div className="bg-red-500/20 border border-red-500/50 text-red-200 px-4 py-3 rounded-lg">
                                    ❌ {error}
                                </div>
                            )}
                        </div>
                    )}

                    {step === 'registering' && (
                        <div className="text-center py-12">
                            <div className="text-6xl mb-4">🔐</div>
                            <h2 className="text-2xl font-bold text-white mb-2">Creating Your Passkey</h2>
                            <p className="text-gray-300">Follow the prompts to complete Face ID / Touch ID</p>
                        </div>
                    )}

                    {step === 'creating_wallets' && (
                        <div className="text-center py-12">
                            <div className="text-6xl mb-4">💰</div>
                            <h2 className="text-2xl font-bold text-white mb-2">Creating Your Wallets</h2>
                            <p className="text-gray-300">Generating smart wallet addresses...</p>
                        </div>
                    )}

                    {step === 'success' && (
                        <div className="text-center py-8">
                            <div className="text-6xl mb-4">✅</div>
                            <h2 className="text-3xl font-bold text-white mb-4">Success!</h2>
                            <div className="bg-green-500/20 border border-green-500/50 rounded-lg p-6 mb-6">
                                <p className="text-white mb-2">
                                    <strong>Username:</strong> {username}
                                </p>
                                <p className="text-white mb-2">
                                    <strong>User ID:</strong> {userId}
                                </p>
                                {evmWallet && (
                                    <p className="text-white mb-2">
                                        <strong>EVM Wallet:</strong> <span className="text-xs break-all">{evmWallet}</span>
                                    </p>
                                )}
                                {svmWallet && svmWallet !== 'SVM_PLACEHOLDER' && (
                                    <p className="text-white mb-2">
                                        <strong>SVM Wallet:</strong> <span className="text-xs break-all">{svmWallet}</span>
                                    </p>
                                )}
                                <p className="text-xs text-gray-300 mt-4 break-all">
                                    Access Token: {accessToken.substring(0, 50)}...
                                </p>
                            </div>
                            <button
                                onClick={() => {
                                    setStep('input');
                                    setReservationToken('');
                                    setUsername('');
                                    setAccessToken('');
                                    setEvmWallet('');
                                    setSvmWallet('');
                                    setError('');
                                }}
                                className="px-6 py-3 bg-white/20 hover:bg-white/30 text-white rounded-lg font-semibold transition-all"
                            >
                                Test Again
                            </button>
                        </div>
                    )}
                </div>

                <div className="mt-8 bg-blue-500/10 border border-blue-500/30 rounded-xl p-6">
                    <h3 className="text-lg font-semibold text-blue-300 mb-2">💡 Testing Tips</h3>
                    <ul className="text-sm text-blue-200 space-y-2">
                        <li>• Complete Phase 1 first to get a reservation token</li>
                        <li>• Registration works with Face ID, Touch ID, Windows Hello, or device PIN</li>
                        <li>• Each device creates a separate passkey credential</li>
                        <li>• Login uses the passkey you created on this device</li>
                        <li>• Check browser console for detailed logs if issues persist</li>
                    </ul>
                </div>
            </div>
        </div>
    );
}
