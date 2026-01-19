'use client';

import { LazorkitProvider } from '@lazorkit/wallet';
import { ReactNode } from 'react';

const RPC_URL = "https://api.devnet.solana.com";
const PORTAL_URL = "https://portal.lazor.sh";
const PAYMASTER_CONFIG = {
    paymasterUrl: "https://kora.devnet.lazorkit.com"
};

export function Providers({ children }: { children: ReactNode }) {
    return (
        <LazorkitProvider
            rpcUrl={RPC_URL}
            portalUrl={PORTAL_URL}
            paymasterConfig={PAYMASTER_CONFIG}
        >
            {children}
        </LazorkitProvider>
    );
}
