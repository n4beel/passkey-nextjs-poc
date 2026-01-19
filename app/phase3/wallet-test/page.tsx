'use client';

import { useState } from 'react';
import Link from 'next/link';
import { createEVMWallet } from '@/lib/evm-wallet';

export default function WalletTestPage() {
    const [pubX, setPubX] = useState('0xb74e616b4215ce99a12cf1d60c2fcbd84ded4db8a87355c371079c030fb98a1b');
    const [pubY, setPubY] = useState('0xd1cc5b9a20d7014cfd3a4e14bbba7315fe5ca67b200089f7233bf6918d7f8b82');
    const [credentialId, setCredentialId] = useState('q1tju_bWwyIR8hksILnFcQ');
    const [evmAddress, setEvmAddress] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const handleCreateWallet = async () => {
        setLoading(true);
        setError('');
        setEvmAddress('');

        try {
            console.log('Creating EVM wallet with:', { pubX, pubY, credentialId });

            const result = await createEVMWallet({
                x: pubX,
                y: pubY,
                credentialId: credentialId,
            });

            setEvmAddress(result.address);
            console.log('Wallet created successfully:', result);
        } catch (err: any) {
            console.error('Wallet creation error:', err);
            setError(err.message || 'Failed to create wallet');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 p-8">
            <div className="max-w-4xl mx-auto">
                <Link href="/" className="text-purple-300 hover:text-purple-200 mb-6 inline-block">
                    ← Back to Home
                </Link>

                <div className="bg-white/10 backdrop-blur-lg border border-white/20 rounded-2xl p-8 shadow-2xl">
                    <h1 className="text-4xl font-bold text-white mb-2">Phase 3: Wallet Test (Dev Mode)</h1>
                    <p className="text-gray-300 mb-8">Test EVM wallet creation with manual public key input</p>

                    <div className="space-y-6">
                        <div>
                            <label className="block text-white font-semibold mb-2">
                                Public Key X Coordinate (hex):
                            </label>
                            <input
                                type="text"
                                value={pubX}
                                onChange={(e) => setPubX(e.target.value)}
                                className="w-full px-4 py-3 bg-white/10 border border-white/30 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono text-sm"
                                placeholder="0x..."
                            />
                        </div>

                        <div>
                            <label className="block text-white font-semibold mb-2">
                                Public Key Y Coordinate (hex):
                            </label>
                            <input
                                type="text"
                                value={pubY}
                                onChange={(e) => setPubY(e.target.value)}
                                className="w-full px-4 py-3 bg-white/10 border border-white/30 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono text-sm"
                                placeholder="0x..."
                            />
                        </div>

                        <div>
                            <label className="block text-white font-semibold mb-2">
                                Credential ID:
                            </label>
                            <input
                                type="text"
                                value={credentialId}
                                onChange={(e) => setCredentialId(e.target.value)}
                                className="w-full px-4 py-3 bg-white/10 border border-white/30 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono text-sm"
                                placeholder="base64url string"
                            />
                        </div>

                        <button
                            onClick={handleCreateWallet}
                            disabled={loading || !pubX || !pubY || !credentialId}
                            className="w-full px-6 py-4 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white rounded-lg font-semibold text-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {loading ? 'Creating Wallet...' : '🔐 Create EVM Wallet'}
                        </button>

                        {error && (
                            <div className="bg-red-500/20 border border-red-500/50 text-red-200 px-4 py-3 rounded-lg">
                                ❌ {error}
                            </div>
                        )}

                        {evmAddress && (
                            <div className="bg-green-500/20 border border-green-500/50 rounded-lg p-6">
                                <h3 className="text-white font-semibold text-lg mb-2">✅ Wallet Created!</h3>
                                <p className="text-white mb-2">
                                    <strong>EVM Address:</strong>
                                </p>
                                <p className="text-green-300 font-mono text-sm break-all bg-black/20 p-3 rounded">
                                    {evmAddress}
                                </p>
                                <a
                                    href={`https://sepolia.etherscan.io/address/${evmAddress}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-block mt-4 text-blue-300 hover:text-blue-200 underline"
                                >
                                    View on Sepolia Etherscan →
                                </a>
                            </div>
                        )}
                    </div>

                    <div className="mt-8 bg-blue-500/10 border border-blue-500/30 rounded-xl p-6">
                        <h3 className="text-lg font-semibold text-blue-300 mb-3">💡 How to Get Values:</h3>
                        <ul className="text-sm text-blue-200 space-y-2">
                            <li>• <strong>For Testing:</strong> Use the pre-filled values (from "lalala" user)</li>
                            <li>• <strong>From Login API:</strong> Login via <code className="bg-black/30 px-2 py-1 rounded">/auth/passkey/login/verify</code> and copy <code className="bg-black/30 px-2 py-1 rounded">publicKey.x</code>, <code className="bg-black/30 px-2 py-1 rounded">publicKey.y</code>, <code className="bg-black/30 px-2 py-1 rounded">publicKey.credentialId</code></li>
                            <li>• <strong>From Database:</strong> Decode credential <code className="bg-black/30 px-2 py-1 rounded">publicKey</code> field using cbor</li>
                            <li>• The values must be hex strings starting with <code className="bg-black/30 px-2 py-1 rounded">0x</code></li>
                        </ul>
                    </div>

                    <div className="mt-6 bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-6">
                        <h3 className="text-lg font-semibold text-yellow-300 mb-3">⚙️ What This Tests:</h3>
                        <ul className="text-sm text-yellow-200 space-y-2">
                            <li>✅ ZeroDev SDK integration</li>
                            <li>✅ WebAuthnKey construction</li>
                            <li>✅ Passkey validator creation</li>
                            <li>✅ Kernel account address generation</li>
                            <li>✅ Chain configuration from backend</li>
                        </ul>
                    </div>
                </div>
            </div>
        </div>
    );
}
