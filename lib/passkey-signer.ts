import { startAuthentication } from '@simplewebauthn/browser';
import type { Hex, TypedDataDefinition } from 'viem';
import { toHex, keccak256 } from 'viem';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';

/**
 * Custom signer that uses passkey authentication via our backend
 * This integrates with ZeroDev SDK while using our own passkey infrastructure
 */
export class PasskeySigner {
    private accessToken: string;

    constructor(accessToken: string) {
        this.accessToken = accessToken;
    }

    /**
     * Sign a message hash using passkey
     * This is called by ZeroDev when signing UserOperations
     */
    async signMessage(message: { raw: Uint8Array } | { message: string }): Promise<Hex> {
        console.log('PasskeySigner.signMessage called:', message);

        // Extract the raw bytes to sign
        let dataToSign: Uint8Array;
        if ('raw' in message) {
            dataToSign = message.raw;
        } else {
            // Convert string message to bytes
            dataToSign = new TextEncoder().encode(message.message);
        }

        // Hash the data
        const dataHash = keccak256(dataToSign);
        console.log('Data hash to sign:', dataHash);

        // Step 1: Request signing challenge from backend
        const challengeRes = await fetch(`${API_BASE}/wallet/sign-challenge`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.accessToken}`,
                'ngrok-skip-browser-warning': 'true'
            },
            body: JSON.stringify({
                dataHash,
                chainId: 11155111 // TODO: Make dynamic
            })
        });

        if (!challengeRes.ok) {
            const error = await challengeRes.json();
            throw new Error(`Failed to get signing challenge: ${error.message}`);
        }

        const challengeOptions = await challengeRes.json();
        console.log('Got signing challenge:', challengeOptions);

        // Step 2: Prompt user for passkey signature
        const assertion = await startAuthentication(challengeOptions);
        console.log('Got passkey assertion:', assertion);

        // Step 3: Verify signature with backend and get formatted signature
        const verifyRes = await fetch(`${API_BASE}/wallet/verify-signature`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.accessToken}`,
                'ngrok-skip-browser-warning': 'true'
            },
            body: JSON.stringify({
                dataHash,
                credential: assertion
            })
        });

        if (!verifyRes.ok) {
            const error = await verifyRes.json();
            throw new Error(`Failed to verify signature: ${error.message}`);
        }

        const { signature } = await verifyRes.json();
        console.log('Got formatted signature:', signature);

        return signature as Hex;
    }

    /**
     * Sign typed data (EIP-712)
     * For now, we'll use the same flow as signMessage
     */
    async signTypedData(typedData: TypedDataDefinition): Promise<Hex> {
        console.log('PasskeySigner.signTypedData called:', typedData);

        // Hash the typed data
        const dataHash = keccak256(toHex(JSON.stringify(typedData)));

        // Use the same signing flow
        return this.signMessage({ raw: new Uint8Array(Buffer.from(dataHash.slice(2), 'hex')) });
    }

    /**
     * Get the signer's address
     * This should return the smart account address
     */
    get address(): Hex {
        // This will be set by the account creation process
        throw new Error('Address should be provided by the account');
    }
}
