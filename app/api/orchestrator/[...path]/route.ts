import { NextRequest, NextResponse } from 'next/server';

const ORCHESTRATOR_URL = 'https://v1.orchestrator.rhinestone.dev';

/**
 * Whitelisted contract addresses that Rhinestone intents are allowed to interact with.
 * This prevents malicious intent operations from being proxied.
 * Set ALLOW_ALL_CONTRACTS=true below to disable validation (dev only).
 */
const ALLOW_ALL_CONTRACTS = process.env.NODE_ENV === 'development';

const WHITELISTED_CONTRACTS = new Set([
    // USDT0 on Plasma
    '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb',
    // USDC on various chains
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // Base USDC
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // Arbitrum USDC
    '0x0b2c639c533813f4aa9d7837caf62653d097ff85', // Optimism USDC
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // Ethereum USDC
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', // Polygon USDC
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // BSC USDC
    // USDT on various chains
    '0xdac17f958d2ee523a2206206994597c13d831ec7', // Ethereum USDT
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', // Arbitrum USDT
    '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', // Optimism USDT
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', // Polygon USDT
    '0x55d398326f99059ff775485246999027b3197955', // BSC USDT
    // WETH
    '0x4200000000000000000000000000000000000006', // Base/OP WETH
]);

function getApiKey(): string {
    const apiKey = process.env.RHINESTONE_API_KEY;
    if (!apiKey) {
        throw new Error('RHINESTONE_API_KEY is not configured');
    }
    return apiKey;
}

/**
 * Validate that intent operations only target whitelisted contracts.
 */
function validateDestinationOps(body: any): boolean {
    if (ALLOW_ALL_CONTRACTS) return true;

    const destinationOps =
        body.signedIntentOp?.signedMetadata?.account?.accountContext
            ?.destinationExecutions;

    if (!destinationOps) return true;

    for (const op of destinationOps) {
        const address = op.to?.toLowerCase();
        if (!address || !WHITELISTED_CONTRACTS.has(address)) {
            console.log(`Blocked non-whitelisted contract: ${address}`);
            return false;
        }
    }

    return true;
}

/**
 * Proxy all Rhinestone orchestrator requests.
 * This keeps the API key on the server and validates intent operations.
 *
 * Routes: GET/POST/PUT/DELETE to /api/orchestrator/[...path]
 * → Forwarded to https://v1.orchestrator.rhinestone.dev/[...path]
 */
async function handler(
    req: NextRequest,
    { params }: { params: Promise<{ path: string[] }> },
) {
    try {
        const apiKey = getApiKey();
        const { path } = await params;
        const pathStr = path.join('/');
        const targetUrl = new URL(`${ORCHESTRATOR_URL}/${pathStr}`);

        // Copy query parameters
        req.nextUrl.searchParams.forEach((value, key) => {
            targetUrl.searchParams.set(key, value);
        });

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
        };
        // Forward the SDK's version headers so the orchestrator answers in the v2
        // format the SDK sends (CAIP-2 chain ids) and parses (`routes`). Without
        // them it falls back to legacy v1 (numeric ids + intentOp/intentCost) and
        // the request/response formats mismatch ("expected number" / "no quote").
        for (const h of ['x-api-version', 'x-sdk-version']) {
            const v = req.headers.get(h);
            if (v) headers[h] = v;
        }

        const fetchOptions: RequestInit = {
            method: req.method,
            headers,
        };

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            try {
                const body = await req.json();

                // Proof capture: log the outbound orchestrator request so we can pair
                // it with the response — shows the route params + whether the intent
                // requested sponsorship (settlement/fee config).
                console.log(
                    `[orchestrator REQ] ${req.method} /${pathStr} BODY=${JSON.stringify(body).slice(0, 20000)}`,
                );

                // Validate intent operations
                if (pathStr.includes('intent-operations')) {
                    if (!validateDestinationOps(body)) {
                        return NextResponse.json(
                            { error: 'Contract not whitelisted' },
                            { status: 403 },
                        );
                    }
                }

                fetchOptions.body = JSON.stringify(body);
            } catch {
                // No body or invalid JSON — proceed without body
            }
        }

        const response = await fetch(targetUrl.toString(), fetchOptions);
        const responseBody = await response.text();

        // Surface orchestrator failures (e.g. intent-operations 422) so we can see WHY.
        if (!response.ok) {
            // Log ALL response headers so we can hand Rhinestone the trace/request id.
            const respHeaders: Record<string, string> = {};
            response.headers.forEach((v, k) => {
                respHeaders[k] = v;
            });
            console.error(
                `[orchestrator] ${req.method} /${pathStr} -> ${response.status} HEADERS=${JSON.stringify(respHeaders)} BODY=${responseBody.slice(0, 1500)}`,
            );
        }

        return new NextResponse(responseBody, {
            status: response.status,
            headers: {
                'Content-Type':
                    response.headers.get('Content-Type') || 'application/json',
            },
        });
    } catch (error) {
        console.error('Proxy error:', error);
        return NextResponse.json(
            {
                error: 'Internal proxy error',
                message:
                    error instanceof Error ? error.message : 'Unknown error',
            },
            { status: 500 },
        );
    }
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
