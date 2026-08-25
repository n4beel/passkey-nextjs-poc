'use client';

import { useState } from 'react';
import { usePrivy, useWallets, toViemAccount } from '@privy-io/react-auth';
import type { Account, Chain } from 'viem';
import {
  mintPasskey,
  passkeyAccount,
  ownerFromCoords,
  createRecoverableAccount,
  createPlainAccount,
  reconstructForRecovery,
  enableRecovery,
  recoverToNewPasskey,
  pubXY,
  xyHex,
  chainById,
  MONEY_WALLET_SALT,
} from '@/lib/recovery/recovery';
import { base, bsc } from 'viem/chains';
import { signedFetch } from '@/lib/api/signedFetch';

type WalletType = 'spot' | 'money';

interface WalletInfo {
  address: string;
  salt?: string;
  chainIds: number[];
  deployedChains: number[];
  // false = guardian retrofitted at runtime (plain address) → reconstruct pinned.
  recoveryBakedIn?: boolean;
}
interface LookupResult {
  username: string;
  guardian: string;
  sdkVersion?: string;
  credential: { credentialId?: string; pubKeyX?: string; pubKeyY?: string };
  wallets: {
    spot: WalletInfo | null;
    money: (WalletInfo & { salt: string }) | null;
  };
}
// One row per (wallet × chain) — the unit of recovery.
interface Target {
  key: string;
  walletType: WalletType;
  address: string;
  salt?: string;
  chainId: number;
  chainName: string;
  account?: any;
  deployed?: boolean;
  addressOk?: boolean;
  recovered?: boolean;
  bakedIn?: boolean;
}

export default function RecoveryPocPage() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { wallets } = useWallets();

  const [username, setUsername] = useState('');
  const [accounts, setAccounts] = useState<Array<{ username: string; wallets: { money: string | null; spot: string | null } }>>([]);
  const [lookup, setLookup] = useState<LookupResult | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [testChain, setTestChain] = useState<Chain>(base); // self-test target chain

  if (!ready) return <p style={{ fontFamily: 'system-ui', margin: 40 }}>Loading Privy…</p>;

  const embedded = wallets.find((w) => w.walletClientType === 'privy');
  const email = user?.google?.email ?? user?.email?.address ?? user?.id;
  const say = (m: string) => setLog((l) => [...l, m]);
  const dump = (e: any) => console.error('[recovery] FULL ERROR:', e);

  async function guardian(): Promise<Account> {
    if (!embedded) throw new Error('Sign in with Google first (guardian).');
    return (await toViemAccount({ wallet: embedded })) as Account;
  }

  /**
   * Self-contained on-chain test — NO backend, no seeded user. Mints a throwaway
   * owner passkey + uses the signed-in Google guardian, creates a recoverable
   * account, deploys it, mints a NEW passkey, and has the guardian rotate to it.
   * This is the definitive answer to "does passkey recovery actually work on-chain
   * for our account type" — everything else (backend lookup, credential swap) is
   * plumbing around this one step.
   */
  const selfTest = async () => {
    setErr(null); setBusy('selftest'); setLog([]); setDone(false);
    try {
      const chain = testChain;
      const g = await guardian();
      say(`Guardian (Google/Privy): ${g.address}`);

      say('1/5 Minting OWNER passkey (Touch ID)…');
      const ownerCred = await mintPasskey('HandlePay self-test — owner');
      const owner = passkeyAccount(ownerCred);

      say('2/5 Creating recoverable account (passkey owner + guardian)…');
      const account = await createRecoverableAccount(owner, g, undefined, chain);
      const addr = account.getAddress();
      say(`   account: ${addr}`);

      let deployed = await account.isDeployed(chain).catch(() => false);
      if (!deployed) {
        say('3/5 Deploying (owner passkey — Touch ID; Pimlico-sponsored)…');
        await account.deploy(chain);
        for (let i = 0; i < 20; i++) { if (await account.isDeployed(chain).catch(() => false)) break; await new Promise((r) => setTimeout(r, 3000)); }
        deployed = await account.isDeployed(chain).catch(() => false);
      }
      say(`   deployed: ${deployed}`);
      if (!deployed) throw new Error('deploy did not confirm on-chain');

      say('4/5 Minting NEW passkey (Touch ID) — the recovered key…');
      const newCred = await mintPasskey('HandlePay self-test — new key');
      const newOwner = passkeyAccount(newCred);
      const { x: oldX, y: oldY } = pubXY(ownerCred);

      say('5/5 GUARDIAN rotates owner → new passkey (guardian signs, sponsored)…');
      const res = await recoverToNewPasskey({
        account, oldPubKeyX: oldX, oldPubKeyY: oldY,
        newPasskey: newOwner, guardian: g, chain,
        onStep: (i, total) => say(`   userOp ${i + 1}/${total}…`),
      });
      // Passkey owners live in the WebAuthn validator, which stores credentials by
      // HASHED id — they can't be read back on-chain, so getOwners (which reads the
      // ECDSA OwnableValidator) is EMPTY for a passkey account. So we judge success
      // by whether the rotation userOps actually landed on-chain, not by getOwners.
      say(`   rotation userOp results: ${JSON.stringify(res.statuses)}`);
      say(`   receipts: ${JSON.stringify(res.receipts).slice(0, 500)}`);
      say(`   getOwners (ECDSA validator — empty is EXPECTED for a passkey acct): ${JSON.stringify(res.ownersAfter)}`);

      const succeeded =
        Array.isArray(res.statuses) &&
        res.statuses.length > 0 &&
        res.statuses.every((s: string) => /^true$|success|complet/i.test(String(s)));
      if (succeeded) {
        setDone(true);
        say(`✅ SELF-TEST PASSED — all ${res.statuses.length} guardian rotation userOp(s) succeeded on-chain, NO AA24. The account now trusts the new passkey (same address). getOwners is empty only because passkey owners aren't readable on-chain.`);
      } else {
        say('⚠️ Rotation ran but the userOps didn\'t all report success — inspect the receipts JSON above for success:false or a revert reason.');
      }
    } catch (e: any) { dump(e); setErr(e?.message ?? String(e)); }
    finally { setBusy(null); }
  };

  /**
   * ENABLE-FROM-SETTINGS self-test. Unlike selfTest (which bakes the guardian in at
   * creation), this creates an account with NO recovery, deploys it, then retrofits
   * recovery via the SDK's enable() (installs the social-recovery module, owner
   * passkey signs), and finally has the guardian rotate to a new passkey. This is
   * the flow the backend enable/prepare was TRYING to do — but correctly, via the
   * social-recovery module, not OwnableValidator.addOwner.
   */
  const enableTest = async () => {
    setErr(null); setBusy('enabletest'); setLog([]); setDone(false);
    try {
      const chain = testChain;
      const g = await guardian();
      say(`Guardian (Google/Privy): ${g.address}`);

      say('1/6 Minting OWNER passkey (Touch ID)…');
      const ownerCred = await mintPasskey('HandlePay enable-test — owner');
      const owner = passkeyAccount(ownerCred);

      say('2/6 Creating PLAIN account (no recovery baked in)…');
      const account = await createPlainAccount(owner, undefined, chain);
      say(`   account: ${account.getAddress()}`);

      let deployed = await account.isDeployed(chain).catch(() => false);
      if (!deployed) {
        say('3/6 Deploying (owner passkey — Touch ID; sponsored)…');
        await account.deploy(chain);
        for (let i = 0; i < 20; i++) { if (await account.isDeployed(chain).catch(() => false)) break; await new Promise((r) => setTimeout(r, 3000)); }
        deployed = await account.isDeployed(chain).catch(() => false);
      }
      say(`   deployed: ${deployed}`);
      if (!deployed) throw new Error('deploy did not confirm on-chain');

      say('4/6 ENABLE recovery — install social-recovery module + guardian (owner passkey signs, sponsored)…');
      const en = await enableRecovery({ account, guardian: g, chain });
      say(`   enable userOp: ${en.status}`);

      say('5/6 Minting NEW passkey (Touch ID) — the recovered key…');
      const newCred = await mintPasskey('HandlePay enable-test — new key');
      const newOwner = passkeyAccount(newCred);
      const { x: oldX, y: oldY } = pubXY(ownerCred);

      say('6/6 GUARDIAN rotates owner → new passkey (guardian signs, sponsored)…');
      const res = await recoverToNewPasskey({
        account, oldPubKeyX: oldX, oldPubKeyY: oldY,
        newPasskey: newOwner, guardian: g, chain,
        onStep: (i, total) => say(`   userOp ${i + 1}/${total}…`),
      });
      say(`   rotation results: ${JSON.stringify(res.statuses)}`);

      const ok = Array.isArray(res.statuses) && res.statuses.length > 0 &&
        res.statuses.every((s: string) => /^true$|success|complet/i.test(String(s)));
      if (ok) { setDone(true); say(`✅ ENABLE-TEST PASSED — recovery retrofitted to an account that had none, then rotated to the new passkey. This is enable-from-settings working end-to-end.`); }
      else { say('⚠️ Enable ran but rotation didn\'t all report success — inspect the receipts. If enable() itself reverted, the social-recovery module install on this account type may need a different call/module address for BSC — report the error.'); }
    } catch (e: any) { dump(e); setErr(e?.message ?? String(e)); }
    finally { setBusy(null); }
  };

  /**
   * BACKEND-INTEGRATED enable-from-settings ("backup") for BOTH wallets. For each
   * of money + spot: /recovery/enable/prepare → rebuild the account the way the
   * backend derived it (money salt / spot none) → deploy ONLY if not already
   * deployed → install the social-recovery module (owner passkey signs, sponsored)
   * → /recovery/enable/complete (records recoveryEnabled + guardian +
   * recoveryBakedIn=false). Idempotent: an already-enabled wallet is skipped (its
   * enable/prepare 400s), and a deployed account is never re-deployed. Needs: logged
   * in on the dashboard (accessToken) + Google connected (guardian).
   */
  const enableFromSettings = async () => {
    setErr(null); setBusy('enablesettings'); setLog([]); setDone(false);
    try {
      const g = await guardian();
      say(`Guardian (Google/Privy): ${g.address}`);

      const cfgRes = await signedFetch('/wallet/config', {
        auth: true,
        headers: { 'ngrok-skip-browser-warning': 'true' },
      });
      if (!cfgRes.ok) throw new Error(`wallet/config ${cfgRes.status} — log in on the dashboard first (accessToken).`);
      const cfg = await cfgRes.json();
      const owner = ownerFromCoords({
        credentialId: cfg.credentialId, x: cfg.pubX, y: cfg.pubY,
        rpId: window.location.hostname,
      });

      for (const walletType of ['money', 'spot'] as const) {
        say(`\n── ${walletType.toUpperCase()} ──`);
        const prepRes = await signedFetch('/recovery/enable/prepare', {
          method: 'POST', auth: true,
          headers: { 'ngrok-skip-browser-warning': 'true' },
          json: { guardianAddress: g.address, walletType },
        });
        if (!prepRes.ok) {
          // Already enabled (or no wallet) → skip; don't re-enable / re-deploy.
          say(`  skip ${walletType}: ${prepRes.status} ${(await prepRes.text()).slice(0, 120)}`);
          continue;
        }
        const prep = await prepRes.json();
        const chain = chainById(prep.chainId) ?? testChain;
        const salt = walletType === 'money' ? MONEY_WALLET_SALT : undefined;

        // Rebuild the way the backend derived it (money salt / spot none) — same
        // address + factory, so it self-deploys if needed.
        const account = await createPlainAccount(owner, salt, chain);
        const derived = account.getAddress();
        if (derived.toLowerCase() !== prep.address.toLowerCase()) {
          throw new Error(`${walletType} address mismatch: derived ${derived}, backend ${prep.address}`);
        }
        say(`  ${walletType} ${prep.address} on chain ${prep.chainId}`);

        // Deploy ONLY if not already deployed — never deploy the same account twice.
        let deployed = await account.isDeployed(chain).catch(() => false);
        if (deployed) {
          say('  already deployed — skipping deploy');
        } else {
          say('  deploying (owner passkey — Touch ID; sponsored)…');
          await account.deploy(chain);
          for (let i = 0; i < 20; i++) {
            if (await account.isDeployed(chain).catch(() => false)) break;
            await new Promise((r) => setTimeout(r, 3000));
          }
          deployed = await account.isDeployed(chain).catch(() => false);
          if (!deployed) throw new Error(`${walletType} deploy did not confirm — retry.`);
        }

        say('  installing recovery module (owner passkey — Touch ID; sponsored)…');
        const en = await enableRecovery({ account, guardian: g, chain });
        const intentId = String(
          (en.receipt as any)?.userOpHash ??
            (en.receipt as any)?.receipt?.transactionHash ??
            (en.receipt as any)?.transactionHash ??
            'enabled',
        );

        const compRes = await signedFetch('/recovery/enable/complete', {
          method: 'POST', auth: true,
          headers: { 'ngrok-skip-browser-warning': 'true' },
          json: { prepareId: prep.prepareId, intentId },
        });
        if (!compRes.ok) throw new Error(`${walletType} enable/complete ${compRes.status}: ${await compRes.text()}`);
        say(`  ✅ ${walletType} recovery enabled`);
      }

      setDone(true);
      say('\n✅ Done — recovery enabled on both wallets (already-enabled ones skipped). Now Lookup + recover.');
    } catch (e: any) { dump(e); setErr(e?.message ?? String(e)); }
    finally { setBusy(null); }
  };

  // POC: connect Google → list the accounts this guardian can recover, so you pick
  // one instead of typing a username.
  const loadMyAccounts = async () => {
    setErr(null); setBusy('accounts'); setLog([]); setAccounts([]);
    try {
      const g = await guardian();
      const res = await signedFetch(`/recovery/accounts/${g.address}`, {
        headers: { 'ngrok-skip-browser-warning': 'true' },
      });
      if (!res.ok) throw new Error((await res.json()).message || 'Failed to load accounts');
      const list = await res.json();
      setAccounts(list);
      say(`Guardian ${g.address} → ${list.length} recoverable account(s).`);
      if (!list.length) say('  (none — this Google account isn’t a guardian on any wallet yet)');
    } catch (e: any) { dump(e); setErr(e?.message ?? String(e)); }
    finally { setBusy(null); }
  };

  const pickAccount = async (uname: string) => {
    setUsername(uname);
    await doLookup(uname);
  };

  const doLookup = async (unameArg?: string) => {
    const uname = (unameArg ?? username).trim();
    if (!uname) { setErr('Pick an account or type a username.'); return; }
    setErr(null); setBusy('lookup'); setLog([]); setTargets([]); setDone(false);
    try {
      const res = await signedFetch(`/recovery/lookup/${uname}`, {
        headers: { 'ngrok-skip-browser-warning': 'true' },
      });
      if (!res.ok) throw new Error((await res.json()).message || 'Lookup failed');
      const data: LookupResult = await res.json();
      setLookup(data);

      const g = await guardian();
      say(
        g.address.toLowerCase() === data.guardian.toLowerCase()
          ? `✅ Guardian matches (${data.guardian}).`
          : `⚠️ Signed-in guardian ${g.address} ≠ account guardian ${data.guardian}. Use the SAME Google account from signup.`,
      );

      // Build the wallet × chain matrix from the backend's chain lists.
      const t: Target[] = [];
      const add = (wt: WalletType, w: WalletInfo | null) => {
        if (!w) return;
        for (const id of w.chainIds) {
          const chain = chainById(id);
          if (!chain) { say(`↷ skipping ${wt} on chain ${id} (no Pimlico support)`); continue; }
          t.push({ key: `${wt}-${id}`, walletType: wt, address: w.address, salt: w.salt, chainId: id, chainName: chain.name, bakedIn: w.recoveryBakedIn !== false });
        }
      };
      add('spot', data.wallets.spot);
      add('money', data.wallets.money);
      setTargets(t);
      say(`${t.length} wallet×chain target(s): ${t.map((x) => `${x.walletType}@${x.chainName}`).join(', ') || '(none supported)'}`);
    } catch (e: any) { dump(e); setErr(e?.message ?? String(e)); }
    finally { setBusy(null); }
  };

  // Reconstruct all targets, or just `only` (one wallet×chain row) when passed.
  const reconstruct = async (only?: Target) => {
    setErr(null); setBusy(only ? 'reconstruct-' + only.key : 'reconstruct');
    try {
      if (!lookup) throw new Error('Look up first.');
      const c = lookup.credential;
      if (!c.credentialId || !c.pubKeyX || !c.pubKeyY) throw new Error('Lookup is missing the owner passkey coordinates.');
      const g = await guardian();
      const owner = ownerFromCoords({ credentialId: c.credentialId, x: c.pubKeyX, y: c.pubKeyY });

      const next = [...targets];
      const rows = only ? next.filter((t) => t.key === only.key) : next;
      for (const t of rows) {
        const chain = chainById(t.chainId)!;
        // Retrofit wallets (enable-from-settings) have a plain address + runtime
        // guardian module → reconstruct PINNED, not with the guardian baked in.
        const account = await reconstructForRecovery({
          owner, guardian: g,
          salt: (t.salt as `0x${string}`) || undefined,
          address: t.address,
          bakedIn: t.bakedIn !== false,
          chain,
        });
        t.account = account;
        t.addressOk = account.getAddress().toLowerCase() === t.address.toLowerCase();
        t.deployed = await account.isDeployed(chain).catch(() => false);
        say(`${t.walletType}@${t.chainName}: ${t.address} — ${t.bakedIn === false ? 'retrofit(pinned)' : 'baked-in'} match=${t.addressOk} deployed=${t.deployed}`);
        if (!t.addressOk) say(`  ⚠️ derivation mismatch for ${t.walletType}@${t.chainName}`);
      }
      setTargets(next);
    } catch (e: any) { dump(e); setErr(e?.message ?? String(e)); }
    finally { setBusy(null); }
  };

  // Per-row deploy (POC bootstrap only). Deploys exactly the chain you pick —
  // never a blast across candidate chains you aren't on. In production there is
  // no deploy step in recovery; you only rotate chains already deployed.
  const deployOne = async (t: Target) => {
    setErr(null); setBusy('deploy-' + t.key);
    try {
      if (!t.account) throw new Error('Reconstruct first.');
      const chain = chainById(t.chainId)!;
      // Never deploy the same account twice.
      if (await t.account.isDeployed(chain).catch(() => false)) {
        t.deployed = true; setTargets([...targets]);
        say(`  ${t.walletType}@${t.chainName} already deployed — skipping`);
        return;
      }
      say(`Deploying ${t.walletType}@${t.chainName} (owner passkey — Touch ID; sponsored)…`);
      await t.account.deploy(chain);
      for (let i = 0; i < 20; i++) { if (await t.account.isDeployed(chain).catch(() => false)) break; await new Promise((r) => setTimeout(r, 3000)); }
      t.deployed = await t.account.isDeployed(chain).catch(() => false);
      say(`  ${t.walletType}@${t.chainName} deployed=${t.deployed}`);
      setTargets([...targets]);
    } catch (e: any) { dump(e); setErr(e?.message ?? String(e)); }
    finally { setBusy(null); }
  };

  const recoverAll = async () => {
    setErr(null); setBusy('recover'); setDone(false);
    try {
      if (!lookup) throw new Error('Look up first.');
      const live = targets.filter((t) => t.deployed && t.account);
      if (!live.length) throw new Error('No deployed wallets to recover — run Deploy first.');
      const c = lookup.credential;
      const g = await guardian();

      // ONE new passkey becomes the owner on every wallet, every chain. Name it
      // "<username> (recovered)" so in the OS passkey picker the user recognizes
      // it as THEIR account AND can tell it apart from the old (now-dead) entry
      // if that one still lingers (e.g. via iCloud Keychain sync).
      say('Minting ONE new passkey (Touch ID) — becomes owner everywhere…');
      const newCred = await mintPasskey(`${lookup.username} (recovered)`);
      const newXY = xyHex(newCred);
      const newOwner = passkeyAccount(newCred);
      const oldX = BigInt('0x' + c.pubKeyX!.replace(/^0x/, ''));
      const oldY = BigInt('0x' + c.pubKeyY!.replace(/^0x/, ''));

      for (const t of live) {
        const chain = chainById(t.chainId)!;
        say(`Rotating ${t.walletType}@${t.chainName} → new passkey (guardian signs, sponsored)…`);
        const res = await recoverToNewPasskey({
          account: t.account, oldPubKeyX: oldX, oldPubKeyY: oldY,
          newPasskey: newOwner, guardian: g, chain,
          onStep: (i, total) => say(`  ${t.walletType}@${t.chainName} userOp ${i + 1}/${total}…`),
        });
        t.recovered = true;
        say(`  ✅ ${t.walletType}@${t.chainName} rotated. (getOwners=${JSON.stringify(res.ownersAfter)} reads the ECDSA validator — empty is NORMAL for a passkey account; the new passkey is in the WebAuthn validator. Confirm by logging in with the new key.)`);
        setTargets([...targets]);
      }

      // Single backend credential swap — updateMany covers all recovery wallets.
      say('Backend credential swap (guardian signs a one-time challenge)…');
      const anyAddr = live[0].address;
      const chRes = await signedFetch('/recovery/challenge', { method: 'POST', headers: { 'ngrok-skip-browser-warning': 'true' }, json: { accountAddress: anyAddr, newCredentialId: newCred.id, newPubKeyX: newXY.x, newPubKeyY: newXY.y } });
      if (!chRes.ok) throw new Error((await chRes.json()).message || 'challenge failed');
      const { message } = await chRes.json();
      const guardianSignature = await (g as any).signMessage({ message });
      const cmpRes = await signedFetch('/recovery/complete', { method: 'POST', headers: { 'ngrok-skip-browser-warning': 'true' }, json: { accountAddress: anyAddr, guardianSignature, newCredentialId: newCred.id, newPubKeyX: newXY.x, newPubKeyY: newXY.y } });
      if (!cmpRes.ok) throw new Error((await cmpRes.json()).message || 'complete failed');

      setDone(true);
      say(`✅ Recovery complete — ${live.length} wallet×chain rotated to one new passkey + backend updated.`);
    } catch (e: any) { dump(e); setErr(e?.message ?? String(e)); }
    finally { setBusy(null); }
  };

  /**
   * PROD-STYLE one-shot: recover BOTH wallets (money + spot) on BSC with a SINGLE
   * new passkey, no per-row steps. Reconstructs → deploys → rotates every BSC
   * wallet to one new passkey → one backend swap. This mirrors how prod recovery
   * runs (one passkey owns both wallets; no options shown to the user). Deploy
   * still uses the owner here because these are fresh test accounts; in prod
   * recovery only rotates already-deployed wallets.
   */
  const recoverBscOneShot = async () => {
    setErr(null); setBusy('recover-bsc'); setDone(false);
    try {
      if (!lookup) throw new Error('Look up first.');
      const c = lookup.credential;
      if (!c.credentialId || !c.pubKeyX || !c.pubKeyY) throw new Error('Lookup missing owner passkey coords.');
      const g = await guardian();
      const chain = bsc;
      const bscTargets = targets.filter((t) => t.chainId === bsc.id);
      if (!bscTargets.length) throw new Error('No BSC wallets in this account.');
      say(`BSC wallets: ${bscTargets.map((t) => t.walletType).join(' + ')}`);

      const owner = ownerFromCoords({ credentialId: c.credentialId, x: c.pubKeyX, y: c.pubKeyY });

      // 1) reconstruct + deploy each BSC wallet
      for (const t of bscTargets) {
        t.account = await reconstructForRecovery({
          owner, guardian: g,
          salt: (t.salt as `0x${string}`) || undefined,
          address: t.address,
          bakedIn: t.bakedIn !== false,
          chain,
        });
        const computed = t.account.getAddress();
        t.addressOk = computed.toLowerCase() === t.address.toLowerCase();
        say(`${t.walletType}@BSC: stored=${t.address} computed=${computed} ${t.bakedIn === false ? 'retrofit(pinned)' : 'baked-in'} match=${t.addressOk}`);
        if (!t.addressOk) { say(`  ⚠️ ${t.walletType}@BSC derivation mismatch — skipping (won't rotate)`); continue; }
        t.deployed = await t.account.isDeployed(chain).catch(() => false);
        if (!t.deployed) {
          say(`Deploying ${t.walletType}@BSC (owner Touch ID; sponsored)…`);
          await t.account.deploy(chain);
          for (let i = 0; i < 20; i++) { if (await t.account.isDeployed(chain).catch(() => false)) break; await new Promise((r) => setTimeout(r, 3000)); }
          t.deployed = await t.account.isDeployed(chain).catch(() => false);
        }
        say(`  ${t.walletType}@BSC: match=${t.addressOk} deployed=${t.deployed}`);
      }
      setTargets([...targets]);

      // 2) ONE new passkey → owner of both wallets
      say('Minting ONE new passkey (Touch ID) — owner of BOTH wallets…');
      const newCred = await mintPasskey(`${lookup.username} (recovered)`);
      const newXY = xyHex(newCred);
      const newOwner = passkeyAccount(newCred);
      const oldX = BigInt('0x' + c.pubKeyX.replace(/^0x/, ''));
      const oldY = BigInt('0x' + c.pubKeyY.replace(/^0x/, ''));

      // 3) rotate each deployed BSC wallet to the new passkey (guardian signs)
      for (const t of bscTargets) {
        if (!t.deployed) { say(`↷ ${t.walletType}@BSC not deployed — skipping`); continue; }
        say(`Rotating ${t.walletType}@BSC → new passkey (guardian signs, sponsored)…`);
        await recoverToNewPasskey({ account: t.account, oldPubKeyX: oldX, oldPubKeyY: oldY, newPasskey: newOwner, guardian: g, chain, onStep: (i, total) => say(`  ${t.walletType} userOp ${i + 1}/${total}…`) });
        t.recovered = true;
      }
      setTargets([...targets]);

      // 4) ONE backend swap — ONLY if we actually rotated something on-chain.
      // Otherwise we'd swap the DB credential with no on-chain change = desync.
      const rotated = bscTargets.filter((t) => t.recovered);
      if (!rotated.length) throw new Error('Nothing was rotated on-chain (all mismatched/undeployed) — skipping backend swap to avoid a desync. Use a FRESH, never-recovered account.');
      say('Backend credential swap (guardian signs a one-time challenge)…');
      const anyAddr = rotated[0].address;
      const chRes = await signedFetch('/recovery/challenge', { method: 'POST', headers: { 'ngrok-skip-browser-warning': 'true' }, json: { accountAddress: anyAddr, newCredentialId: newCred.id, newPubKeyX: newXY.x, newPubKeyY: newXY.y } });
      if (!chRes.ok) throw new Error((await chRes.json()).message || 'challenge failed');
      const { message } = await chRes.json();
      const guardianSignature = await (g as any).signMessage({ message });
      const cmpRes = await signedFetch('/recovery/complete', { method: 'POST', headers: { 'ngrok-skip-browser-warning': 'true' }, json: { accountAddress: anyAddr, guardianSignature, newCredentialId: newCred.id, newPubKeyX: newXY.x, newPubKeyY: newXY.y } });
      if (!cmpRes.ok) throw new Error((await cmpRes.json()).message || 'complete failed');

      setDone(true);
      say(`✅ Done — money + spot on BSC rotated to ONE new passkey "${lookup.username} (recovered)" + backend updated.`);
    } catch (e: any) { dump(e); setErr(e?.message ?? String(e)); }
    finally { setBusy(null); }
  };

  const box: React.CSSProperties = { background: '#f6f6f7', color: '#111', padding: 18, borderRadius: 10, marginTop: 16 };
  const btn: React.CSSProperties = { padding: '10px 16px', cursor: 'pointer', borderRadius: 8, border: '1px solid #ccc', background: '#fff', color: '#111', marginRight: 8 };
  const code: React.CSSProperties = { fontSize: 13, wordBreak: 'break-all', color: '#111' };
  const anyDeployed = targets.some((t) => t.deployed);

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 760, margin: '0 auto', minHeight: '100vh', lineHeight: 1.55, padding: '48px 16px', color: '#111', background: '#fff' }}>
      <h1 style={{ marginBottom: 4 }}>Social recovery — all wallets, all chains (2.1.0)</h1>
      <p style={{ color: '#555', marginTop: 0 }}>
        One flow: mint a single new passkey, and the Google guardian rotates every wallet (spot + money) on every
        chain it&apos;s deployed on — same addresses, new key. Gas sponsored via Pimlico. (Separate accounts/chains =
        separate sponsored userOps, but one click and no per-signature prompts.)
      </p>

      {!authenticated ? (
        <button onClick={login} style={{ ...btn, padding: '12px 20px', fontSize: 16 }}>Sign in with Google (guardian)</button>
      ) : (
        <>
          <div style={box}>✅ Guardian: <b>{email}</b><br /><code style={code}>{embedded?.address ?? '(creating embedded wallet…)'}</code></div>

          <div style={{ ...box, background: '#eef4ff', border: '1px solid #b9d0ff' }}>
            <b>0. Quick on-chain self-test (no backend needed)</b>
            <p style={{ marginTop: 6 }}>
              Mints a throwaway owner passkey, creates a recoverable account, deploys it, then has the
              Google guardian rotate it to a brand-new passkey — all on Base, gas sponsored. This proves
              the on-chain mechanism by itself. You&apos;ll get a few Touch ID prompts.
            </p>
            <div style={{ marginBottom: 10 }}>
              <span style={{ marginRight: 8, fontWeight: 600 }}>Chain:</span>
              {[base, bsc].map((c) => (
                <button key={c.id} onClick={() => setTestChain(c)} disabled={!!busy}
                  style={{ ...btn, marginRight: 6, background: testChain.id === c.id ? '#111' : '#fff', color: testChain.id === c.id ? '#fff' : '#111' }}>
                  {c.name}
                </button>
              ))}
            </div>
            <button onClick={selfTest} disabled={!!busy || !embedded} style={{ ...btn, background: done ? '#e7f8ec' : '#fff' }}>
              {busy === 'selftest' ? 'Running…' : done ? 'Passed ✅ (run again?)' : 'Run self-test'}
            </button>
            <p style={{ marginTop: 12 }}>
              <b>Enable-from-settings test:</b> creates an account with NO recovery, deploys it, then
              retrofits recovery via the SDK <code>enable()</code> (installs the social-recovery module,
              owner passkey signs) and rotates to a new passkey. This is what the backend
              <code>enable/prepare</code> should do — correctly.
            </p>
            <button onClick={enableTest} disabled={!!busy || !embedded} style={{ ...btn, background: '#fff' }}>
              {busy === 'enabletest' ? 'Running…' : 'Run enable-from-settings test'}
            </button>
            <p style={{ marginTop: 12 }}>
              <b>Backup from settings (REAL account):</b> runs the backend flow on your
              logged-in wallets — for <b>money AND spot</b>: <code>enable/prepare</code> →
              self-deploy if needed → install the module → <code>enable/complete</code>.
              Idempotent — already-enabled wallets are skipped, deployed ones aren't
              re-deployed. Needs: logged in on the dashboard + Google connected above.
            </p>
            <button onClick={enableFromSettings} disabled={!!busy || !embedded} style={{ ...btn, background: done ? '#e7f8ec' : '#fff' }}>
              {busy === 'enablesettings' ? 'Running…' : 'Enable recovery on both wallets'}
            </button>
          </div>

          <div style={box}>
            <b>1. Pick the account to recover</b>
            <p style={{ marginTop: 6 }}>Connect Google above, then list the wallets this guardian can recover and pick one.</p>
            <button onClick={loadMyAccounts} disabled={!!busy || !embedded} style={btn}>
              {busy === 'accounts' ? 'Loading…' : 'List my recoverable accounts'}
            </button>
            {accounts.length > 0 && (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {accounts.map((a) => (
                  <button key={a.username} onClick={() => pickAccount(a.username)} disabled={!!busy}
                    style={{ ...btn, textAlign: 'left', background: username === a.username ? '#eef6ff' : '#fff' }}>
                    <b>{a.username}</b>
                    <br />
                    <span style={{ fontSize: 12, color: '#555', fontFamily: 'monospace' }}>
                      money: {a.wallets.money ?? '—'}  ·  spot: {a.wallets.spot ?? '—'}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <p style={{ marginTop: 12, fontSize: 12, color: '#888' }}>Or look up by username:</p>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username"
              style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #ccc', marginRight: 8, color: '#111', background: '#fff' }} />
            <button onClick={() => doLookup()} disabled={!!busy || !embedded || !username.trim()} style={btn}>{busy === 'lookup' ? 'Looking up…' : 'Look up'}</button>
          </div>

          {targets.some((t) => t.chainId === bsc.id) && (
            <div style={{ ...box, borderLeft: '4px solid #16a34a' }}>
              <b>⚡ Prod flow — recover money + spot on BSC, one passkey</b>
              <p style={{ marginTop: 6 }}>
                One button: reconstruct → deploy → rotate <b>both</b> BSC wallets to a
                <b> single new passkey</b> named <code>{lookup?.username} (recovered)</code>, then one backend
                swap. No per-row steps — this is the prod flow. (Deploy uses the owner Touch ID here
                because these are fresh test accounts; in prod recovery only rotates already-deployed wallets.)
              </p>
              <button onClick={recoverBscOneShot} disabled={!!busy} style={{ ...btn, background: done ? '#e7f8ec' : '#fff' }}>
                {busy === 'recover-bsc' ? 'Recovering…' : done ? 'Recovered ✅ (run again?)' : 'Recover BSC — one passkey'}
              </button>
            </div>
          )}

          {targets.length > 0 && (
            <div style={box}>
              <b>2. Reconstruct + verify ({targets.length} wallet×chain)</b>
              <p style={{ marginTop: 6 }}>Rebuild every account — or use the per-row <b>reconstruct</b> button in the table to do just one (e.g. BNB Smart Chain) — and confirm each address matches the backend.</p>
              <button onClick={() => reconstruct()} disabled={!!busy} style={btn}>{busy === 'reconstruct' ? 'Reconstructing…' : 'Reconstruct all'}</button>
              <div style={{ marginTop: 12 }}>
                <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%' }}>
                  <thead><tr style={{ textAlign: 'left' }}><th>wallet</th><th>chain</th><th>address</th><th>match</th><th>deployed</th><th>recovered</th><th></th></tr></thead>
                  <tbody>
                    {targets.map((t) => (
                      <tr key={t.key} style={{ borderTop: '1px solid #eee' }}>
                        <td>{t.walletType}</td><td>{t.chainName}</td>
                        <td><code style={{ fontSize: 11 }}>{t.address.slice(0, 10)}…</code></td>
                        <td>{t.addressOk === undefined ? '—' : t.addressOk ? '✅' : '❌'}</td>
                        <td>{t.deployed === undefined ? '—' : String(t.deployed)}</td>
                        <td>{t.recovered ? '✅' : '—'}</td>
                        <td>{!t.account ? (
                          <button onClick={() => reconstruct(t)} disabled={!!busy} style={{ ...btn, padding: '3px 8px', margin: 0, fontSize: 12 }}>
                            {busy === 'reconstruct-' + t.key ? '…' : 'reconstruct'}
                          </button>
                        ) : t.deployed === false ? (
                          <button onClick={() => deployOne(t)} disabled={!!busy} style={{ ...btn, padding: '3px 8px', margin: 0, fontSize: 12 }}>
                            {busy === 'deploy-' + t.key ? '…' : 'deploy (demo)'}
                          </button>
                        ) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {anyDeployed && (
            <div style={box}>
              <b>3. Recover everything → one new passkey</b>
              <p style={{ marginTop: 6 }}>Rotates every <b>deployed</b> wallet×chain (from the table above) to a single new passkey, then updates the backend once. Undeployed rows are left alone — nothing to recover there.</p>
              <button onClick={recoverAll} disabled={!!busy} style={{ ...btn, background: done ? '#e7f8ec' : '#fff' }}>{busy === 'recover' ? 'Recovering…' : done ? 'Recovered ✅ (run again?)' : 'Recover all wallets + chains'}</button>
            </div>
          )}

          {log.length > 0 && <pre style={{ ...box, whiteSpace: 'pre-wrap', fontSize: 13 }}>{log.join('\n')}</pre>}
          {err && <p style={{ color: '#b00', marginTop: 12 }}>{err}</p>}
          <button onClick={logout} style={{ ...btn, marginTop: 16 }}>Log out</button>
        </>
      )}
    </div>
  );
}
