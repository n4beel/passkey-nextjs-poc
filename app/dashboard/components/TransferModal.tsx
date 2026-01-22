import { useState, useEffect } from 'react';
import { createPublicClient, http, parseAbi, encodeFunctionData, parseUnits, formatUnits, keccak256, toHex } from 'viem';
import { sepolia } from 'viem/chains';
import { createKernelAccount, createKernelAccountClient, createZeroDevPaymasterClient } from "@zerodev/sdk";
import { toPasskeyValidator, PasskeyValidatorContractVersion } from "@zerodev/passkey-validator";
import { toWebAuthnKey, WebAuthnMode } from "@zerodev/webauthn-key";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";

interface TransferModalProps {
    isOpen: boolean;
    onClose: () => void;
    token: {
        symbol: string;
        name: string;
        balance: string;
        decimals: number;
        address: string;
        chainId?: number;
    } | null;
    accessToken: string;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';

export default function TransferModal({ isOpen, onClose, token, accessToken }: TransferModalProps) {
    const [recipient, setRecipient] = useState('');
    const [amount, setAmount] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [successHash, setSuccessHash] = useState('');
    const [status, setStatus] = useState('');

    useEffect(() => {
        if (!isOpen) {
            setRecipient('');
            setAmount('');
            setError('');
            setSuccessHash('');
            setStatus('');
        }
    }, [isOpen]);

    if (!isOpen || !token) return null;

    const handleTransfer = async () => {
        if (!recipient || !amount) {
            setError('Please fill in all fields');
            return;
        }

        setLoading(true);
        setError('');
        setStatus('Initializing Wallet...');

        // Get access token for backend auth
        const accessToken = localStorage.getItem('accessToken');
        if (!accessToken) {
            throw new Error('Not authenticated');
        }

        try {
            // 1. Fetch Wallet Config from Backend
            const configRes = await fetch(`${API_BASE}/wallet/config`, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'ngrok-skip-browser-warning': 'true'
                }
            });

            if (!configRes.ok) {
                throw new Error('Failed to fetch wallet config');
            }

            const config = await configRes.json();
            console.log('Wallet Config:', config);

            // 2. Initialize Public Client
            const publicClient = createPublicClient({
                transport: http(config.zerodev.bundlerUrl), // Use Bundler URL for RPC
                chain: sepolia // TODO: Make dynamic based on config.chainId
            });

            // 3. Initialize Passkey Validator using our custom passkey server
            setStatus('Initializing Wallet...');
            const entryPoint = getEntryPoint("0.7");

            // Manually construct WebAuthnKey to avoid the first "login" prompt
            // We already have the public key in config, so we can skip fetching it

            // Helper to convert base64url to bytes
            const b64ToBytes = (base64: string): Uint8Array => {
                const binString = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
                return Uint8Array.from(binString, (m) => m.codePointAt(0)!);
            }

            const credentialIdBytes = b64ToBytes(config.credentialId);
            const authenticatorIdHash = keccak256(credentialIdBytes);

            const webAuthnKey = {
                pubX: BigInt(config.pubX), // Backend sends 0x-prefixed hex string
                pubY: BigInt(config.pubY), // Backend sends 0x-prefixed hex string
                authenticatorId: config.credentialId,
                authenticatorIdHash: authenticatorIdHash,
                rpID: window.location.hostname
            };

            console.log("🚀 ~ handleTransfer ~ constructed webAuthnKey:", webAuthnKey)
            debugger


            const passkeyValidator = await toPasskeyValidator(publicClient, {
                webAuthnKey,
                entryPoint,
                kernelVersion: KERNEL_V3_1,
                validatorContractVersion: PasskeyValidatorContractVersion.V0_0_3_PATCHED
            });

            // 4. Create Paymaster Client
            const paymasterClient = createZeroDevPaymasterClient({
                chain: sepolia,
                transport: http(config.zerodev.paymasterUrl)
            });

            // 5. Create Account
            const account = await createKernelAccount(publicClient, {
                plugins: { sudo: passkeyValidator },
                entryPoint,
                kernelVersion: KERNEL_V3_1
            });

            // 6. Create Kernel Client with Paymaster
            const kernelClient = createKernelAccountClient({
                account,
                chain: sepolia,
                bundlerTransport: http(config.zerodev.bundlerUrl),
                paymaster: paymasterClient
            });

            setStatus('Constructing Transaction...');

            // 5. Construct Call Data
            let callData;
            let targetAddress = recipient as `0x${string}`;
            let value = BigInt(0);
            let to = targetAddress;

            if (token.address === 'native') {
                // Native ETH Transfer
                value = parseUnits(amount, token.decimals || 18);
            } else {
                // ERC20 Transfer
                to = token.address as `0x${string}`;
                const abi = parseAbi(['function transfer(address to, uint256 amount)']);
                // Debug log
                console.log('Encoding transfer:', { to: targetAddress, amount, decimals: token.decimals });
                callData = encodeFunctionData({
                    abi,
                    functionName: 'transfer',
                    args: [targetAddress, parseUnits(amount, token.decimals || 18)]
                });
            }

            setStatus('Please sign with Passkey...');

            // 6. Send Transaction (handles UserOp, Signing, Paymaster, and Waiting)
            const txHash = await kernelClient.sendTransaction({
                calls: [{
                    to,
                    value,
                    data: callData || '0x'
                }]
            });

            setStatus('Transaction Submitted! Waiting for receipt...');
            console.log('Tx Hash:', txHash);

            // sendTransaction returns the transaction hash once the UserOp is included
            setSuccessHash(txHash);
            setStatus('Success!');

        } catch (err: any) {
            console.error('Transfer Error:', err);
            setError(err.message || 'Transfer failed');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-slate-900 border border-white/10 rounded-2xl w-full max-w-md p-6 shadow-2xl">
                <div className="flex justify-between items-center mb-6">
                    <h3 className="text-xl font-bold text-white">Transfer {token.symbol}</h3>
                    <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
                </div>

                {!successHash ? (
                    <div className="space-y-4">
                        <div className="bg-white/5 rounded-lg p-3">
                            <p className="text-sm text-gray-400">Available Balance</p>
                            <p className="text-xl font-mono text-white">{token.balance} {token.symbol}</p>
                        </div>

                        <div>
                            <label className="block text-sm text-gray-400 mb-1">Recipient Address</label>
                            <input
                                type="text"
                                value={recipient}
                                onChange={(e) => setRecipient(e.target.value)}
                                placeholder="0x..."
                                className="w-full bg-black/20 border border-white/10 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-purple-500 font-mono text-sm"
                            />
                        </div>

                        <div>
                            <label className="block text-sm text-gray-400 mb-1">Amount</label>
                            <input
                                type="number"
                                value={amount}
                                onChange={(e) => setAmount(e.target.value)}
                                placeholder="0.00"
                                className="w-full bg-black/20 border border-white/10 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-purple-500 font-mono"
                            />
                        </div>

                        {error && (
                            <div className="bg-red-500/10 text-red-200 text-sm p-3 rounded-lg border border-red-500/20">
                                {error}
                            </div>
                        )}

                        {status && (
                            <div className="bg-blue-500/10 text-blue-200 text-sm p-3 rounded-lg border border-blue-500/20 animate-pulse">
                                {status}
                            </div>
                        )}

                        <button
                            onClick={handleTransfer}
                            disabled={loading}
                            className="w-full bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white font-semibold py-3 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed mt-2"
                        >
                            {loading ? 'Processing...' : 'Send Now'}
                        </button>
                    </div>
                ) : (
                    <div className="text-center py-6">
                        <div className="w-16 h-16 bg-green-500/20 text-green-400 rounded-full flex items-center justify-center mx-auto mb-4 text-3xl">
                            ✓
                        </div>
                        <h4 className="text-xl font-bold text-white mb-2">Transfer Successful!</h4>
                        <p className="text-gray-400 text-sm mb-6 max-w-xs mx-auto break-all">
                            Tx Hash: <br />
                            <a
                                href={`https://sepolia.etherscan.io/tx/${successHash}`}
                                target="_blank"
                                rel="noreferrer"
                                className="text-purple-400 hover:text-purple-300 hover:underline"
                            >
                                {successHash}
                            </a>
                        </p>
                        <button
                            onClick={onClose}
                            className="w-full bg-white/10 hover:bg-white/20 text-white font-semibold py-3 rounded-lg transition-all"
                        >
                            Close
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

function base64ToBytes(base64: string): Uint8Array {
    debugger
    const binString = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binString, (m) => m.codePointAt(0)!);
}
