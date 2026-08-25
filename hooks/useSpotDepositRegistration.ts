'use client';

import { useState, useCallback } from 'react';
import { RhinestoneSDK } from '@rhinestone/sdk';
import { toWebAuthnAccount } from 'viem/account-abstraction';
import type { Hex } from 'viem';
import { API_V2_BASE, signedFetch } from '@/lib/api/signedFetch';

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
    /** Spot is the default nexus (no salt) — null, unlike money's moneyWalletSalt. */
    walletSalt: null;
    sessionDetails: {
        nonces: string[];
        hashesAndChainIds: { chainId: string; sessionDigest: string }[];
        data: Record<string, unknown>;
    };
    settlementChainId: number;
    acceptedAssets: string[];
    expiresIn: number;
}

type PrepareResponse = PrepareAlreadyRegistered | PreparePendingSignature;

interface CompleteResponse {
    message: string;
    address: string;
    evmDepositAddress?: string;
    solanaDepositAddress?: string;
}

/**
 * Register the SPOT wallet with Rhinestone's deposit service (v2 API).
 *
 * Same shape as {@link useDepositRegistration} (Money), but the spot wallet is
 * the DEFAULT nexus — created with NO salt — and settles each accepted asset as
 * its own token on Base (outputTokenRules) rather than USDT0 on Plasma.
 *
 * Flow:
 * 1. POST /api/v2/spot-deposit/register/prepare — backend resolves the Base
 *    target + per-asset rules + SUDO source-chain session digests
 * 2. Client signs the session grant with the passkey (biometric prompt)
 * 3. POST /api/v2/spot-deposit/register/complete — backend registers with Rhinestone
 */
export function useSpotDepositRegistration() {
    const [isRegistering, setIsRegistering] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const registerForSpotDeposits = useCallback(async (
        _accessToken: string,
    ): Promise<CompleteResponse> => {
        setIsRegistering(true);
        setError(null);

        try {
            // 1. Prepare — backend resolves Base target, outputTokenRules, session digests
            const prepareRes = await signedFetch('/spot-deposit/register/prepare', {
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
            console.log('[spot-deposit-reg] Prepare response:', prepare);

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

            const rhinestone = new RhinestoneSDK({
                apiKey: 'proxy',
                endpointUrl: getRhinestoneEndpoint(),
            });

            // Spot = default nexus: NO `account.salt` (that's the whole difference
            // from Money). Must match the backend's createAccountWithSessions(no salt).
            const rhinestoneAccount = await rhinestone.createAccount({
                owners: {
                    type: 'passkey',
                    accounts: [passkeyAccount],
                },
                sessions: {
                    enabled: true,
                },
            });

            const derivedAddress = rhinestoneAccount.getAddress();
            if (derivedAddress.toLowerCase() !== prepare.address.toLowerCase()) {
                throw new Error(
                    `Address mismatch after prepare: expected ${prepare.address}, got ${derivedAddress}. ` +
                    'The spot wallet may predate sessions-enabled derivation (run the migration).',
                );
            }

            // 3. Sign the session grant with the passkey (biometric prompt)
            const sessionDetailsForSign = {
                nonces: prepare.sessionDetails.nonces.map((n) => BigInt(n)),
                hashesAndChainIds: prepare.sessionDetails.hashesAndChainIds.map((h) => ({
                    chainId: BigInt(h.chainId),
                    sessionDigest: h.sessionDigest as Hex,
                })),
                data: prepare.sessionDetails.data,
            };

            const signature =
                await rhinestoneAccount.signEnableSession(
                    sessionDetailsForSign as Parameters<
                        typeof rhinestoneAccount.signEnableSession
                    >[0],
                );

            console.log('[spot-deposit-reg] Session signed successfully');

            // 4. Complete registration
            const completeRes = await signedFetch('/spot-deposit/register/complete', {
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
            console.log('[spot-deposit-reg] Registration complete:', result);
            return result;
        } catch (err: any) {
            const message = err?.message || 'Spot deposit registration failed';
            console.error('[spot-deposit-reg] Error:', message);
            setError(message);
            throw err;
        } finally {
            setIsRegistering(false);
        }
    }, []);

    return {
        registerForSpotDeposits,
        isRegistering,
        error,
    };
}
