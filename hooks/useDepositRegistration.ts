'use client';

import { useState, useCallback } from 'react';
import { RhinestoneSDK } from '@rhinestone/sdk';
import { toWebAuthnAccount } from 'viem/account-abstraction';
import type { Hex } from 'viem';
import { API_V2_BASE, signedFetch } from '@/lib/api/signedFetch';
import { recoverableMoneyAccount, recoveredMoneyAccount } from '@/lib/recovery/recovery';

/** Get the Rhinestone SDK endpoint URL — uses our API proxy */
function getRhinestoneEndpoint(): string {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return `${origin}/api/orchestrator`;
}

interface PrepareAlreadyRegistered {
    status: 'already_registered';
    address: string;
    evmDepositAddress?: string;
    solanaDepositAddress?: string;
}

interface PreparePendingSignature {
    status: 'pending_signature';
    prepareId: string;
    address: string;
    rpId: string;
    moneyWalletSalt: string;
    sessionDetails: {
        nonces: string[];
        hashesAndChainIds: { chainId: string; sessionDigest: string }[];
        data: Record<string, unknown>;
    };
    expiresIn: number;
    // Present for a RECOVERED wallet: the stored factory args to sign the re-enable.
    recovered?: boolean;
    factory?: string;
    factoryData?: string;
}

type PrepareResponse = PrepareAlreadyRegistered | PreparePendingSignature;

interface CompleteResponse {
    message: string;
    address: string;
    evmDepositAddress?: string;
    solanaDepositAddress?: string;
}

/**
 * Hook for registering a Money Wallet with Rhinestone's deposit service (v2 API).
 *
 * Flow:
 * 1. POST /api/v2/deposit/register/prepare — backend resolves config and session digests
 * 2. Client signs session grant with passkey (biometric prompt)
 * 3. POST /api/v2/deposit/register/complete — backend registers with Rhinestone
 */
export function useDepositRegistration() {
    const [isRegistering, setIsRegistering] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const registerForDeposits = useCallback(async (
        accessToken: string,
    ): Promise<CompleteResponse> => {
        setIsRegistering(true);
        setError(null);

        try {
            // 1. Prepare — backend resolves chains, tokens, session digests
            const prepareRes = await signedFetch('/deposit/register/prepare', {
                method: 'POST',
                apiBase: API_V2_BASE,
                auth: true,
                headers: { 'ngrok-skip-browser-warning': 'true' },
            });

            if (!prepareRes.ok) {
                const errData = await prepareRes.text();
                throw new Error(`Prepare failed: ${prepareRes.status} ${errData}`);
            }

            const prepare: PrepareResponse = await prepareRes.json();
            console.log('[deposit-reg] Prepare response:', prepare);

            if (prepare.status === 'already_registered') {
                return {
                    message: 'Already registered',
                    address: prepare.address,
                    evmDepositAddress: prepare.evmDepositAddress,
                    solanaDepositAddress: prepare.solanaDepositAddress,
                };
            }

            // 2. Fetch credential for passkey signing
            const configRes = await signedFetch('/wallet/config', {
                auth: true,
                headers: { 'ngrok-skip-browser-warning': 'true' },
            });
            if (!configRes.ok) throw new Error('Failed to fetch wallet config');
            const config = await configRes.json();

            const xHex = config.pubX.replace('0x', '').padStart(64, '0');
            const yHex = config.pubY.replace('0x', '').padStart(64, '0');
            const uncompressedPubKey = ('0x04' + xHex + yHex) as Hex;

            const passkeyAccount = toWebAuthnAccount({
                credential: {
                    id: config.credentialId,
                    publicKey: uncompressedPubKey,
                },
                rpId: prepare.rpId,
            });

            // 3. Sign session grant with passkey (biometric prompt)
            const sessionDetailsForSign = {
                nonces: prepare.sessionDetails.nonces.map((n) => BigInt(n)),
                hashesAndChainIds: prepare.sessionDetails.hashesAndChainIds.map((h) => ({
                    chainId: BigInt(h.chainId),
                    sessionDigest: h.sessionDigest as Hex,
                })),
                data: prepare.sessionDetails.data,
            };

            let derivedAddress: string;
            let signature: string;

            if (config.moneyRecovered && config.moneyAddress) {
                // RECOVERED wallet: the login passkey rotated, so the address can't
                // be re-derived — pin to the stored address and re-sign the deposit
                // session with the current (recovered) passkey. This re-establishes
                // the deposit-service session that the recovery invalidated.
                const recoveredAccount = await recoveredMoneyAccount({
                    ownerPasskey: passkeyAccount,
                    address: config.moneyAddress,
                    factory: prepare.factory,
                    factoryData: prepare.factoryData,
                });
                derivedAddress = recoveredAccount.getAddress();
                if (derivedAddress.toLowerCase() !== prepare.address.toLowerCase()) {
                    throw new Error(
                        `Address mismatch after prepare: expected ${prepare.address}, got ${derivedAddress}`,
                    );
                }
                signature = await recoveredAccount.signEnableSession(
                    sessionDetailsForSign as Parameters<
                        typeof recoveredAccount.signEnableSession
                    >[0],
                );
            } else if (config.moneyGuardian) {
                // Recovery-enabled money wallet: the backend derived it on SDK 2.1.0
                // with the guardian baked into the address, so rebuild the SAME way
                // (beta.39 without the guardian gives a different address) and sign
                // the enable with the 2.1.0 method (`experimental_` prefix dropped).
                const recoverableAccount = await recoverableMoneyAccount({
                    ownerPasskey: passkeyAccount,
                    guardianAddress: config.moneyGuardian,
                    salt: prepare.moneyWalletSalt as Hex,
                });
                derivedAddress = recoverableAccount.getAddress();
                if (derivedAddress.toLowerCase() !== prepare.address.toLowerCase()) {
                    throw new Error(
                        `Address mismatch after prepare: expected ${prepare.address}, got ${derivedAddress}`,
                    );
                }
                signature = await recoverableAccount.signEnableSession(
                    sessionDetailsForSign as Parameters<
                        typeof recoverableAccount.signEnableSession
                    >[0],
                );
            } else {
                const rhinestone = new RhinestoneSDK({
                    apiKey: 'proxy',
                    endpointUrl: getRhinestoneEndpoint(),
                });

                const rhinestoneAccount = await rhinestone.createAccount({
                    account: {
                        type: 'nexus',
                        salt: prepare.moneyWalletSalt as Hex,
                    },
                    owners: {
                        type: 'passkey',
                        accounts: [passkeyAccount],
                    },
                    sessions: {
                        enabled: true,
                    },
                });

                derivedAddress = rhinestoneAccount.getAddress();
                if (derivedAddress.toLowerCase() !== prepare.address.toLowerCase()) {
                    throw new Error(
                        `Address mismatch after prepare: expected ${prepare.address}, got ${derivedAddress}`,
                    );
                }

                signature =
                    await rhinestoneAccount.signEnableSession(
                        sessionDetailsForSign as Parameters<
                            typeof rhinestoneAccount.signEnableSession
                        >[0],
                    );
            }

            console.log('[deposit-reg] Session signed successfully');

            // 4. Complete registration
            const completeRes = await signedFetch('/deposit/register/complete', {
                method: 'POST',
                apiBase: API_V2_BASE,
                auth: true,
                headers: { 'ngrok-skip-browser-warning': 'true' },
                json: {
                    prepareId: prepare.prepareId,
                    signature,
                },
            });

            if (!completeRes.ok) {
                const errData = await completeRes.text();
                throw new Error(`Registration failed: ${completeRes.status} ${errData}`);
            }

            const result: CompleteResponse = await completeRes.json();
            console.log('[deposit-reg] Registration complete:', result);
            return result;
        } catch (err: any) {
            const message = err?.message || 'Deposit registration failed';
            console.error('[deposit-reg] Error:', message);
            setError(message);
            throw err;
        } finally {
            setIsRegistering(false);
        }
    }, []);

    return {
        registerForDeposits,
        isRegistering,
        error,
    };
}
