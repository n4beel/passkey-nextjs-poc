/**
 * SVM (Solana) Wallet Generation using Lazorkit
 * 
 * Note: Lazorkit provides a React hook (`useWallet`) that handles
 * passkey registration/login and wallet creation automatically.
 * This is a simpler client-side only approach.
 */

export interface SVMWalletResult {
    address: string;
    network: string;
}

/**
 * For SVM wallet creation, use the Lazorkit React hook directly in components:
 * 
 * ```typescript
 * import { useWallet } from '@lazorkit/wallet';
 * 
 * function MyComponent() {
 *   const { connect, wallet, isConnected } = useWallet();
 *   
 *   const handleCreateWallet = async () => {
 *     await connect(); // Triggers passkey flow + generates Solana address
 *     console.log('Wallet address:', wallet?.smartWallet);
 *   };
 *   
 *   return <button onClick={handleCreateWallet}>Create Wallet</button>;
 * }
 * ```
 * 
 * The wallet.smartWallet property contains the Solana public key (base58 format).
 */

/**
 * Helper to extract SVM wallet info from Lazorkit hook
 * Call this after successful connect() from useWallet()
 */
export function getSVMWalletInfo(wallet: any): SVMWalletResult | null {
    if (!wallet || !wallet.smartWallet) {
        return null;
    }

    return {
        address: wallet.smartWallet,
        network: 'devnet', // Lazorkit cookbook uses devnet
    };
}
