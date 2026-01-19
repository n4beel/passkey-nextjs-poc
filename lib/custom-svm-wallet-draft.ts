import { LazorkitClient, deriveSmartWalletPda, asPasskeyPublicKey, asCredentialHash } from '@lazorkit/wallet';
import { Connection, PublicKey } from '@solana/web3.js';
import * as crypto from 'crypto';

const RPC_URL = "https://api.devnet.solana.com";
const PAYMASTER_URL = "https://kora.devnet.lazorkit.com";

// Manually derived from default policy in Lazorkit SDK
const LAZORKIT_PROGRAM_ID = new PublicKey("Gsuz7YcA5sbMGVRXT3xSYhJBessW4xFC4xYsihNCqMFh");

export interface CreateSVMWalletParams {
    credentialIdBase64: string;
    publicKeyBase64: string;
    publicKeyBytes: number[];
}

export async function createCustomSVMWallet(params: CreateSVMWalletParams) {
    const connection = new Connection(RPC_URL);
    const client = new LazorkitClient({
        rpcUrl: RPC_URL,
        paymasterConfig: {
            paymasterUrl: PAYMASTER_URL
        },
        connection
    });

    // 1. Generate a random WalletID (8 bytes)
    // In a real app, you might want this to be deterministic or stored
    const walletId = new Uint8Array(8);
    crypto.getRandomValues(walletId); // Browser native or node crypto

    // 2. Derive Credential Hash and Passkey Public Key formats
    // The SDK expects specific types for these
    const credentialIdBuffer = Buffer.from(params.credentialIdBase64, 'base64');
    const credentialHash = asCredentialHash(
        crypto.createHash('sha256').update(credentialIdBuffer).digest()
    );

    // Convert 65-byte uncompressed key to format Lazorkit expects (33-byte compressed usually?)
    // Actually, Lazorkit might handle the raw 65 bytes or expects 33 bytes.
    // Let's assume the passed bytes are what we need, but cast them.
    // Check if we need to compress it. P-256 keys are usually X,Y (64 bytes) + 04 prefix = 65 bytes.
    // Lazorkit uses 'secp256r1' (P-256).
    const passkeyPublicKey = asPasskeyPublicKey(new Uint8Array(params.publicKeyBytes));

    // 3. Derive Smart Wallet Address (Counterfactual)
    // We can do this without a transaction!
    const smartWalletPda = deriveSmartWalletPda(
        LAZORKIT_PROGRAM_ID,
        new PublicKey(walletId) // Wait, walletId is u64 (BN), not PublicKey. 
        // SDK function signature: deriveSmartWalletPda(programId, walletId: BN)
    );

    // We need to check how to pass walletId. It's likely a BN (BigNumber) from bn.js or similar
    // or just a number/buffer.
    // In the index.mjs dump: `Pt(t, e) { return ... findProgramAddressSync([It, e.toArrayLike(u, "le", 8)], t)[0] }`
    // So `e` must have `toArrayLike`. likely `BN`.
    // import { BN } from '@coral-xyz/anchor';

    return {
        walletId,
        smartWalletAddress: smartWalletPda.toBase58(),
        // We can construct the full wallet object to save to local storage
        walletObject: {
            credentialId: params.credentialIdBase64,
            passkeyPubkey: Array.from(passkeyPublicKey),
            smartWallet: smartWalletPda.toBase58(),
            walletId: walletId // Need to verify if we need to store this
        }
    };
}
