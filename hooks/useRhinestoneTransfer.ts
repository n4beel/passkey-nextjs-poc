'use client';

import { useState, useCallback } from 'react';
import { RhinestoneSDK } from '@rhinestone/sdk';
import { toWebAuthnAccount } from 'viem/account-abstraction';
import {
    encodeFunctionData,
    erc20Abi,
    maxUint256,
    parseUnits,
    type Hex,
    type Chain,
} from 'viem';
import * as viemChains from 'viem/chains';
import { plasma, plasmaTestnet, PLASMA_USDT0_ADDRESS } from '@/lib/chains/plasma';
import { signedFetch } from '@/lib/api/signedFetch';
import { recoverableMoneyAccount, recoveredMoneyAccount, MONEY_WALLET_SALT } from '@/lib/recovery/recovery';

/** Canonical Permit2 — the spender a Rhinestone intent's source claim pulls through. */
const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as `0x${string}`;

/** Check if a chain ID is a Plasma chain */
function isPlasmaChain(chainId: number): boolean {
    return chainId === plasma.id || chainId === plasmaTestnet.id;
}

/**
 * v2: `sendTransaction` is gone. Prepare → sign → submit an intent in one call,
 * mirroring the old one-shot. The caller still runs `waitForExecution` on the
 * returned result, exactly as before. `signTransaction` triggers the passkey
 * prompt (the same UX `sendTransaction` had in v1).
 */
async function sendTx(account: any, tx: any) {
    const prepared = await account.prepareTransaction(tx);
    const signed = await account.signTransaction(prepared);
    return account.submitTransaction(signed);
}

/**
 * Safely convert a tx hash value (BigInt, number, or string) to a 0x-prefixed hex string.
 */
function toHexHash(value: any): string | null {
    if (!value) return null;
    if (typeof value === 'string') {
        return value.startsWith('0x') ? value : `0x${value}`;
    }
    if (typeof value === 'bigint' || typeof value === 'number') {
        return '0x' + BigInt(value).toString(16);
    }
    return value.toString();
}

/**
 * Get the Rhinestone SDK endpoint URL — uses our API proxy
 * to keep the API key server-side.
 */
function getRhinestoneEndpoint(): string {
    const baseUrl =
        typeof window !== 'undefined'
            ? window.location.origin
            : process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    return `${baseUrl}/api/orchestrator`;
}

/**
 * Resolve a viem Chain from a numeric chainId.
 * Includes custom Plasma chain definitions.
 */
function getChainById(chainId: number): Chain {
    // Check custom chains first
    if (chainId === plasma.id) return plasma;
    if (chainId === plasmaTestnet.id) return plasmaTestnet;

    const allChains = Object.values(viemChains) as Chain[];
    const found = allChains.find((c) => c.id === chainId);
    if (!found) {
        throw new Error(`Unsupported chain ID: ${chainId}`);
    }
    return found;
}

interface TransferResult {
    hash: string;
    intentId?: string;
}

/** The swap quote returned by /swap/prepare (summary block). */
interface SwapSummary {
    from: {
        symbol: string; address: string; chainId: number; amount: string;
        // Per-chain breakdown of where the input is sourced from (multi-source).
        sources?: { chainId: number; address: string; amount: string }[];
    };
    to: {
        symbol: string; address: string; chainId: number;
        estimatedOutput: string | null;
        youReceive: string | null;
        guaranteed?: boolean;
    };
    fee: string;
    feeToken: string;
    feeUsd: number | null;
    slippageBps?: number;
    networkFee: string;
    quoteAvailable: boolean;
    quoteReason?: string | null;
}

/**
 * Hook for sending EVM transfers via Rhinestone SDK with passkey signing.
 *
 * Supports:
 * - Same-chain transfers (ERC-20 and native ETH)
 * - Cross-chain transfers via Intents API (bridge + execute on target chain)
 * - Gasless USDT0 transfers on Plasma
 *
 * Flow:
 * 1. Fetch wallet config (credentialId, pubX, pubY) from backend
 * 2. Build WebAuthn account with browser-native signing
 * 3. Create Rhinestone Nexus smart account
 * 4. Send transaction (triggers passkey biometric prompt)
 */
export function useRhinestoneTransfer() {
    const [isSending, setIsSending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    /**
     * Build a Rhinestone account from the user's passkey credentials.
     */
    const buildRhinestoneAccount = useCallback(async (
        accessToken: string,
        walletType: 'spot' | 'money',
    ) => {
        // 1. Fetch wallet config from backend
        const configRes = await signedFetch('/wallet/config', {
            auth: true,
            headers: { 'ngrok-skip-browser-warning': 'true' },
        });
        if (!configRes.ok) throw new Error('Failed to fetch wallet config');
        const config = await configRes.json();

        // 2. Build uncompressed P256 public key: 0x04 || x (32 bytes) || y (32 bytes)
        const xHex = config.pubX.replace('0x', '').padStart(64, '0');
        const yHex = config.pubY.replace('0x', '').padStart(64, '0');
        const uncompressedPubKey = ('0x04' + xHex + yHex) as Hex;

        // 3. Create WebAuthn account (uses browser's navigator.credentials.get for signing)
        const passkeyAccount = toWebAuthnAccount({
            credential: {
                id: config.credentialId,
                publicKey: uncompressedPubKey,
            },
            rpId: window.location.hostname,
        });

        // RECOVERED money wallet: the login passkey rotated, so the address can't be
        // re-derived — pin to the stored address, sign with the current passkey.
        // Takes priority over the guardian path (a recovered wallet still has one).
        if (walletType === 'money' && config.moneyRecovered && config.moneyAddress) {
            return recoveredMoneyAccount({
                ownerPasskey: passkeyAccount,
                address: config.moneyAddress,
            });
        }

        // Recovery-enabled (not yet recovered) MONEY wallet: the backend derived it
        // on SDK 2.1.0 with the guardian baked into the address, so build the SAME
        // way — the plain path below (no guardian) derives a different, unfunded
        // address, so a pay/withdraw intent sources from an empty account.
        if (walletType === 'money' && config.moneyGuardian) {
            return recoverableMoneyAccount({
                ownerPasskey: passkeyAccount,
                guardianAddress: config.moneyGuardian,
                salt: MONEY_WALLET_SALT,
            });
        }

        // 4. Create Rhinestone SDK with proxy endpoint (API key stays server-side)
        const rhinestone = new RhinestoneSDK({
            apiKey: 'proxy',
            endpointUrl: getRhinestoneEndpoint(),
        });

        const accountConfig: any = {
            owners: {
                type: 'passkey',
                accounts: [passkeyAccount],
            },
        };

        // Use salt for money wallet (must match backend derivation)
        if (walletType === 'money') {
            accountConfig.account = {
                type: 'nexus',
                salt: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
            };
        }
        // CRITICAL: BOTH wallets are derived with sessions enabled, and sessions
        // change the CREATE2 address. Money always was; Spot became sessions-
        // enabled after the spot→sessions migration (so it's registrable for
        // auto-deposit). Without this the SDK derives a DIFFERENT, unfunded
        // account (confirmed w/ Rhinestone: the intent was built for the
        // sessions-off address which had 0 funds — the AA21 "didn't pay prefund"
        // and "insufficient balance" errors on spot withdraw/activate).
        accountConfig.sessions = { enabled: true };

        const rhinestoneAccount = await rhinestone.createAccount(accountConfig);
        return rhinestoneAccount;
    }, []);

    /**
     * Send a same-chain EVM transfer (native ETH or ERC-20).
     *
     * For Plasma chains: uses sendUserOperation (direct on-chain UserOp,
     * bypasses the Rhinestone orchestrator/intents system which doesn't support Plasma).
     * For other chains: uses sendTransaction (goes through intents/orchestrator).
     */
    const sendEvmTransfer = useCallback(async (params: {
        accessToken: string;
        chainId: number;
        to: string;           // Recipient address
        tokenAddress: string; // Token contract address or 'native'
        amount: string;       // Human-readable amount (e.g. "1.5")
        decimals: number;
        walletType: 'spot' | 'money';
        directUserOp?: boolean; // same-chain (e.g. claims): bypass the cross-chain intents path
    }): Promise<TransferResult> => {
        setIsSending(true);
        setError(null);

        try {
            const rhinestoneAccount = await buildRhinestoneAccount(
                params.accessToken,
                params.walletType,
            );

            const chain = getChainById(params.chainId);
            const amountWei = parseUnits(params.amount, params.decimals);

            if (params.tokenAddress === 'native') {
                // Native ETH transfer
                const txResult = await sendTx(rhinestoneAccount,{
                    chain,
                    calls: [{
                        to: params.to as `0x${string}`,
                        value: amountWei,
                        data: '0x' as Hex,
                    }],
                    sponsored: true,
                });

                const receipt = await rhinestoneAccount.waitForExecution(txResult);
                return { hash: toHexHash((receipt as any)?.transactionHash) || toHexHash((txResult as any)?.id) || 'submitted' };
            }

            // ERC-20 transfer
            const data = encodeFunctionData({
                abi: erc20Abi,
                functionName: 'transfer',
                args: [params.to as `0x${string}`, amountWei],
            });

            if (isPlasmaChain(params.chainId) || params.directUserOp) {
                // Direct on-chain user-op — bypasses the cross-chain orchestrator/intents.
                // Used for Plasma (USDT0 is gasless) and for same-chain claims on other
                // chains, where routing a same-chain move through the intents path fails
                // (422 INSUFFICIENT_LIQUIDITY — see Rhinestone docs: "same-chain → use
                // sendUserOperation"). On non-gasless chains the account pays gas from its
                // own balance unless a paymaster is configured on the SDK.
                console.log(
                    `[Rhinestone] Direct user-op (${isPlasmaChain(params.chainId) ? 'Plasma' : 'same-chain'})`,
                );
                const userOpResult = await rhinestoneAccount.sendUserOperation({
                    chain,
                    calls: [{
                        to: params.tokenAddress as `0x${string}`,
                        value: BigInt(0),
                        data,
                    }],
                });

                const receipt = await rhinestoneAccount.waitForExecution(userOpResult);
                return { hash: toHexHash((receipt as any)?.transactionHash) || toHexHash(userOpResult.hash) || 'submitted' };
            }

            // Non-Plasma ERC-20: use sendTransaction (orchestrator/intents)
            const txResult = await sendTx(rhinestoneAccount,{
                chain,
                calls: [{
                    to: params.tokenAddress as `0x${string}`,
                    value: BigInt(0),
                    data,
                }],
                sponsored: true,
            });

            const receipt = await rhinestoneAccount.waitForExecution(txResult);
            return { hash: toHexHash((receipt as any)?.transactionHash) || toHexHash((txResult as any)?.id) || 'submitted' };
        } catch (err: any) {
            const message = err.message || 'EVM transfer failed';
            setError(message);
            throw err;
        } finally {
            setIsSending(false);
        }
    }, [buildRhinestoneAccount]);

    /**
     * Send a cross-chain transfer using the Intents API.
     * Bridges tokens from source chain(s) and executes calls on the target chain.
     *
     * Example: Bridge USDC from Base → Plasma as USDT0
     */
    const sendCrossChainTransfer = useCallback(async (params: {
        accessToken: string;
        sourceChainIds: number[];   // Source chains to pull funds from
        targetChainId: number;      // Destination chain
        to: string;                 // Recipient address on target chain
        tokenAddress: string;       // Token to receive on target chain
        amount: string;             // Human-readable amount
        decimals: number;
        walletType: 'spot' | 'money';
    }): Promise<TransferResult> => {
        setIsSending(true);
        setError(null);

        try {
            const rhinestoneAccount = await buildRhinestoneAccount(
                params.accessToken,
                params.walletType,
            );

            const targetChain = getChainById(params.targetChainId);
            const sourceChains = params.sourceChainIds.map(getChainById);
            const amountWei = parseUnits(params.amount, params.decimals);

            // Build the transfer call on the target chain
            const data = encodeFunctionData({
                abi: erc20Abi,
                functionName: 'transfer',
                args: [params.to as `0x${string}`, amountWei],
            });

            const txResult = await sendTx(rhinestoneAccount,{
                sourceChains,
                targetChain,
                calls: [{
                    to: params.tokenAddress as `0x${string}`,
                    value: BigInt(0),
                    data,
                }],
                tokenRequests: [{
                    address: params.tokenAddress as `0x${string}`,
                    amount: amountWei,
                }],
            });

            const receipt = await rhinestoneAccount.waitForExecution(txResult);
            return {
                hash: toHexHash((receipt as any)?.fillTransactionHash) ||
                    toHexHash((receipt as any)?.transactionHash) ||
                    toHexHash((txResult as any)?.id) ||
                    'submitted',
                intentId: (txResult as any)?.id != null ? String((txResult as any).id) : undefined,
            };
        } catch (err: any) {
            const message = err.message || 'Cross-chain transfer failed';
            setError(message);
            throw err;
        } finally {
            setIsSending(false);
        }
    }, [buildRhinestoneAccount]);

    /**
     * Server-prepared Money-wallet payment (handle→handle or pay-by-address).
     *
     * Model A: the backend resolves the recipient + returns the exact `calls`;
     * we submit them as one gasless Plasma user-op (passkey-signed); the backend
     * records the resulting tx by hash. Fee-free (peer pay isn't a fee point).
     */
    const payViaBackend = useCallback(async (params: {
        accessToken: string;
        recipient?: { handle?: string; address?: string };
        amount?: string;
        note?: string;
        paymentRequestId?: string; // pay an existing request (recipient + amount come from it)
    }): Promise<TransferResult> => {
        setIsSending(true);
        setError(null);

        try {
            // 1. Prepare — backend resolves recipient + returns the calls to run.
            const prepareRes = await signedFetch('/payments/prepare', {
                method: 'POST',
                auth: true,
                json: params.paymentRequestId
                    ? { paymentRequestId: params.paymentRequestId }
                    : {
                        handle: params.recipient?.handle,
                        address: params.recipient?.address,
                        amount: params.amount,
                        note: params.note,
                    },
                headers: { 'ngrok-skip-browser-warning': 'true' },
            });
            if (!prepareRes.ok) {
                throw new Error(`Prepare failed: ${prepareRes.status} ${await prepareRes.text()}`);
            }
            const prepare: {
                prepareId: string;
                chainId: number;
                calls: { to: string; value: string; data: string }[];
                tokenRequests: { address: string; amount: string }[];
            } = await prepareRes.json();

            // 2. Submit via the intent flow (sendTransaction) — routes through the
            //    Rhinestone orchestrator, so no Plasma bundler is needed. Passkey
            //    signs. `tokenRequests` tells the orchestrator what to source.
            const rhinestoneAccount = await buildRhinestoneAccount(
                params.accessToken,
                'money',
            );
            const chain = getChainById(prepare.chainId);
            const txResult = await sendTx(rhinestoneAccount,{
                chain,
                calls: prepare.calls.map((c) => ({
                    to: c.to as `0x${string}`,
                    value: BigInt(c.value),
                    data: c.data as Hex,
                })),
                tokenRequests: prepare.tokenRequests.map((t) => ({
                    address: t.address as `0x${string}`,
                    amount: BigInt(t.amount),
                })),
                // Same-chain intent (money→money on BSC): relayer must sponsor it, or
                // it sits waiting for a solver that never comes → EXPIRED (bug #3).
                sponsored: true,
            });
            await rhinestoneAccount.waitForExecution(txResult);

            // 3. Complete — send the intent id; the BACKEND resolves the real
            //    on-chain fill hash (reliable) and records the transfer.
            // intent id is a DECIMAL string — send it raw. toHexHash would
            // prefix `0x`, which the backend then reads as hex → wrong id → the
            // "intent not found" bug.
            const intentId = String((txResult as any).id);
            const completeRes = await signedFetch('/payments/complete', {
                method: 'POST',
                auth: true,
                json: { prepareId: prepare.prepareId, intentId },
                headers: { 'ngrok-skip-browser-warning': 'true' },
            });
            if (!completeRes.ok) {
                // On-chain send already succeeded — don't lose it if recording fails.
                console.error(
                    '[pay] complete (record) failed:',
                    completeRes.status,
                    await completeRes.text(),
                );
                return { hash: intentId };
            }
            const done = await completeRes.json();
            return { hash: done.hash || intentId };
        } catch (err: any) {
            const message = err.message || 'Payment failed';
            setError(message);
            throw err;
        } finally {
            setIsSending(false);
        }
    }, [buildRhinestoneAccount]);

    /**
     * Move USDT0 between the user's Money and Spot wallets (same-chain Plasma).
     * Backend prepares the calls + tells us which wallet signs (`signWith`); we
     * submit one intent with that passkey account; backend records both legs.
     * Fee is deducted (destination gets amount − fee).
     */
    const moveViaBackend = useCallback(async (params: {
        accessToken: string;
        direction: 'money-to-spot' | 'spot-to-money';
        amount: string;
    }): Promise<TransferResult> => {
        setIsSending(true);
        setError(null);

        try {
            const prepareRes = await signedFetch('/move/prepare', {
                method: 'POST',
                auth: true,
                json: { direction: params.direction, amount: params.amount },
                headers: { 'ngrok-skip-browser-warning': 'true' },
            });
            if (!prepareRes.ok) {
                throw new Error(`Prepare failed: ${prepareRes.status} ${await prepareRes.text()}`);
            }
            const prepare: {
                prepareId: string;
                chainId: number;
                signWith: 'money' | 'spot';
                calls: { to: string; value: string; data: string }[];
                tokenRequests: { address: string; amount: string }[];
            } = await prepareRes.json();

            // Sign with the wallet the backend chose (money for →Spot, spot for →Money).
            const account = await buildRhinestoneAccount(params.accessToken, prepare.signWith);
            const chain = getChainById(prepare.chainId);
            const txResult = await sendTx(account,{
                chain,
                calls: prepare.calls.map((c) => ({
                    to: c.to as `0x${string}`,
                    value: BigInt(c.value),
                    data: c.data as Hex,
                })),
                tokenRequests: prepare.tokenRequests.map((t) => ({
                    address: t.address as `0x${string}`,
                    amount: BigInt(t.amount),
                })),
            });
            await account.waitForExecution(txResult);

            // The backend resolves the real on-chain fill hash from the intent id.
            // intent id is a DECIMAL string — send it raw. toHexHash would
            // prefix `0x`, which the backend then reads as hex → wrong id → the
            // "intent not found" bug.
            const intentId = String((txResult as any).id);
            const completeRes = await signedFetch('/move/complete', {
                method: 'POST',
                auth: true,
                json: { prepareId: prepare.prepareId, intentId },
                headers: { 'ngrok-skip-browser-warning': 'true' },
            });
            if (!completeRes.ok) {
                console.error('[move] complete (record) failed:', completeRes.status, await completeRes.text());
                return { hash: intentId };
            }
            const done = await completeRes.json();
            return { hash: done.hash || intentId };
        } catch (err: any) {
            const message = err.message || 'Move failed';
            setError(message);
            throw err;
        } finally {
            setIsSending(false);
        }
    }, [buildRhinestoneAccount]);

    /**
     * Withdraw to an external EVM address. Backend prepares the calls + tells us
     * which wallet signs (`signWith`): Money withdraws USDT0 on Plasma, Spot
     * withdraws the chosen asset on its own chain. We submit one intent with that
     * passkey account; the backend records it. Fee is deducted (dest gets amount − fee).
     */
    const withdrawViaBackend = useCallback(async (params: {
        accessToken: string;
        walletType: 'money' | 'spot';
        toAddress: string;
        amount: string;
        symbol?: string;
        chainId?: number;
        destChainId?: number;
        // Money only: 'USDT' (default, sent directly) or 'USDC' (same-chain swap on
        // BSC → the response comes back swap-shaped and is submitted like a swap).
        outputToken?: 'USDT' | 'USDC';
    }): Promise<TransferResult> => {
        setIsSending(true);
        setError(null);

        try {
            const prepareRes = await signedFetch('/withdraw/prepare', {
                method: 'POST',
                auth: true,
                json: {
                    walletType: params.walletType,
                    toAddress: params.toAddress.trim(),
                    amount: params.amount,
                    ...(params.symbol ? { symbol: params.symbol } : {}),
                    ...(params.chainId ? { chainId: params.chainId } : {}),
                    ...(params.destChainId ? { destChainId: params.destChainId } : {}),
                    ...(params.outputToken ? { outputToken: params.outputToken } : {}),
                },
                headers: { 'ngrok-skip-browser-warning': 'true' },
            });
            if (!prepareRes.ok) {
                throw new Error(`Prepare failed: ${prepareRes.status} ${await prepareRes.text()}`);
            }
            const prepare: {
                prepareId: string;
                chainId: number;
                signWith: 'money' | 'spot';
                calls: { to: string; value: string; data: string }[];
                tokenRequests: { address: string; amount?: string }[];
                // Cross-chain only (present when destChainId differs): the swap
                // intent shape — source on sourceChainIds, fill on targetChainId.
                targetChainId?: number;
                sourceChainIds?: number[];
                sourceAssets?: { chainId: number; address: string; amount: string }[];
            } = await prepareRes.json();

            // Sign with the wallet the backend chose (money or spot).
            const account = await buildRhinestoneAccount(params.accessToken, prepare.signWith);
            const calls = prepare.calls.map((c) => ({
                to: c.to as `0x${string}`,
                value: BigInt(c.value),
                data: c.data as Hex,
            }));

            let intentId: string;
            if (prepare.sourceAssets?.length) {
                // SOURCE-ASSETS path — used by BOTH the spot cross-chain withdraw
                // (bridge to another chain) and the money USDT→USDC swap-out (same
                // chain in and out). Declare the source asset (exact input) so the
                // orchestrator finds the balance; the target-chain `calls` do the
                // delivery + fee skim, and `tokenRequests` names what to receive.
                // Target chain: explicit for cross-chain, else the source/prepare chain.
                const targetChainId = prepare.targetChainId ?? prepare.chainId;
                const sourceChainIds = prepare.sourceChainIds ?? [targetChainId];
                // Same-chain swap (money USDT→USDC): sponsor it so the relayer pays
                // gas + fills, instead of the account paying gas from the input and
                // waiting on a solver (which leaves small swaps stuck pending).
                const sameChain = sourceChainIds.every((id) => id === targetChainId);
                const txResult = await sendTx(account, {
                    sourceChains: sourceChainIds.map(getChainById),
                    targetChain: getChainById(targetChainId),
                    sourceAssets: prepare.sourceAssets.map((a) => ({
                        chain: getChainById(a.chainId),
                        address: a.address as `0x${string}`,
                        amount: BigInt(a.amount),
                    })),
                    calls,
                    tokenRequests: prepare.tokenRequests.map((t) => ({
                        address: t.address as `0x${string}`,
                        ...(t.amount ? { amount: BigInt(t.amount) } : {}),
                    })),
                    ...(sameChain ? { sponsored: true } : {}),
                } as any);
                await account.waitForExecution(txResult);
                intentId = String((txResult as any).id);
            } else if (isPlasmaChain(prepare.chainId)) {
                // Same-chain on Plasma: intent path (sendTransaction + tokenRequests —
                // the move-proven path; the raw user-op path hits pimlico's
                // "undefined.fast" on Plasma).
                const chain = getChainById(prepare.chainId);
                const txResult = await sendTx(account,{
                    chain,
                    calls,
                    tokenRequests: prepare.tokenRequests.map((t) => ({
                        address: t.address as `0x${string}`,
                        amount: BigInt(t.amount ?? '0'),
                    })),
                });
                await account.waitForExecution(txResult);
                // Intent id is a DECIMAL string — send it raw. toHexHash would
                // prefix `0x` → backend reads it as hex → wrong id → "not found".
                intentId = String((txResult as any).id);
            } else {
                // Non-Plasma same-chain: sponsored intent so Rhinestone covers gas
                // (the spot account may hold 0 native). No tokenRequests — the account
                // already holds the asset, so there's nothing to source; passing them
                // makes the same-chain fill 422 on liquidity.
                const chain = getChainById(prepare.chainId);
                const txResult = await sendTx(account,{ chain, calls, sponsored: true });
                const receipt = await account.waitForExecution(txResult);
                // Sponsored user-op: the receipt carries the real tx hash. Fall
                // back to the raw DECIMAL intent id (never toHexHash it → 0x
                // prefix would be read as hex → wrong id).
                intentId =
                    toHexHash((receipt as any)?.transactionHash) ||
                    String((txResult as any).id);
            }
            const completeRes = await signedFetch('/withdraw/complete', {
                method: 'POST',
                auth: true,
                json: { prepareId: prepare.prepareId, intentId },
                headers: { 'ngrok-skip-browser-warning': 'true' },
            });
            if (!completeRes.ok) {
                console.error('[withdraw] complete (record) failed:', completeRes.status, await completeRes.text());
                return { hash: intentId };
            }
            const done = await completeRes.json();
            return { hash: done.hash || intentId };
        } catch (err: any) {
            const message = err.message || 'Withdraw failed';
            setError(message);
            throw err;
        } finally {
            setIsSending(false);
        }
    }, [buildRhinestoneAccount]);

    /**
     * Fund an off-ramp payment: move the exact deposit amount from the wallet the
     * backend chose (Spot on Base for the USDC path) to Walapay's deposit address,
     * passkey-signed. Same prepare → sign+submit → complete shape as withdraw; the
     * paymentId lives in the URL so complete only needs the intentId.
     */
    const fundOfframpViaBackend = useCallback(async (params: {
        accessToken: string;
        paymentId: string;
    }): Promise<TransferResult> => {
        setIsSending(true);
        setError(null);
        try {
            const prepareRes = await signedFetch(
                `/offramp/payment/${params.paymentId}/fund/prepare`,
                {
                    method: 'POST',
                    auth: true,
                    headers: { 'ngrok-skip-browser-warning': 'true' },
                },
            );
            if (!prepareRes.ok) {
                throw new Error(`Prepare failed: ${prepareRes.status} ${await prepareRes.text()}`);
            }
            const prepare: {
                paymentId: string;
                chainId: number;
                signWith: 'money' | 'spot';
                calls: { to: string; value: string; data: string }[];
                tokenRequests: { address: string; amount: string }[];
                sourceChainId?: number;
                targetChainId?: number;
                crossChain?: boolean;
                demo?: boolean;
            } = await prepareRes.json();

            console.log('[offramp] fund/prepare →', prepare);

            // DEMO / SANDBOX mode: the backend simulates funding + settlement (no
            // on-chain send, no passkey signature) so the whole flow completes for
            // demos. Flip demoMode off (production) for the real cross-chain funding.
            if (prepare.demo) {
                const simRes = await signedFetch(
                    `/offramp/payment/${params.paymentId}/fund/simulate`,
                    { method: 'POST', auth: true, headers: { 'ngrok-skip-browser-warning': 'true' } },
                );
                if (!simRes.ok) {
                    throw new Error(`Simulate failed: ${simRes.status} ${await simRes.text()}`);
                }
                const sim = await simRes.json();
                return { hash: sim.fundingTxHash || sim.hash || 'demo' };
            }

            // Build the money/spot account and target the chain Walapay expects the
            // deposit on (targetChainId; falls back to chainId for older responses).
            const account = await buildRhinestoneAccount(params.accessToken, prepare.signWith);
            const targetChainId = prepare.targetChainId ?? prepare.chainId;
            const chain = getChainById(targetChainId);
            const calls = prepare.calls.map((c) => ({
                to: c.to as `0x${string}`,
                value: BigInt(c.value),
                data: c.data as Hex,
            }));
            const tokenRequests = prepare.tokenRequests.map((t) => ({
                address: t.address as `0x${string}`,
                amount: BigInt(t.amount),
            }));

            // Cross-chain (Money on BSC → Walapay's deposit on Base): pass BOTH
            // `sourceChains` (where to PULL from) and `targetChain` (where to fill) —
            // exactly like the working spot multi-source swap. Passing only `chain`
            // (no sourceChains) makes the orchestrator resolve sourceChains: [] →
            // "No viable route found". Same-chain (spot on Base/USDC) uses `chain`.
            const txResult = prepare.crossChain
                ? await sendTx(account, {
                      sourceChains: [getChainById(prepare.sourceChainId ?? targetChainId)],
                      targetChain: chain,
                      calls,
                      tokenRequests,
                      sponsored: true,
                  })
                : await sendTx(account, { chain, calls, sponsored: true });
            await account.waitForExecution(txResult);
            // The intent id is a DECIMAL string — send it RAW so the backend can BigInt()
            // it for pollIntentResult(). Do NOT send the tx hash: toHexHash(hash) is a
            // valid-but-WRONG bigint and would poll a non-existent intent (fund/complete
            // would then never resolve the settlement).
            const intentId = String((txResult as any).id);
            console.log('[offramp] intent submitted → intentId:', intentId, '| crossChain:', !!prepare.crossChain, '| targetChainId:', targetChainId);

            const completeRes = await signedFetch(
                `/offramp/payment/${params.paymentId}/fund/complete`,
                {
                    method: 'POST',
                    auth: true,
                    json: { intentId },
                    headers: { 'ngrok-skip-browser-warning': 'true' },
                },
            );
            if (!completeRes.ok) {
                console.error('[offramp fund] complete failed:', completeRes.status, await completeRes.text());
                return { hash: intentId };
            }
            const done = await completeRes.json();
            console.log('[offramp] fund/complete →', done);
            return { hash: done.fundingTxHash || done.hash || intentId };
        } catch (err: any) {
            const message = err.message || 'Off-ramp funding failed';
            setError(message);
            throw err;
        } finally {
            setIsSending(false);
        }
    }, [buildRhinestoneAccount]);

    /**
     * Activate the Spot account on Plasma — approve Permit2 to spend USDT0.
     * Because this is the account's FIRST outgoing action on Plasma, the UserOp
     * also DEPLOYS it. Uses the same gasless direct-UserOp path the Money wallet
     * already uses on Plasma (no bundler/orchestrator there; USDT0 ops sponsored).
     *
     * One-time: after this, Spot is a deployed, Permit2-approved account on Plasma,
     * so a cross-chain intent can source from it — the intent's claim does a
     * Permit2 transferFrom on Plasma, which needs exactly this deploy + approval
     * (both were missing, which is why the swap-from-Plasma claim failed).
     */
    const activateSpotOnPlasma = useCallback(async (params: {
        accessToken: string;
    }): Promise<TransferResult> => {
        setIsSending(true);
        setError(null);
        try {
            const account = await buildRhinestoneAccount(params.accessToken, 'spot');
            const data = encodeFunctionData({
                abi: erc20Abi,
                functionName: 'approve',
                args: [PERMIT2_ADDRESS, maxUint256],
            });
            // Use sendTransaction (NOT sendUserOperation) — on Plasma the raw
            // user-op path tries pimlico gas estimation, which doesn't support the
            // chain ("undefined.fast"). Move uses this same path and works.
            const txResult = await sendTx(account,{
                chain: plasma,
                calls: [{ to: PLASMA_USDT0_ADDRESS as `0x${string}`, value: BigInt(0), data }],
            } as any);
            const receipt = await account.waitForExecution(txResult);
            return {
                hash: toHexHash((receipt as any)?.transactionHash)
                    || toHexHash((txResult as any)?.id) || 'submitted',
            };
        } catch (err: any) {
            const message = err?.message || 'Activation failed';
            setError(message);
            throw err;
        } finally {
            setIsSending(false);
        }
    }, [buildRhinestoneAccount]);

    /**
     * Activate the Spot account on ANY chain — deploy it + approve Permit2 to
     * spend the given tokens. Generalizes {@link activateSpotOnPlasma} to Base /
     * Arbitrum / etc. via the orchestrator (sponsored, call-only intent: an
     * `approve` moves no funds, so it needs no prior Permit2 approval — it just
     * deploys the account on its first outgoing action and sets the approvals).
     *
     * Required ONCE per (chain, token) before the orchestrator can source funds
     * from Spot on that chain (withdraw / swap / move) — the intent's claim does
     * a Permit2 `transferFrom`, which needs exactly this deploy + approval.
     */
    const activateSpotOnChain = useCallback(async (params: {
        accessToken: string;
        chainId: number;
        tokenAddresses: string[];
    }): Promise<TransferResult> => {
        setIsSending(true);
        setError(null);
        try {
            if (!params.tokenAddresses.length) {
                throw new Error('No tokens to approve');
            }
            const account = await buildRhinestoneAccount(params.accessToken, 'spot');
            const chain = Object.values(viemChains).find(
                (c: any) => c?.id === params.chainId,
            );
            if (!chain) {
                throw new Error(`Chain ${params.chainId} not found in viem/chains`);
            }
            const calls = params.tokenAddresses.map((token) => ({
                to: token as `0x${string}`,
                value: BigInt(0),
                data: encodeFunctionData({
                    abi: erc20Abi,
                    functionName: 'approve',
                    args: [PERMIT2_ADDRESS, maxUint256],
                }),
            }));
            // DIRECT user-op (NOT the orchestrator): an approve moves no funds,
            // so it can't route through the intents path (which sources via
            // Permit2 — the very thing we're bootstrapping). `sendUserOperation`
            // deploys the account on its first action + runs the approvals.
            // Gas is paid from the account's own balance (needs a little ETH on
            // the chain) — `sponsored` isn't wired to a paymaster on this path
            // yet (production TODO: configure a paymaster so no ETH is needed).
            const txResult = await account.sendUserOperation({
                chain,
                calls,
            } as any);
            const receipt = await account.waitForExecution(txResult);
            return {
                hash: toHexHash((receipt as any)?.transactionHash)
                    || toHexHash((txResult as any)?.id) || 'submitted',
            };
        } catch (err: any) {
            const message = err?.message || 'Spot activation failed';
            setError(message);
            throw err;
        } finally {
            setIsSending(false);
        }
    }, [buildRhinestoneAccount]);

    /**
     * Quote a swap without submitting — calls /swap/prepare, which quotes the
     * intent server-side and returns the expected output, the net you'll receive
     * (after the 0.1% fee, taken in the destination token) and the fee itself.
     * Use it to show a "you'll receive ~X" preview before the user confirms.
     */
    const quoteSwap = useCallback(async (params: {
        accessToken: string;
        fromToken: string; fromSymbol: string; fromDecimals: number; fromChainId: number;
        // Omit toToken/toChainId/toDecimals to let the backend RESOLVER auto-pick the
        // output chain (BSC-preferred) from just toSymbol.
        toToken?: string; toSymbol: string; toDecimals?: number; toChainId?: number;
        amount: string;
    }): Promise<SwapSummary> => {
        const res = await signedFetch('/swap/prepare', {
            method: 'POST',
            auth: true,
            json: {
                fromToken: params.fromToken, fromSymbol: params.fromSymbol,
                fromDecimals: params.fromDecimals, fromChainId: params.fromChainId,
                toSymbol: params.toSymbol,
                ...(params.toToken ? { toToken: params.toToken } : {}),
                ...(params.toChainId != null ? { toChainId: params.toChainId } : {}),
                ...(params.toDecimals != null ? { toDecimals: params.toDecimals } : {}),
                amount: params.amount,
            },
            headers: { 'ngrok-skip-browser-warning': 'true' },
        });
        if (!res.ok) throw new Error(`Quote failed: ${res.status} ${await res.text()}`);
        const prepare = await res.json();
        return prepare.summary as SwapSummary;
    }, []);

    /**
     * Swap a supported asset in Spot into ANY token, via a Rhinestone intent.
     * Backend returns the intent spec (sourceAssets = exact input, tokenRequests
     * = destination token with no amount → receive max); we build the Spot
     * account, submit the intent (orchestrator quotes + routes), backend records.
     * No DEX.
     */
    const swapViaBackend = useCallback(async (params: {
        accessToken: string;
        fromToken: string; fromSymbol: string; fromDecimals: number; fromChainId: number;
        // Omit toToken/toChainId/toDecimals to let the backend RESOLVER auto-pick the
        // output chain (BSC-preferred) from just toSymbol.
        toToken?: string; toSymbol: string; toDecimals?: number; toChainId?: number;
        amount: string;
    }): Promise<TransferResult> => {
        setIsSending(true);
        setError(null);

        try {
            const prepareRes = await signedFetch('/swap/prepare', {
                method: 'POST',
                auth: true,
                json: {
                    fromToken: params.fromToken, fromSymbol: params.fromSymbol,
                    fromDecimals: params.fromDecimals, fromChainId: params.fromChainId,
                    toSymbol: params.toSymbol,
                    ...(params.toToken ? { toToken: params.toToken } : {}),
                    ...(params.toChainId != null ? { toChainId: params.toChainId } : {}),
                    ...(params.toDecimals != null ? { toDecimals: params.toDecimals } : {}),
                    amount: params.amount,
                },
                headers: { 'ngrok-skip-browser-warning': 'true' },
            });
            if (!prepareRes.ok) {
                throw new Error(`Prepare failed: ${prepareRes.status} ${await prepareRes.text()}`);
            }
            const prepare: {
                prepareId: string;
                targetChainId: number;
                sourceChainIds: number[];
                sponsored?: boolean;
                calls: { to: string; value: string; data: string }[];
                tokenRequests: { address: string; amount?: string }[];
                sourceAssets?: { chainId: number; address: string; amount: string }[];
            } = await prepareRes.json();

            const account = await buildRhinestoneAccount(params.accessToken, 'spot');
            const txResult = await sendTx(account,{
                sourceChains: prepare.sourceChainIds.map(getChainById),
                targetChain: getChainById(prepare.targetChainId),
                // Match the backend's sponsored quote — our balance covers gas so
                // the user pays none (defaults true if the field is absent).
                sponsored: prepare.sponsored ?? true,
                // Exact-input: declare the source asset explicitly (matches the
                // working quote) so the orchestrator finds the balance, instead of
                // relying on Warp auto-pick — which zero-balances a fresh account.
                ...(prepare.sourceAssets?.length ? {
                    sourceAssets: prepare.sourceAssets.map((a) => ({
                        chain: getChainById(a.chainId),
                        address: a.address as `0x${string}`,
                        amount: BigInt(a.amount),
                    })),
                } : {}),
                calls: (prepare.calls || []).map((c) => ({
                    to: c.to as `0x${string}`,
                    value: BigInt(c.value),
                    data: c.data as Hex,
                })),
                tokenRequests: prepare.tokenRequests.map((t) => ({
                    address: t.address as `0x${string}`,
                    ...(t.amount ? { amount: BigInt(t.amount) } : {}),
                })),
            } as any);
            await account.waitForExecution(txResult);

            // intent id is a DECIMAL string — send it raw. toHexHash would
            // prefix `0x`, which the backend then reads as hex → wrong id → the
            // "intent not found" bug.
            const intentId = String((txResult as any).id);
            const completeRes = await signedFetch('/swap/complete', {
                method: 'POST',
                auth: true,
                json: { prepareId: prepare.prepareId, intentId },
                headers: { 'ngrok-skip-browser-warning': 'true' },
            });
            if (!completeRes.ok) {
                console.error('[swap] complete failed:', completeRes.status, await completeRes.text());
                return { hash: intentId };
            }
            const done = await completeRes.json();
            return { hash: done.hash || intentId };
        } catch (err: any) {
            const message = err.message || 'Swap failed';
            setError(message);
            throw err;
        } finally {
            setIsSending(false);
        }
    }, [buildRhinestoneAccount]);

    /**
     * Get the portfolio (token balances across all chains) for the user's account.
     */
    const getPortfolio = useCallback(async (params: {
        accessToken: string;
        walletType: 'spot' | 'money';
    }) => {
        const rhinestoneAccount = await buildRhinestoneAccount(
            params.accessToken,
            params.walletType,
        );
        return rhinestoneAccount.getPortfolio();
    }, [buildRhinestoneAccount]);

    /**
     * The BACKEND portfolio for a wallet (`GET /wallet/balances`) — the same
     * per-asset + per-chain view the swap uses to decide which chains to source a
     * multi-source swap from. Use this (not the SDK getPortfolio) to preview what a
     * swap will actually aggregate, since the backend only sees registry-active
     * chains/tokens.
     */
    const getBackendBalances = useCallback(async (params: {
        accessToken: string;
        walletType: 'spot' | 'money';
    }): Promise<{
        totalUsd: string;
        assets: {
            symbol: string; name?: string; totalBalance: string;
            totalUsdValue: string; decimals: number; logoURI?: string | null;
            chains: { chainId: number; type: string; network: string; address: string; balance: string; usdValue: number }[];
        }[];
    }> => {
        const res = await signedFetch(`/wallet/balances?walletType=${params.walletType}`, {
            method: 'GET',
            auth: true,
            headers: { 'ngrok-skip-browser-warning': 'true' },
        });
        if (!res.ok) throw new Error(`Balances failed: ${res.status} ${await res.text()}`);
        return res.json();
    }, []);

    /**
     * TEMP (deposit debug): deploy a wallet on a chain up front, so its FIRST
     * deposit bridge only has to enable+use the deposit session on an already
     * deployed account (the path that works) instead of deploy+enable in one tx
     * (which fails InvalidSignature). Sponsored/gasless — passkey signs.
     */
    const deployWallet = useCallback(async (params: {
        accessToken: string;
        walletType: 'spot' | 'money';
        chainId: number;
    }) => {
        setError(null);
        setIsSending(true);
        try {
            const account = await buildRhinestoneAccount(
                params.accessToken,
                params.walletType,
            );
            const chain = getChainById(params.chainId);
            const deployed = await account.deploy(chain, { sponsored: true });
            return { deployed, address: account.getAddress() };
        } catch (err: any) {
            setError(err.message || 'Deploy failed');
            throw err;
        } finally {
            setIsSending(false);
        }
    }, [buildRhinestoneAccount]);

    return {
        sendEvmTransfer,
        sendCrossChainTransfer,
        payViaBackend,
        moveViaBackend,
        withdrawViaBackend,
        fundOfframpViaBackend,
        activateSpotOnPlasma,
        activateSpotOnChain,
        quoteSwap,
        swapViaBackend,
        getPortfolio,
        getBackendBalances,
        deployWallet,
        isSending,
        error,
    };
}
