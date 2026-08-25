/**
 * Chain-aware block-explorer links. Money moved to BSC, so a hardcoded
 * plasmascan/blockscan link points at the wrong chain (bug #2). Always build the
 * tx link from the chain the transaction actually settled on.
 */
const EXPLORER_TX: Record<number, string> = {
    1: 'https://etherscan.io/tx/',
    10: 'https://optimistic.etherscan.io/tx/',
    56: 'https://bscscan.com/tx/', // BNB — money wallet (USDT) lives here now
    137: 'https://polygonscan.com/tx/',
    8453: 'https://basescan.org/tx/',
    42161: 'https://arbiscan.io/tx/',
    9745: 'https://plasmascan.to/tx/',
    9746: 'https://testnet.plasmascan.to/tx/',
    11155111: 'https://sepolia.etherscan.io/tx/',
};

/** Explorer tx URL for a chain. Falls back to BscScan (money's home chain). */
export function getExplorerTxUrl(chainId: number | undefined, hash: string): string {
    const base = (chainId != null && EXPLORER_TX[chainId]) || EXPLORER_TX[56];
    return base + hash;
}
