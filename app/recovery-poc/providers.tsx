'use client';

import { PrivyProvider } from '@privy-io/react-auth';
import { ReactNode } from 'react';

// App ID is public — safe here. App Secret + the authorization key stay
// server-side (Phase 2), never in the client bundle.
const PRIVY_APP_ID =
    process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? 'cms4dimc0024v0ck7bsnhu2w3';

// Scoped to the /recovery-poc route only — nests inside the app's Lazorkit
// provider without touching it.
export function RecoveryProviders({ children }: { children: ReactNode }) {
    return (
        <PrivyProvider
            appId={PRIVY_APP_ID}
            config={{
                // Only Google — the SSO we're verifying.
                loginMethods: ['google'],
                // Mint an embedded EOA for every user (the guardian). 'all-users'
                // is required so we can later delegate it to the backend.
                embeddedWallets: {
                    ethereum: { createOnLogin: 'all-users' },
                },
            }}
        >
            {children}
        </PrivyProvider>
    );
}
