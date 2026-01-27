import { useState } from 'react';
import { PublicKey, TransactionInstruction, VersionedTransaction, TransactionMessage, Transaction, Connection } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import {
    LazorkitClient,
    Paymaster,
    SmartWalletAction,
    PasskeySignature,
    PasskeyPublicKey,
    CredentialHash,
    Signature
} from '@lazorkit/wallet';
import { getConnection } from '@/lib/solana-utils';

interface UseLazorkitCustomSignerProps {
    credentialId: string;
    passkeyPublicKey: {
        x: string;
        y: string;
    };
    authenticatorData?: string;
    clientDataJSON?: string;
    signature?: string;
}

export function useLazorkitCustomSigner() {
    const [isSigning, setIsSigning] = useState(false);

    /**
     * Converts a base64url string to Uint8Array/Buffer
     */
    const b64ToBytes = (base64: string): Uint8Array => {
        const binString = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
        return Uint8Array.from(binString, (m) => m.codePointAt(0)!);
    };

    /**
     * Converts raw bytes to base64 (standard)
     */
    const bytesToBase64 = (bytes: Uint8Array): string => {
        return btoa(String.fromCharCode(...bytes));
    };

    const signAndSendTransaction = async (
        instructions: TransactionInstruction[],
        config: UseLazorkitCustomSignerProps
    ): Promise<string> => {
        setIsSigning(true);
        try {
            // Use 'confirmed' connection for transaction confirmation and general safety
            const connection = getConnection();

            // Use 'processed' connection for LazorkitClient to ensure we read the latest Nonce.
            // This prevents stale reads (e.g., Nonce 4 instead of 5) immediately after a transaction,
            // which causes "0x2 Invalid Account Data" errors when trying to create an already-existing Chunk.
            const readConnection = new Connection(connection.rpcEndpoint, 'processed');
            const lazorkitClient = new LazorkitClient(readConnection);

            const paymaster = new Paymaster({
                paymasterUrl: process.env.NEXT_PUBLIC_LAZORKIT_PAYMASTER_URL || 'https://kora.devnet.lazorkit.com'
            });

            // Helper: Convert Base64Url (RFC 4648) to Standard Base64
            // WebAuthn/Passkeys usually return Base64Url which uses '-' and '_'
            // LazorKit expects Standard Base64 which uses '+' and '/'
            const base64UrlToBase64 = (input: string) => {
                let output = input.replace(/-/g, "+").replace(/_/g, "/");
                const pad = output.length % 4;
                if (pad) {
                    if (pad === 1) throw new Error("InvalidLengthError: Input base64url string is the wrong length to determine padding");
                    output += new Array(5 - pad).join("=");
                }
                return output;
            };

            // 2. Prepare Identity Data
            const sanitizedCredentialId = base64UrlToBase64(config.credentialId);
            const credentialIdBytes = b64ToBytes(sanitizedCredentialId);

            // 2a. Calculate Credential Hash
            // We need SHA-256 hash of credentialId bytes (LazorKit/Solana standard)
            // viem's keccak256 is incorrect here. Using sha256 from viem (if available) or crypto.subtle
            const { sha256, hexToBytes } = await import('viem');
            const credentialHashHex = sha256(credentialIdBytes);
            // Convert hex string to number array for LazorKit types
            const credentialHashBytes = hexToBytes(credentialHashHex);
            const credentialHash = Array.from(credentialHashBytes) as unknown as CredentialHash;

            // ... (Keys extraction same) ...

            const xBytes = Buffer.from(config.passkeyPublicKey.x.replace(/^0x/, ''), 'hex');
            const yBytes = Buffer.from(config.passkeyPublicKey.y.replace(/^0x/, ''), 'hex');
            const yIsEven = (yBytes[yBytes.length - 1] & 1) === 0;
            const prefix = yIsEven ? 0x02 : 0x03;
            const compressedKey = Buffer.concat([Buffer.from([prefix]), xBytes]);
            const passkeyPublicKey = Array.from(compressedKey) as unknown as PasskeyPublicKey;

            // 3. Find Smart Wallet
            const payer = await paymaster.getPayer(); // Get Paymaster address first for potential creation
            let walletInfo = await lazorkitClient.getSmartWalletByCredentialHash(credentialHash);

            if (!walletInfo) {
                console.log("Smart Wallet not found. Initializing new wallet...");

                // Derive Wallet ID deterministically (SHA-256 first 8 bytes)
                // This matches backend logic in WalletService.deriveSVMAddress
                const walletIdHashHex = sha256(credentialIdBytes);
                const walletIdHashBytes = hexToBytes(walletIdHashHex);
                const walletIdBytes = walletIdHashBytes.slice(0, 8); // First 8 bytes
                const smartWalletId = new anchor.BN(walletIdBytes, 'le');

                console.log("Initializing Wallet with ID:", smartWalletId.toString());

                // Create Smart Wallet Transaction
                // Note: CreateSmartWalletParams does NOT require a passkey signature based on types
                const { transaction: createTx } = await lazorkitClient.createSmartWalletTxn({
                    payer,
                    passkeyPublicKey,
                    credentialIdBase64: sanitizedCredentialId,
                    smartWalletId
                });

                console.log("Submitting Create Wallet Transaction...");
                const createTxHash = await paymaster.signAndSend(createTx as any);
                console.log("Wallet Creation Tx Hash:", createTxHash);

                // Wait for confirmation
                await connection.confirmTransaction(createTxHash, 'confirmed');
                console.log("Wallet Initialized!");

                // Re-fetch wallet info just to be sure
                const verifiedWalletInfo = await lazorkitClient.getSmartWalletByCredentialHash(credentialHash);
                if (!verifiedWalletInfo) {
                    throw new Error("Failed to verify wallet after creation.");
                }
                walletInfo = verifiedWalletInfo; // Populate walletInfo for next steps
            }

            // Since we might have just initialized, ensure walletInfo is populated
            // (If we initialized, we fetched it above. If we didn't, we found it initially).
            // Logic fix: We need to handle the case where walletInfo was null initially.

            // Re-fetch or use populated data
            const finalWalletInfo = await lazorkitClient.getSmartWalletByCredentialHash(credentialHash);
            if (!finalWalletInfo) throw new Error("Critical Error: Wallet still not found.");

            const { smartWallet, walletDevice } = finalWalletInfo;
            console.log("Found Wallet:", smartWallet.toBase58());

            // 4. Build Authorization Message
            // payer is already defined above
            const timestamp = new anchor.BN(Math.floor(Date.now() / 1000));



            const actionArgs = {
                type: SmartWalletAction.CreateChunk,
                args: {
                    cpiInstructions: instructions,
                    expiresAt: timestamp.toNumber() + 300, // 5 mins expiry
                    cpiSigners: []
                }
            };

            const challenge = await lazorkitClient.buildAuthorizationMessage({
                action: actionArgs as any, // Cast to satisfy TS if enum mismatch
                payer,
                smartWallet,
                passkeyPublicKey,
                credentialHash,
                timestamp
            });

            // 5. Sign with WebAuthn
            const challengeBase64 = bytesToBase64(new Uint8Array(challenge));

            const credential = await navigator.credentials.get({
                publicKey: {
                    challenge: new Uint8Array(challenge) as unknown as BufferSource,
                    allowCredentials: [{
                        id: credentialIdBytes as unknown as BufferSource,
                        type: 'public-key',
                        transports: ['internal', 'hybrid']
                    }],
                    userVerification: 'required',
                    timeout: 60000
                }
            }) as PublicKeyCredential;

            if (!credential) throw new Error("Failed to get credential");

            const response = credential.response as AuthenticatorAssertionResponse;

            // Helper to convert DER signature to Raw Format (64 bytes)
            // WebAuthn returns generic DER signature (ASN.1)
            // LazorKit expects P1363 Raw Format (r + s, 32 bytes each)
            const derToRaw = (signature: Uint8Array): Uint8Array => {
                const rStart = 4;
                const rLen = signature[3];
                const rEnd = rStart + rLen;

                // R value (skip leading 0x00 if present to fit 32 bytes)
                let r = signature.slice(rStart, rEnd);
                while (r.length > 32 && r[0] === 0) r = r.slice(1);

                const sStart = rEnd + 2;
                const sLen = signature[rEnd + 1];

                // S value
                let s = signature.slice(sStart, sStart + sLen);
                while (s.length > 32 && s[0] === 0) s = s.slice(1);

                // Pad if necessary (though unlikely for valid secp256r1 sigs usually)
                const raw = new Uint8Array(64);
                raw.set(r, 32 - r.length); // Right align R
                raw.set(s, 64 - s.length); // Right align S
                return raw;
            };

            const rawSignature = derToRaw(new Uint8Array(response.signature));

            // 6. Construct PasskeySignature object
            const signatureObj: PasskeySignature = {
                passkeyPublicKey,
                signature64: bytesToBase64(rawSignature),
                clientDataJsonRaw64: bytesToBase64(new Uint8Array(response.clientDataJSON)),
                authenticatorDataRaw64: bytesToBase64(new Uint8Array(response.authenticatorData))
            };

            // Verify Wallet State and Nonce
            const walletStateData = await lazorkitClient.getWalletStateData(smartWallet);
            console.log("Wallet State Data:", walletStateData);
            console.log("Current Last Nonce:", walletStateData.lastNonce.toString());

            // SYNC CHECK: Ensure 'confirmed' state catches up to 'processed' state
            // The Paymaster likely uses 'confirmed' commitment. If we are ahead (processed),
            // we must wait for the network to confirm the previous nonce increment before sending the next one.
            try {
                const confirmedClient = new LazorkitClient(connection); // connection is 'confirmed' by default
                let retries = 0;
                while (retries < 30) { // Wait up to 30s
                    const confirmedWalletState = await confirmedClient.getWalletStateData(smartWallet);
                    const confirmedNonce = confirmedWalletState.lastNonce;

                    if (confirmedNonce.gte(walletStateData.lastNonce)) {
                        console.log(`Confirmed Nonce (${confirmedNonce.toString()}) caught up to Processed Nonce (${walletStateData.lastNonce.toString()}).`);
                        break;
                    }

                    console.log(`Waiting for Confirmed Nonce (${confirmedNonce.toString()}) to catch up to Processed (${walletStateData.lastNonce.toString()})...`);
                    await new Promise(r => setTimeout(r, 1000));
                    retries++;
                }
            } catch (e) {
                console.warn("Error checking confirmed nonce status:", e);
                // Proceed anyway, maybe paymaster is faster
            }

            // Fetch Shared ALT to reduce transaction size
            const SHARED_ALT_ADDRESS = new PublicKey('6FztWHetKgJdfeBYmX1T71Ws41ePD39fQska48NhNk8');
            let addressLookupTables: any[] = [];
            try {
                const altAccountVal = await connection.getAddressLookupTable(SHARED_ALT_ADDRESS);
                if (altAccountVal.value) {
                    addressLookupTables = [altAccountVal.value];
                    console.log("Loaded Shared Valid Address Lookup Table:", SHARED_ALT_ADDRESS.toBase58());
                }
            } catch (e) {
                console.warn("Failed to load Shared ALT:", e);
            }

            // Validate Wallet Device derivation
            // 0x2 Error often implies invalid account data (e.g. wrong address derived vs on-chain)
            const derivedWalletDevice = lazorkitClient.getWalletDevicePubkey(smartWallet, credentialHash);
            console.log("Found Wallet Device (On-Chain):", finalWalletInfo.walletDevice.toString());
            console.log("Derived Wallet Device (Local):", derivedWalletDevice.toString());

            if (finalWalletInfo.walletDevice.toString() !== derivedWalletDevice.toString()) {
                console.error("CRITICAL: Wallet Device Mismatch! Derived hash might be wrong.");
            }

            // Verify Wallet Device actually calls getAccountInfo
            const deviceAccountInfo = await connection.getAccountInfo(finalWalletInfo.walletDevice);
            if (!deviceAccountInfo) {
                console.error("CRITICAL: Wallet Device Account NOT FOUND on-chain!");
            } else {
                console.log("Wallet Device Account Verified On-Chain. Size:", deviceAccountInfo.data.length);
            }

            // Derive Chunk PDA
            const chunkPda = lazorkitClient.getChunkPubkey(smartWallet, walletStateData.lastNonce);
            console.log("Chunk PDA:", chunkPda.toString());

            let chunkExists = false;
            try {
                const chunkData = await lazorkitClient.getChunkData(chunkPda);
                if (chunkData) {
                    console.log("Chunk already exists! Skipping creation...");
                    chunkExists = true;
                }
            } catch (e) {
                console.log("Chunk does not exist (or fetch failed). Proceeding to create...");
            }

            let txHash = "";

            if (!chunkExists) {
                // 7. Create Transaction (Create Chunk)
                console.log("Input Instructions Count:", instructions.length);

                const transaction = await lazorkitClient.createChunkTxn({
                    payer,
                    smartWallet,
                    passkeySignature: signatureObj,
                    credentialHash,
                    timestamp,
                    cpiInstructions: instructions,
                }, {
                    addressLookupTables // Use the fetched ALTs
                });

                // 8. Send via Paymaster
                const MAX_RETRIES = 10;
                for (let i = 0; i < MAX_RETRIES; i++) {
                    try {
                        console.log(`Submitting CreateChunk transaction via Paymaster (Attempt ${i + 1})...`);

                        if ('version' in transaction) {
                            console.log("Using Versioned Transaction for Create Chunk (Native)");
                            txHash = await paymaster.signAndSendVersionedTransaction(transaction as any);
                        } else {
                            // Legacy logic (should not be hit if we use ALTs which returned Versioned?)
                            // But if createChunkTxn returned legacy, we convert.
                            console.log("Legacy Transaction returned. Converting to Versioned Transaction (v0)...");
                            const legacyTx = transaction as any; // Type assertion

                            const COMPUTE_BUDGET_ID = 'ComputeBudget111111111111111111111111111111';
                            const filteredInstructions = legacyTx.instructions.filter((ix: any) =>
                                ix.programId.toString() !== COMPUTE_BUDGET_ID
                            );

                            const latestBlockhash = await connection.getLatestBlockhash();
                            const startMsg = new TransactionMessage({
                                payerKey: payer,
                                recentBlockhash: latestBlockhash.blockhash,
                                instructions: filteredInstructions,
                            }).compileToV0Message([]);

                            const v0Tx = new VersionedTransaction(startMsg);
                            txHash = await paymaster.signAndSendVersionedTransaction(v0Tx as any);
                        }
                        break; // Success
                    } catch (e: any) {
                        console.warn(`[Paymaster] Attempt ${i + 1} failed:`, e);
                        if (e.logs) console.warn("[Paymaster] Simulation Logs:", e.logs);
                        if (e.message && e.message.includes("0x2")) {
                            console.warn("[Paymaster] 0x2 Error detected. Likely RPC Lag. Retrying...");
                        }

                        if (i === MAX_RETRIES - 1) throw new Error(`[Paymaster] All retry attempts failed ${e.message}`);

                        const delay = 2000 + (i * 1000);
                        console.log(`[Paymaster] Retrying in ${delay}ms...`);
                        await new Promise(r => setTimeout(r, delay));
                    }
                }

                console.log("Chunk Creation Tx Hash:", txHash);
                await connection.confirmTransaction(txHash, 'confirmed');
            } else {
                console.log("Skipping Chunk Creation as it already exists.");
            }

            // 9. Execute the Chunk
            // Now that the chunk is created and authorized, we need to execute it.
            // Execution does NOT require a passkey signature, just a payer (Paymaster).
            console.log("Executing Chunk...");

            // Execute Chunk Transaction
            const executeTx = await lazorkitClient.executeChunkTxn({
                payer,
                smartWallet,
                cpiInstructions: instructions,
                cpiSigners: []
            });

            let executeTxHash: string;
            if ('version' in executeTx) {
                executeTxHash = await paymaster.signAndSendVersionedTransaction(executeTx as any);
            } else {
                executeTxHash = await paymaster.signAndSend(executeTx as any);
            }

            console.log("Chunk Execution Tx Hash:", executeTxHash);

            await connection.confirmTransaction(executeTxHash, 'confirmed');
            console.log("Chunk Execution Confirmed!");

            return executeTxHash;

        } catch (error) {
            console.error("Custom Signer Error:", error);
            throw error;
        } finally {
            setIsSigning(false);
        }
    };

    return {
        signAndSendTransaction,
        isSigning
    };
}
