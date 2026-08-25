import { ReactNode } from 'react';
import { RecoveryProviders } from './providers';

// Wraps ONLY /recovery-poc/* in the Privy provider — the rest of the app is
// untouched.
export default function RecoveryLayout({ children }: { children: ReactNode }) {
    return <RecoveryProviders>{children}</RecoveryProviders>;
}
