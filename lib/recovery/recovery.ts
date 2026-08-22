/**
 * Recovery lib — isolated on SDK 2.1.0 via the `@rhinestone/sdk-v2` alias, so it
 * coexists with the POC's beta.39 flows without changing any existing addresses.
 *
 * Model B: an account is created (at signup, by the backend) with a passkey owner
 * AND a Google-backed guardian; if the passkey is lost, the guardian alone rotates
 * the account to a new passkey — same address, new key. Recovery targets the
 * WebAuthn validator.
 *
 * Gas: bundler + paymaster are pointed at the server-side Pimlico proxy
 * (/api/pimlico/[chainId]), so deploy + the guardian rotation userOps are
 * sponsored — no manual funding, and the Pimlico key never ships to the client.
 */
import {
  createWebAuthnCredential,
  toWebAuthnAccount,
  type P256Credential,
  type WebAuthnAccount,
} from 'viem/account-abstraction';
import {
  base,
  arbitrum,
  optimism,
  polygon,
  bsc,
} from 'viem/chains';
import type { Account, Chain, Hex } from 'viem';
import { RhinestoneSDK } from '@rhinestone/sdk-v2';
import { recoverPasskeyOwnership } from '@rhinestone/sdk-v2/actions/recovery';

/**
 * Chains we can rotate on — those with a Pimlico bundler/paymaster (proxied) and
 * a viem chain definition. A wallet's chainIds come from the backend lookup; any
 * id not in here is skipped (e.g. Plasma has no Pimlico support yet).
 */
export const RECOVERY_CHAINS: Record<number, Chain> = {
  [base.id]: base,
  [arbitrum.id]: arbitrum,
  [optimism.id]: optimism,
  [polygon.id]: polygon,
  [bsc.id]: bsc,
};

export function chainById(id: number): Chain | undefined {
  return RECOVERY_CHAINS[id];
}

function rpcFor(chain: Chain): string {
  return (
    chain.rpcUrls?.default?.http?.[0] ?? 'https://mainnet.base.org'
  );
}

// The SDK's bundler/paymaster transport grabs `globalThis.fetch` and calls it
// UNBOUND. Node tolerates that, but browsers throw
// "TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation" when
// fetch runs without `this === window` — so the paymaster request never leaves
// the page. Pre-bind fetch to window once, on the client, to fix it.
if (
  typeof window !== 'undefined' &&
  typeof window.fetch === 'function'
) {
  globalThis.fetch = window.fetch.bind(window);
}

export const RECOVERY_CHAIN: Chain = base;

/** Money wallet salt — must match the backend (rhinestone.constants.ts). */
export const MONEY_WALLET_SALT =
  '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex;

function appOrigin(): string {
  return typeof window !== 'undefined'
    ? window.location.origin
    : process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

/** Rhinestone orchestrator proxy — real API key injected server-side. */
function rhinestoneEndpoint(): string {
  return `${appOrigin()}/api/orchestrator`;
}

/** Pimlico bundler+paymaster proxy for a chain — Pimlico key injected server-side. */
function pimlicoUrl(chainId: number): string {
  return `${appOrigin()}/api/pimlico/${chainId}`;
}

function sdk(chain: Chain = RECOVERY_CHAIN): RhinestoneSDK {
  const id = chain.id;
  const proxy = pimlicoUrl(id);
  return new RhinestoneSDK({
    apiKey: 'proxy',
    endpointUrl: rhinestoneEndpoint(),
    // Reads (isDeployed / getOwners) go through this chain's public RPC.
    provider: { type: 'custom', urls: { [id]: rpcFor(chain) } },
    // type:'custom' with a STRING url → our per-chain Pimlico proxy (sponsors
    // userOps; key stays server-side). One SDK instance per chain.
    bundler: { type: 'custom', url: proxy },
    paymaster: { type: 'custom', url: proxy },
  } as any);
}

/** Mint a real passkey via WebAuthn (navigator.credentials.create under the hood). */
export async function mintPasskey(name: string): Promise<P256Credential> {
  return createWebAuthnCredential({ name });
}

export function passkeyAccount(cred: P256Credential): WebAuthnAccount {
  return toWebAuthnAccount({ credential: cred });
}

/**
 * Rebuild a WebAuthn owner account from public P256 coordinates (as returned by
 * the backend's GET /recovery/lookup). Used to reconstruct the account a recovery
 * targets — the private key is gone (that's the whole point); only the guardian
 * signs. `credentialId` and coordinates come from the stored owner passkey. The
 * derived Rhinestone address depends only on X/Y, so any id works here.
 */
export function ownerFromCoords(params: {
  credentialId: string;
  x: string;
  y: string;
}): WebAuthnAccount {
  const xHex = params.x.replace(/^0x/, '').padStart(64, '0');
  const yHex = params.y.replace(/^0x/, '').padStart(64, '0');
  const publicKey = ('0x04' + xHex + yHex) as Hex;
  return toWebAuthnAccount({
    credential: { id: params.credentialId, publicKey },
  });
}

/**
 * Parse the P256 public key coordinates (X, Y) from a viem credential.
 * publicKey is uncompressed `0x04 || X(32) || Y(32)` (or the 64-byte X||Y form).
 */
export function pubXY(cred: P256Credential): { x: bigint; y: bigint } {
  let hex = (cred.publicKey as string).replace(/^0x/, '');
  if (hex.length === 130 && hex.startsWith('04')) hex = hex.slice(2);
  if (hex.length !== 128) {
    throw new Error(
      `unexpected passkey publicKey length: ${hex.length} hex chars`,
    );
  }
  return {
    x: BigInt('0x' + hex.slice(0, 64)),
    y: BigInt('0x' + hex.slice(64)),
  };
}

/** Hex X/Y (padded, no 0x) for sending to the backend's /recovery/complete. */
export function xyHex(cred: P256Credential): { x: string; y: string } {
  const { x, y } = pubXY(cred);
  return {
    x: x.toString(16).padStart(64, '0'),
    y: y.toString(16).padStart(64, '0'),
  };
}

/**
 * Reconstruct the recoverable account object: passkey owner + Google guardian,
 * sessions on — MUST match the backend's derivation exactly (same owner X/Y, same
 * guardian address, same salt) or it targets the wrong address. Nothing on-chain
 * happens here; this yields the counterfactual address + config the recovery needs.
 * Pass `salt` = MONEY_WALLET_SALT for the money wallet; omit for spot.
 */
export async function createRecoverableAccount(
  ownerPasskey: WebAuthnAccount,
  guardian: Account,
  salt?: Hex,
  chain: Chain = RECOVERY_CHAIN,
) {
  const account: Record<string, unknown> = { type: 'nexus' };
  if (salt) account.salt = salt;
  return sdk(chain).createAccount({
    account,
    owners: { type: 'passkey', accounts: [ownerPasskey] },
    experimental_sessions: { enabled: true },
    recovery: { guardians: [guardian] },
  } as any);
}

export interface RecoverResult {
  callCount: number;
  statuses: string[];
  receipts: unknown[];
  ownersAfter: { accounts: string[]; threshold: number } | null;
}

/**
 * Guardian rotates ownership: OLD passkey (by its public X/Y) -> NEW passkey.
 * Each recovery call is sent as its own guardian-signed userOp (the recovery
 * validator authorizes one execute per userOp — batching reverts). Gas is
 * sponsored via the Pimlico paymaster proxy, so the account needs no ETH; it must
 * be deployed first.
 */
export async function recoverToNewPasskey(params: {
  account: any;
  oldPubKeyX: bigint;
  oldPubKeyY: bigint;
  newPasskey: WebAuthnAccount;
  guardian: Account;
  chain?: Chain;
  onStep?: (i: number, total: number) => void;
}): Promise<RecoverResult> {
  const chain = params.chain ?? RECOVERY_CHAIN;

  const calls = await recoverPasskeyOwnership({
    accountAddress: params.account.getAddress(),
    chain,
    config: params.account.config,
    currentCredentials: [
      { pubKeyX: params.oldPubKeyX, pubKeyY: params.oldPubKeyY },
    ],
    newOwners: { type: 'passkey', accounts: [params.newPasskey] },
  } as any);

  const statuses: string[] = [];
  const receipts: unknown[] = [];
  for (let i = 0; i < calls.length; i++) {
    params.onStep?.(i, calls.length);
    const res = await params.account.sendUserOperation({
      chain,
      calls: [calls[i]],
      signers: { type: 'guardians', guardians: [params.guardian] },
    });
    const rc = await params.account.waitForExecution(res);
    receipts.push(rc);
    // ERC-4337 receipts carry `success` (bool); fall back to status/JSON.
    statuses.push(
      String(
        (rc as any)?.success ??
          (rc as any)?.status ??
          JSON.stringify(rc).slice(0, 120),
      ),
    );
  }

  const ownersAfter = await params.account
    .getOwners(chain)
    .catch(() => null);
  return { callCount: calls.length, statuses, receipts, ownersAfter };
}
