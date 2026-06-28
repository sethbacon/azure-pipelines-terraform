import { truncateBody } from './https-client';

// The HTTPS transport (createHttpsClient, truncateBody, types) is shared
// byte-for-byte with TerraformDriftReport via ./https-client and guarded by
// scripts/check-shared-modules.js. parseJson and delay are specific to the
// registry publish flow and stay here.
export * from './https-client';

/**
 * Parses a JSON response body into the requested shape. A misconfigured gateway,
 * captive portal, or auth proxy can answer a 2xx with a non-JSON (e.g. HTML)
 * body; surface that as a clear, body-truncating error rather than letting a raw
 * SyntaxError escape. The body is truncated so a credential-reflecting response
 * cannot be dumped wholesale.
 */
export function parseJson<T>(body: string): T {
    try {
        return JSON.parse(body) as T;
    } catch {
        throw new Error(`Registry returned a non-JSON response body: ${truncateBody(body)}`);
    }
}

/** Resolves after the given number of milliseconds. */
export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
