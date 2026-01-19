import { toWebAuthnKey, WebAuthnMode } from "@zerodev/passkey-validator"
import { toPasskeyValidator, PasskeyValidatorContractVersion } from "@zerodev/passkey-validator"
import { createKernelAccount } from "@zerodev/sdk"
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants"
import { createPublicClient, http } from "viem"
import { sepolia } from "viem/chains"

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3001/api/v1'

export interface EVMWalletResult {
    address: string;
    chainId: number;
    chainName: string;
}

/**
 * Creates an EVM smart wallet using ZeroDev + Passkey
 * Uses our backend as the passkey server (no external ZeroDev infrastructure needed)
 * 
 * @param mode - 'register' for new passkeys, 'login' for existing ones
 * @param passkeyName - Name for the passkey (only used in registration)
 * @returns Smart wallet address (0x...)
 */
export async function createEVMWallet(
    mode: 'register' | 'login',
    passkeyName?: string
): Promise<EVMWalletResult> {

    // 1. Fetch chain configuration from backend
    const chainRes = await fetch(`${API_BASE_URL}/chains`)
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

    // 3. Use our backend as the passkey server
    const webAuthnKey = await toWebAuthnKey({
        passkeyName: passkeyName || "HandlePay Wallet",
        passkeyServerUrl: `${API_BASE_URL}/auth/passkey`,
        mode: mode === 'register' ? WebAuthnMode.Register : WebAuthnMode.Login,
    })

    // 4. Create passkey validator
    const entryPoint = getEntryPoint("0.7")
    const passkeyValidator = await toPasskeyValidator(publicClient, {
        webAuthnKey,
        entryPoint,
        kernelVersion: KERNEL_V3_1,
        validatorContractVersion: PasskeyValidatorContractVersion.V0_0_2
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
