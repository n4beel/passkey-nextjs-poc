import { toPasskeyValidator, PasskeyValidatorContractVersion } from "@zerodev/passkey-validator"
import { createKernelAccount } from "@zerodev/sdk"
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants"
import { createPublicClient, http, keccak256, toHex } from "viem"
import { sepolia } from "viem/chains"
import type { WebAuthnKey } from "@zerodev/webauthn-key"

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1'

export interface EVMWalletResult {
    address: string;
    chainId: number;
    chainName: string;
}

/**
 * Creates an EVM smart wallet using ZeroDev + existing Passkey
 * Uses decoded public key coordinates from our backend (no toWebAuthnKey() call needed)
 * 
 * @param publicKey - Public key object with x, y coordinates from login response
 * @param credentialId - Credential ID from login response
 * @returns Smart wallet address (0x...)
 */
export async function createEVMWallet(
    publicKey: { x: string; y: string; credentialId: string },
): Promise<EVMWalletResult> {

    // 1. Fetch chain configuration from backend
    const chainRes = await fetch(`${API_BASE_URL}/chains`, {
        headers: {
            'ngrok-skip-browser-warning': 'true',
        }
    })
    if (!chainRes.ok) {
        throw new Error(`Failed to fetch chain configs: ${chainRes.statusText}`)
    }

    const chains = await chainRes.json()
    const evmChain = chains.find((c: any) => c.type === 'evm' && c.isPrimary)

    if (!evmChain) {
        throw new Error('No primary EVM chain configuration found')
    }

    // 2. Create public client
    const publicClient = createPublicClient({
        transport: http(evmChain.evm.rpcUrl),
        chain: sepolia, // TODO: Make dynamic based on chainId
    })


    // ... existing code ...

    // 3. Manually construct WebAuthnKey from decoded coordinates
    // Skip toWebAuthnKey() since we already have the key from our backend
    const webAuthnKey: WebAuthnKey = {
        pubX: BigInt(publicKey.x),
        pubY: BigInt(publicKey.y),
        authenticatorId: publicKey.credentialId,
        // Must be a bytes32 hash of the credential ID
        authenticatorIdHash: keccak256(toHex(publicKey.credentialId)),
        rpID: evmChain.evm.rpId || 'handlepay.io', // Relying Party ID
    }

    // 4. Create passkey validator
    const entryPoint = getEntryPoint("0.7")
    const passkeyValidator = await toPasskeyValidator(publicClient, {
        webAuthnKey,
        entryPoint,
        kernelVersion: KERNEL_V3_1,
        validatorContractVersion: PasskeyValidatorContractVersion.V0_0_3_PATCHED
    })

    // 5. Create smart account
    const account = await createKernelAccount(publicClient, {
        plugins: { sudo: passkeyValidator },
        entryPoint,
        kernelVersion: KERNEL_V3_1,
    })

    return {
        address: account.address,
        chainId: evmChain.evm.chainId,
        chainName: evmChain.evm.name,
    }
}
