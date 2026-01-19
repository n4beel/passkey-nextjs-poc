import { deriveSmartWalletPda, asPasskeyPublicKey, asCredentialHash } from '@lazorkit/wallet';
import { PublicKey } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { sha256 } from 'js-sha256';

const LAZORKIT_PROGRAM_ID = new PublicKey("Gsuz7YcA5sbMGVRXT3xSYhJBessW4xFC4xYsihNCqMFh");

export interface CreateSVMWalletParams {
    credentialIdBase64: string;
    publicKeyBase64: string;
}

export interface SVMWalletResult {
    address: string;
    walletId: string;
    credentialId: string;
}

/**
 * Creates a counterfactual SVM wallet using a custom passkey.
 * Bypasses the default Lazorkit popup flow.
 */
export async function createCustomSVMWallet(params: CreateSVMWalletParams): Promise<SVMWalletResult> {
    // 1. Derive Deterministic WalletID (u64)
    // We want the wallet address to be the same for the same credential.
    // So we hash the credentialId and take the first 8 bytes.
    const credentialIdBytesForWalletId = Uint8Array.from(atob(params.credentialIdBase64), c => c.charCodeAt(0));
    const walletIdHash = sha256.create();
    walletIdHash.update(credentialIdBytesForWalletId);
    const fullHash = walletIdHash.array(); // number[]

    // Take first 8 bytes for u64
    const walletIdBytes = fullHash.slice(0, 8);
    const walletId = new BN(walletIdBytes, 'le');

    // 2. Derive Credential Hash (Standard Lazorkit logic)
    // We use js-sha256 for browser compatibility
    // Use the bytes again (or re-decode, same result)
    const credentialIdBytes = Uint8Array.from(atob(params.credentialIdBase64), c => c.charCodeAt(0));
    const hash = sha256.create();
    hash.update(credentialIdBytes);
    const hashBytes = hash.array();

    const credentialHash = asCredentialHash(hashBytes);

    // 3. Process Public Key
    const publicKeyBytes = Array.from(atob(params.publicKeyBase64), c => c.charCodeAt(0));
    const passkeyPublicKey = asPasskeyPublicKey(publicKeyBytes);

    // 4. Derive Smart Wallet Address
    const smartWalletPda = deriveSmartWalletPda(
        LAZORKIT_PROGRAM_ID,
        walletId
    );

    return {
        address: smartWalletPda.toBase58(),
        walletId: walletId.toString(),
        credentialId: params.credentialIdBase64
    };
}

/**
 * Helper to get existing wallet info if using the hook (legacy support)
 */
export function getSVMWalletInfo(wallet: any): { address: string } | null {
    if (!wallet || !wallet.smartWallet) return null;
    return { address: wallet.smartWallet };
}
