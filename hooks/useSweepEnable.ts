'use client';

import { useState, useCallback } from 'react';
import { RhinestoneSDK } from '@rhinestone/sdk';
import { toWebAuthnAccount } from 'viem/account-abstraction';
import type { Hex } from 'viem';
import { signedFetch } from '@/lib/api/signedFetch';

/** Get the Rhinestone SDK endpoint URL — uses our API proxy */
function getRhinestoneEndpoint(): string {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return `${origin}/api/orchestrator`;
}

interface SweepEnablePrepareResponse {
    address: string;
    rpId: string;
    moneyWalletSalt: string;
    chainIds: number[];
    sessionDetails: {
        nonces: string[];
        hashesAndChainIds: { chainId: string; sessionDigest: string }[];
        data: Record<string, unknown>;
    };
}

interface SweepEnableCompleteResponse {
    enabled: boolean;
    chainIds: number[];
}

/**
 * Enable the recipient-locked auto-sweep session on the user's Money wallet.
 *
 * One-time, per user. After this, the backend can move stray (non-bridgeable)
 * deposits Money → Spot on the user's behalf — no passkey needed at sweep time.
 *
 * Flow (mirrors deposit registration):
 * 1. POST /deposit/sweep/enable/prepare — backend builds the sweep sessions and
 *    returns the digests the passkey must sign (one per active EVM chain).
 * 2. Client signs the session grant with the passkey (biometric prompt).
 * 3. POST /deposit/sweep/enable/complete — backend stores the enable signature.
 */
export function useSweepEnable() {
    const [isEnabling, setIsEnabling] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const enableSweep = useCallback(async (): Promise<SweepEnableCompleteResponse> => {
        setIsEnabling(true);
        setError(null);

        try {
            // 1. Prepare — backend resolves chains + session digests
            const prepareRes = await signedFetch('/deposit/sweep/enable/prepare', {
                method: 'POST',
                auth: true,
                headers: { 'ngrok-skip-browser-warning': 'true' },
            });

            if (!prepareRes.ok) {
                const errData = await prepareRes.text();
                throw new Error(`Sweep prepare failed: ${prepareRes.status} ${errData}`);
            }

            const prepare: SweepEnablePrepareResponse = await prepareRes.json();
            console.log('[sweep-enable] Prepare response:', prepare);

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

            // Same derivation as the Money wallet: salt + sessions enabled.
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

            const derivedAddress = rhinestoneAccount.getAddress();
            if (derivedAddress.toLowerCase() !== prepare.address.toLowerCase()) {
                throw new Error(
                    `Address mismatch: expected ${prepare.address}, got ${derivedAddress}`,
                );
            }

            // 3. Sign the sweep session grant with the passkey (biometric prompt)
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

            console.log('[sweep-enable] Session signed successfully');

            // 4. Complete — store the enable signature server-side
            const completeRes = await signedFetch('/deposit/sweep/enable/complete', {
                method: 'POST',
                auth: true,
                headers: { 'ngrok-skip-browser-warning': 'true' },
                json: {
                    signature,
                    chainIds: prepare.chainIds,
                    sessionDetails: prepare.sessionDetails,
                },
            });

            if (!completeRes.ok) {
                const errData = await completeRes.text();
                throw new Error(`Sweep enable failed: ${completeRes.status} ${errData}`);
            }

            const result: SweepEnableCompleteResponse = await completeRes.json();
            console.log('[sweep-enable] Enable complete:', result);
            return result;
        } catch (err: any) {
            const message = err?.message || 'Sweep enable failed';
            console.error('[sweep-enable] Error:', message);
            setError(message);
            throw err;
        } finally {
            setIsEnabling(false);
        }
    }, []);

    return {
        enableSweep,
        isEnabling,
        error,
    };
}
