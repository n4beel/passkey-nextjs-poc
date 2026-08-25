# Social recovery, end to end

This runs the full recovery loop on the real backend and the POC frontend: a user
is created at signup with a Google-backed guardian baked into their smart account,
and later that guardian alone rotates a lost passkey to a new one. The account
address never changes, so funds stay put. Recovery is on Rhinestone SDK 2.1.0,
which coexists with the existing beta.39 flows via the `@rhinestone/sdk-v2` alias.

## How it fits together

At signup the client does a Google sign-in (Privy), which mints an embedded EOA.
That EOA's address is the guardian. It goes to the backend along with the passkey
registration, and the backend derives the spot and money wallets on 2.1.0 with the
guardian baked into the address. Wallets created this way are marked
`recoveryEnabled` and `sdkVersion: '2.1.0'`; everyone without a guardian stays on
the legacy beta.39 path (mixed fleet).

To recover, the client looks the account up by username, rebuilds it from the
stored (public) owner passkey plus the guardian, and — because the guardian's key
lives client-side in Privy — signs the rotation there. The backend never holds the
guardian key. Once the rotation lands on-chain, the client asks the backend to swap
the login credential, authorized by a guardian signature over a one-time challenge.

The guardian-rotation userOps (and the one-time deploy) are gas-sponsored through
Pimlico. The Pimlico key is injected server-side by `/api/pimlico/[chainId]`, so it
never ships to the browser — same pattern as the Rhinestone orchestrator proxy.

## What you need before running

Backend (`handle-pay-backend`, branch `feat/recovery-integration`): no new env. It
reuses `RHINESTONE_API_KEY` and `RP_ID`. Run `npm ci --legacy-peer-deps` once — the
`@rhinestone/sdk-v2` (2.1.0) alias is now in package.json alongside beta.39.

POC (`passkey-nextjs-poc`, branch `feat/recovery-2.1.0`): add one server-side var to
`.env.local`:

    PIMLICO_API_KEY=<your pimlico key>

Pimlico dashboard: create a sponsorship policy that covers Base (chain 8453) for
these accounts, otherwise the paymaster will decline and the userOps revert. If you
would rather not sponsor, the alternative is to fund each account with a little Base
ETH and drop the paymaster — but the flow here assumes sponsorship.

## Running it

Bring up the stack the usual way (mongo + redis, backend on 3001, POC on 3002 or
3000). Then:

1. Phase 1 (`/phase1/onboarding`): pick a usecase, choose a username, reserve it.
   Copy the reservation token.
2. Phase 2 (`/phase2/passkey-test`): paste the token. Click "Sign in with Google
   (set recovery guardian)" and complete the Google login — the guardian address
   shows once the embedded wallet is ready. Then "Create Passkey". The backend
   creates the spot + money wallets with the guardian baked in and returns them.
3. Recovery (`/recovery-poc`): sign in with the same Google account. Enter the
   username and look it up — it confirms the guardian matches and shows the wallet
   addresses. Reconstruct spot (or money); the page checks the address it rebuilds
   equals the backend's (this is the anti-drift check). If the account is
   undeployed, click Deploy once — that signs with the owner passkey and simulates
   first use. Then "Recover to a new passkey": it mints a new passkey, the guardian
   rotates ownership to it, and the backend swaps the login credential.

## What proves it worked

The reconstruct step passing means the client and backend derive the identical
address from the same inputs — no version/guardian/salt drift. After recovery, the
"Owners AFTER" line reflects the on-chain owner set with the new passkey in place,
and the backend has repointed the login credential. Same address throughout; only
the owning key changed.

## Known rough edges

The POC mints passkeys with viem's WebAuthn helper, whose public-key format differs
from the `@simplewebauthn` COSE the login path stores. The recovery `complete`
records the new passkey's X/Y coordinates (and can take a COSE `newPublicKey` when
the client has one) so on-chain ownership and our records agree, but signing back in
with the rotated passkey through the existing login endpoint needs the COSE form —
in the real app the client produces genuine WebAuthn credentials, so this lines up
there. The proof this exercises is the on-chain guardian rotation plus the
guardian-authorized backend swap.
