import { NextRequest, NextResponse } from 'next/server';

/**
 * Server-side proxy to Pimlico's v2 bundler + paymaster RPC, so the Pimlico API
 * key never ships in the client bundle (same pattern as /api/orchestrator for the
 * Rhinestone key). The SDK 2.1.0 recovery flow points its `bundler` and
 * `paymaster` at `type: 'custom'` URLs → this route → Pimlico. One Pimlico v2
 * endpoint serves both bundler (eth_sendUserOperation, …) and paymaster
 * (pm_getPaymasterData, …) JSON-RPC methods, so one proxy covers both.
 *
 * Requires PIMLICO_API_KEY in the server env.
 */
const PIMLICO_BASE = 'https://api.pimlico.io/v2';

function apiKey(): string {
  const key = process.env.PIMLICO_API_KEY;
  if (!key) throw new Error('PIMLICO_API_KEY is not configured');
  return key;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ chainId: string }> },
) {
  const { chainId } = await ctx.params;
  if (!/^\d+$/.test(chainId)) {
    return NextResponse.json(
      { error: 'invalid chainId' },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid JSON body' },
      { status: 400 },
    );
  }

  const rpcMethod = (body as { method?: string })?.method;
  try {
    const upstream = await fetch(
      `${PIMLICO_BASE}/${chainId}/rpc?apikey=${apiKey()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    let text = await upstream.text();

    // WebAuthn (passkey) accounts verify a P256 signature on-chain, which costs
    // far more than the stub-signature estimate Pimlico returns → the userOp
    // reverts with "AA26 over verificationGasLimit". Inflate the estimate here,
    // before the SDK uses it (the paymaster signs AFTER estimation, so the bumped
    // limit stays consistent with sponsorship). Passkey verify comfortably fits
    // in ~800k.
    if (rpcMethod === 'eth_estimateUserOperationGas' && upstream.status === 200) {
      try {
        const j = JSON.parse(text);
        const vgl = j?.result?.verificationGasLimit;
        if (vgl) {
          const est = BigInt(vgl);
          const doubled = est * BigInt(2);
          const floor = BigInt(800000);
          const bumped = doubled > floor ? doubled : floor;
          j.result.verificationGasLimit = '0x' + bumped.toString(16);
          text = JSON.stringify(j);
          console.log(
            `[pimlico ${chainId}] bumped verificationGasLimit 0x${est.toString(16)} -> 0x${bumped.toString(16)}`,
          );
        }
      } catch {
        /* leave response untouched on parse failure */
      }
    }

    // Debug: surface the SDK's real paymaster/bundler calls + any Pimlico error.
    if (upstream.status !== 200 || text.includes('"error"')) {
      console.log(
        `[pimlico ${chainId}] ${rpcMethod} -> ${upstream.status} :: ${text.slice(0, 500)}`,
      );
    } else {
      console.log(`[pimlico ${chainId}] ${rpcMethod} -> ${upstream.status} ok`);
    }
    return new NextResponse(text, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.log(`[pimlico ${chainId}] ${rpcMethod} FETCH ERROR: ${(e as Error).message}`);
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 502 },
    );
  }
}
