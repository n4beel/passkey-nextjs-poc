'use client';

import { useCallback, useState } from 'react';
import { RhinestoneSDK } from '@rhinestone/sdk';
import { toWebAuthnAccount } from 'viem/account-abstraction';
import type { Hex } from 'viem';
import { signedFetch } from '@/lib/api/signedFetch';

function getRhinestoneEndpoint(): string {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return `${origin}/api/orchestrator`;
}

interface ExtendNoPending {
    status: 'no_pending_chains';
    address: string;
}

interface ExtendPendingSignature {
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
    chainIds: number[];
    expiresIn: number;
}

type ExtendPrepareResponse = ExtendNoPending | ExtendPendingSignature;

interface ExtendCompleteResponse {
    message: string;
    address: string;
    approvedChainIds: number[];
}

/**
 * Mirrors `useDepositRegistration`, but for the incremental case: a user who
 * is already registered and just needs to authorize newly-added chains. One
 * passkey prompt covers every pending chain.
 *
 * Flow:
 *   1. POST /deposit/session-extend/prepare  (backend computes the delta)
 *   2. Client signs sessionDetails with signEnableSession
 *   3. POST /deposit/session-extend/complete (backend forwards to Rhinestone
 *      and appends chain IDs to approvedSessionChainIds)
 */
export function useExtendSession() {
    const [isExtending, setIsExtending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const extendSession = useCallback(async (): Promise<ExtendCompleteResponse | null> => {
        setIsExtending(true);
        setError(null);
        try {
            const prepareRes = await signedFetch('/deposit/session-extend/prepare', {
                method: 'POST',
                auth: true,
                headers: { 'ngrok-skip-browser-warning': 'true' },
            });
            if (!prepareRes.ok) {
                const txt = await prepareRes.text();
                throw new Error(`Extend prepare failed: ${prepareRes.status} ${txt}`);
            }
            const prepare = (await prepareRes.json()) as ExtendPrepareResponse;
            console.log('[extend-session] Prepare:', prepare);

            if (prepare.status === 'no_pending_chains') {
                // Nothing to do — caller can refresh status to reflect this.
                return null;
            }

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

            const rhinestoneAccount = await rhinestone.createAccount({
                account: {
                    type: 'nexus',
                    salt: prepare.moneyWalletSalt as Hex,
                },
                owners: {
                    type: 'passkey',
                    accounts: [passkeyAccount],
                },
                sessions: { enabled: true },
            });

            const derived = rhinestoneAccount.getAddress();
            if (derived.toLowerCase() !== prepare.address.toLowerCase()) {
                throw new Error(
                    `Address mismatch on extend: expected ${prepare.address}, got ${derived}`,
                );
            }

            const sessionDetailsForSign = {
                nonces: prepare.sessionDetails.nonces.map((n) => BigInt(n)),
                hashesAndChainIds: prepare.sessionDetails.hashesAndChainIds.map((h) => ({
                    chainId: BigInt(h.chainId),
                    sessionDigest: h.sessionDigest as Hex,
                })),
                data: prepare.sessionDetails.data,
            };

            const signature = await rhinestoneAccount.signEnableSession(
                sessionDetailsForSign as Parameters<
                    typeof rhinestoneAccount.signEnableSession
                >[0],
            );

            console.log('[extend-session] Session signed for chains:', prepare.chainIds);

            const completeRes = await signedFetch('/deposit/session-extend/complete', {
                method: 'POST',
                auth: true,
                headers: { 'ngrok-skip-browser-warning': 'true' },
                json: {
                    prepareId: prepare.prepareId,
                    signature,
                },
            });
            if (!completeRes.ok) {
                const txt = await completeRes.text();
                throw new Error(`Extend complete failed: ${completeRes.status} ${txt}`);
            }

            const result = (await completeRes.json()) as ExtendCompleteResponse;
            console.log('[extend-session] Done:', result);
            return result;
        } catch (err: any) {
            const message = err?.message || 'Session extension failed';
            console.error('[extend-session] Error:', message);
            setError(message);
            throw err;
        } finally {
            setIsExtending(false);
        }
    }, []);

    return { extendSession, isExtending, error };
}
