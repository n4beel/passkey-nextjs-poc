import { API_BASE, API_V2_BASE } from './config';
import { createCanonicalString, generateSignature } from './crypto';
import { getDeviceInfo } from './deviceId';

export type SignedFetchOptions = RequestInit & {
    auth?: boolean;
    json?: unknown;
    apiBase?: string;
};

export function getAccessToken(): string | null {
    if (typeof window === 'undefined') {
        return null;
    }

    return localStorage.getItem('accessToken');
}

function toRelativePath(path: string): string {
    if (path.startsWith('http://') || path.startsWith('https://')) {
        const url = new URL(path);
        return `${url.pathname}${url.search}`;
    }

    return path.startsWith('/') ? path : `/${path}`;
}

export function toSigningPath(path: string): string {
    const relativePath = toRelativePath(path);
    return relativePath.replace(/^\/[^/]+\/v\d+/, '') || relativePath;
}

function toFetchPath(path: string, apiBase: string): string {
    const relativePath = toRelativePath(path);
    const apiBaseUrl = new URL(apiBase);
    const apiPrefix = apiBaseUrl.pathname.replace(/\/$/, '');

    if (relativePath.startsWith(apiPrefix)) {
        return relativePath.slice(apiPrefix.length) || '/';
    }

    return relativePath;
}

export async function signedFetch(
    path: string,
    options: SignedFetchOptions = {},
): Promise<Response> {
    const { auth = false, json, apiBase = API_BASE, headers, ...fetchOptions } = options;
    const method = (fetchOptions.method || 'GET').toUpperCase();
    const fetchPath = toFetchPath(path, apiBase);
    const signingPath = toSigningPath(path);
    const timestamp = Date.now();
    const bodyForSigning = json ?? null;
    const deviceInfo = getDeviceInfo();

    const canonicalString = createCanonicalString(
        method,
        signingPath,
        timestamp,
        bodyForSigning,
        deviceInfo.deviceId,
        deviceInfo.deviceType,
    );
    const signature = await generateSignature(canonicalString);

    const requestHeaders = new Headers(headers);
    requestHeaders.set('x-device-id', deviceInfo.deviceId);
    requestHeaders.set('x-device-type', deviceInfo.deviceType);
    requestHeaders.set('x-timestamp', timestamp.toString());

    if (signature) {
        requestHeaders.set('x-signature', signature);
    }

    if (auth) {
        const token = getAccessToken();
        if (!token) {
            // Never fire an auth-required request unauthenticated — the backend
            // would 401 and the failure would be silent/confusing (this is what let
            // the add-bank POST fail after a mid-flow logout). Fail loudly instead.
            throw new Error('Your session has expired. Please log in again.');
        }
        requestHeaders.set('Authorization', `Bearer ${token}`);
    }

    if (json !== undefined) {
        if (!requestHeaders.has('Content-Type')) {
            requestHeaders.set('Content-Type', 'application/json');
        }
        fetchOptions.body = JSON.stringify(json);
    }

    return fetch(`${apiBase}${fetchPath}`, {
        ...fetchOptions,
        method,
        headers: requestHeaders,
    });
}

export { API_BASE, API_V2_BASE };
