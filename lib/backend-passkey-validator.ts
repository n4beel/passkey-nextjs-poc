import { startAuthentication } from '@simplewebauthn/browser';
import type { WebAuthnKey } from '@zerodev/webauthn-key';
import { toHex, keccak256, type Hex } from 'viem';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';

/**
 * Creates a custom WebAuthnKey that uses our backend for signing
 * This wraps the signing logic while maintaining compatibility with ZeroDev's validator
 */
export async function createBackendPasskeyValidator(
    accessToken: string,
    credentialId: string,
    pubX: string,
    pubY: string
): Promise<WebAuthnKey> {
    // Decode credentialId from base64 to bytes
    const base64ToBytes = (base64url: string): Uint8Array => {
        const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    };

    const credentialIdBytes = base64ToBytes(credentialId);

    // Create a WebAuthnKey object with our custom signing logic
    const webAuthnKey: WebAuthnKey = {
        pubX: BigInt(pubX),
        pubY: BigInt(pubY),
        authenticatorId: toHex(credentialIdBytes),
        authenticatorIdHash: keccak256(credentialIdBytes),
        rpID: window.location.hostname,

        // Override the sign method to use our backend
        sign: async (challenge: Uint8Array): Promise<{ signature: Hex; webAuthnData: any }> => {
            console.log('Custom sign method called with challenge:', toHex(challenge));

            // Hash the challenge
            const dataHash = keccak256(challenge);
            console.log('Challenge hash:', dataHash);

            try {
                // Step 1: Request signing challenge from backend
                const challengeRes = await fetch(`${API_BASE}/wallet/sign-challenge`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${accessToken}`,
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
                console.log('Got signing challenge from backend');

                // Step 2: Prompt user for passkey signature
                const assertion = await startAuthentication(challengeOptions);
                console.log('Got passkey assertion from user');

                // Step 3: Verify signature with backend
                const verifyRes = await fetch(`${API_BASE}/wallet/verify-signature`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${accessToken}`,
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

                const { signature, metadata } = await verifyRes.json();
                console.log('Got verified signature from backend');

                return {
                    signature: signature as Hex,
                    webAuthnData: {
                        authenticatorData: assertion.response.authenticatorData,
                        clientDataJSON: assertion.response.clientDataJSON,
                        challengeIndex: 0,
                        typeIndex: 0,
                        userVerificationRequired: true
                    }
                };
            } catch (error) {
                console.error('Error in custom sign method:', error);
                throw error;
            }
        }
    };

    return webAuthnKey;
}
