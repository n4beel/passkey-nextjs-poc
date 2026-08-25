'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { signedFetch } from '@/lib/api/signedFetch';
import { RecoveryProviders } from '../../recovery-poc/providers';

// Google SSO (Privy) is nested here so the guardian EOA is available during
// registration and baked into the smart account (social recovery) at signup.
export default function PasskeyRegistrationPage() {
    return (
        <RecoveryProviders>
            <PasskeyRegistrationInner />
        </RecoveryProviders>
    );
}

function PasskeyRegistrationInner() {
    const router = useRouter();
    const { ready: privyReady, authenticated, login: privyLogin, logout: privyLogout, user: privyUser } = usePrivy();
    const { wallets: privyWallets } = useWallets();
    // The Google-backed embedded EOA = the recovery guardian.
    const guardianWallet = privyWallets.find((w) => w.walletClientType === 'privy');
    const guardianAddress = guardianWallet?.address;
    const guardianEmail = privyUser?.google?.email ?? privyUser?.email?.address ?? privyUser?.id;
    const [step, setStep] = useState<'input' | 'registering' | 'creating_wallets' | 'success'>('input');
    const [reservationToken, setReservationToken] = useState('');
    const [referralCode, setReferralCode] = useState('');
    const [username, setUsername] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [accessToken, setAccessToken] = useState('');
    const [userId, setUserId] = useState('');
    const [spotEvmWallet, setSpotEvmWallet] = useState('');
    const [spotSvmWallet, setSpotSvmWallet] = useState('');
    const [moneyEvmWallet, setMoneyEvmWallet] = useState('');

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
            const optionsRes = await signedFetch('/auth/passkey/register/options', {
                method: 'POST',
                headers: { 'ngrok-skip-browser-warning': 'true' },
                json: { reservationToken },
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
            const verifyRes = await signedFetch('/auth/passkey/register/verify', {
                method: 'POST',
                headers: { 'ngrok-skip-browser-warning': 'true' },
                json: {
                    reservationToken,
                    ...(referralCode.trim() ? { referralCode: referralCode.trim() } : {}),
                    // Present → backend derives recovery-enabled wallets (2.1.0) with
                    // this Google guardian baked in. Absent → legacy no-recovery wallets.
                    ...(guardianAddress ? { guardianAddress } : {}),
                    credential: attResp,
                    deviceInfo: {
                        userAgent: navigator.userAgent,
                        platform: 'web',
                        deviceName: 'Browser',
                    },
                },
            });

            if (!verifyRes.ok) {
                const errorData = await verifyRes.json();
                throw new Error(errorData.message || 'Failed to verify passkey');
            }

            const result = await verifyRes.json();
            setAccessToken(result.accessToken);
            setUsername(result.user.username);
            setUserId(result.user.id);

            // Step 4: Display Backend-Created Wallets
            if (result.wallets) {
                if (result.wallets.spot?.evm) setSpotEvmWallet(result.wallets.spot.evm.address);
                if (result.wallets.spot?.svm) setSpotSvmWallet(result.wallets.spot.svm.address);
                if (result.wallets.money?.evm) setMoneyEvmWallet(result.wallets.money.evm.address);
                console.log('Wallets received from backend:', result.wallets);
            }

            setStep('success');
            localStorage.setItem('accessToken', result.accessToken);
            localStorage.setItem('username', result.user.username);
            if (result.wallets) {
                localStorage.setItem('wallets', JSON.stringify(result.wallets));
            }
            if (result.credentialId) {
                localStorage.setItem('credentialId', result.credentialId);
            }
            setTimeout(() => {
                router.push('/dashboard');
            }, 1500);

        } catch (err: any) {
            console.error('Registration error:', err);
            setError(err.message || 'An error occurred during registration');
            setStep('input');
        } finally {
            setLoading(false);
        }
    };

    // Login flow
    const handleLogin = async (useUsername: boolean = true) => {
        if (useUsername && !username) {
            setError('Please enter your username');
            return;
        }

        setLoading(true);
        setError('');

        try {
            const payload = useUsername ? { username } : {};

            // Step 1: Get login options
            const optionsRes = await signedFetch('/auth/passkey/login/options', {
                method: 'POST',
                headers: { 'ngrok-skip-browser-warning': 'true' },
                json: payload,
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
            const verifyPayload = useUsername
                ? { username, credential: asseResp }
                : { credential: asseResp };

            const verifyRes = await signedFetch('/auth/passkey/login/verify', {
                method: 'POST',
                headers: { 'ngrok-skip-browser-warning': 'true' },
                json: verifyPayload,
            });

            if (!verifyRes.ok) {
                const errorData = await verifyRes.json();
                throw new Error(errorData.message || 'Failed to verify login');
            }

            const result = await verifyRes.json();
            setAccessToken(result.accessToken);
            setUsername(result.user.username);
            setUserId(result.user.id);

            // Step 4: Display Backend-Retrieved Wallets
            if (result.wallets) {
                if (result.wallets.spot?.evm) setSpotEvmWallet(result.wallets.spot.evm.address);
                if (result.wallets.spot?.svm) setSpotSvmWallet(result.wallets.spot.svm.address);
                if (result.wallets.money?.evm) setMoneyEvmWallet(result.wallets.money.evm.address);
                console.log('Wallets received from backend:', result.wallets);
            }

            setStep('success');
            localStorage.setItem('accessToken', result.accessToken);
            localStorage.setItem('username', result.user.username);
            if (result.wallets) {
                localStorage.setItem('wallets', JSON.stringify(result.wallets));
            }
            if (result.credentialId) {
                localStorage.setItem('credentialId', result.credentialId);
            }
            setTimeout(() => {
                router.push('/dashboard');
            }, 1000);
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

                                {/* Recovery guardian (Google SSO) — sets up social recovery at signup */}
                                <div className="mb-4 p-4 bg-white/5 border border-white/20 rounded-lg">
                                    {!authenticated ? (
                                        <>
                                            <p className="text-sm text-gray-300 mb-3">
                                                Set a <strong className="text-white">recovery guardian</strong> so a lost passkey can be restored. Sign in with Google — this becomes your guardian.
                                            </p>
                                            <button
                                                onClick={privyLogin}
                                                disabled={!privyReady}
                                                className="w-full px-4 py-2.5 bg-white text-gray-800 rounded-lg font-medium hover:bg-gray-100 transition-all disabled:opacity-50"
                                            >
                                                {privyReady ? 'Sign in with Google (set recovery guardian)' : 'Loading…'}
                                            </button>
                                            <p className="text-xs text-gray-400 mt-2">Optional — skip to create a wallet without recovery.</p>
                                        </>
                                    ) : (
                                        <div className="text-sm text-green-200">
                                            ✅ Recovery guardian: <strong>{guardianEmail}</strong>
                                            <br />
                                            <span className="text-xs break-all font-mono text-gray-300">{guardianAddress ?? 'creating embedded wallet…'}</span>
                                            <br />
                                            <button
                                                onClick={() => privyLogout()}
                                                className="mt-2 text-xs underline text-amber-300 hover:text-amber-200"
                                            >
                                                Disconnect Google (create WITHOUT recovery — to test enable-from-settings)
                                            </button>
                                        </div>
                                    )}
                                </div>

                                <input
                                    type="text"
                                    placeholder="Reservation Token"
                                    value={reservationToken}
                                    onChange={(e) => setReservationToken(e.target.value)}
                                    className="w-full px-4 py-3 bg-white/10 border border-white/30 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-500"
                                />
                                <input
                                    type="text"
                                    placeholder="Referral Code (optional) — e.g. ABS235SGN27"
                                    value={referralCode}
                                    onChange={(e) => setReferralCode(e.target.value)}
                                    className="w-full mt-3 px-4 py-3 bg-white/10 border border-white/30 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-500"
                                />
                                {/* Guardian must be loaded before the passkey is created, or the
                                    account is derived WITHOUT recovery (the guardian rides along
                                    on register/verify). Gate the button until it's ready. */}
                                {authenticated && !guardianAddress && (
                                    <div className="mt-3 flex items-center gap-2 text-sm text-amber-300">
                                        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-amber-300 border-t-transparent" />
                                        Preparing recovery guardian… (creating embedded wallet)
                                    </div>
                                )}
                                <button
                                    onClick={handleRegister}
                                    disabled={loading || !reservationToken || (authenticated && !guardianAddress)}
                                    className="w-full mt-4 px-6 py-3 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {loading
                                        ? 'Creating Passkey...'
                                        : authenticated && !guardianAddress
                                            ? 'Waiting for guardian…'
                                            : authenticated
                                                ? '🔐 Create Passkey (with recovery)'
                                                : '🔐 Create Passkey (NO recovery)'}
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
                                    onClick={() => handleLogin(true)}
                                    disabled={loading || !username}
                                    className="w-full mt-4 px-6 py-3 bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 text-white rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {loading ? 'Logging in...' : '👤 Login with Username'}
                                </button>

                                <div className="mt-4 flex items-center justify-center">
                                    <div className="border-t border-white/20 w-full"></div>
                                    <span className="px-3 text-gray-400 text-sm">OR</span>
                                    <div className="border-t border-white/20 w-full"></div>
                                </div>

                                <button
                                    onClick={() => handleLogin(false)}
                                    disabled={loading}
                                    className="w-full mt-4 px-6 py-3 bg-white/10 hover:bg-white/20 border border-white/30 text-white rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                                >
                                    🔑 Sign in with Passkey
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
                                <p className="text-white mb-4">
                                    <strong>User ID:</strong> {userId}
                                </p>
                                
                                {/* Spot Wallet */}
                                <div className="mb-4 p-4 bg-white/10 rounded-lg">
                                    <h3 className="text-lg font-semibold text-purple-300 mb-2">💰 Spot Wallet</h3>
                                    <p className="text-gray-300 text-xs mb-2">All your assets: volatile + stablecoins across EVM &amp; SVM chains</p>
                                    {spotEvmWallet && (
                                        <p className="text-white mb-1">
                                            <strong className="text-blue-300">EVM:</strong> <span className="text-xs break-all font-mono">{spotEvmWallet}</span>
                                        </p>
                                    )}
                                    {spotSvmWallet && spotSvmWallet !== 'SVM_PLACEHOLDER' && (
                                        <p className="text-white">
                                            <strong className="text-green-300">SVM:</strong> <span className="text-xs break-all font-mono">{spotSvmWallet}</span>
                                        </p>
                                    )}
                                </div>

                                {/* Money Wallet */}
                                {moneyEvmWallet && (
                                    <div className="mb-4 p-4 bg-white/10 rounded-lg">
                                        <h3 className="text-lg font-semibold text-emerald-300 mb-2">🏦 Money Wallet</h3>
                                        <p className="text-gray-300 text-xs mb-2">Spendable stables — USDT0 on Plasma</p>
                                        <p className="text-white">
                                            <strong className="text-blue-300">EVM:</strong> <span className="text-xs break-all font-mono">{moneyEvmWallet}</span>
                                        </p>
                                    </div>
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
                                    setSpotEvmWallet('');
                                    setSpotSvmWallet('');
                                    setMoneyEvmWallet('');
                                    setError('');
                                    localStorage.removeItem('accessToken');
                                    localStorage.removeItem('username');
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
