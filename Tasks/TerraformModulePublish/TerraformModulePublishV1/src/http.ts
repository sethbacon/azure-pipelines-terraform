import { HttpResponse, truncateBody } from './https-client';

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

/**
 * Wraps a single HTTP call with bounded exponential-backoff retry on TRANSIENT
 * failures only — a thrown transport error (socket timeout / connection reset)
 * or a 5xx response. Any response with status < 500 (including 202/404/422,
 * which the publishers handle explicitly) is returned immediately and never
 * retried. Use this only for calls that are safe to repeat: idempotent GETs, or
 * POSTs the caller has already made idempotent (e.g. the 422-tolerant version
 * create). Genuine create/sync POSTs with no server-side idempotency must NOT be
 * wrapped, to avoid duplicate resources on a retry after a lost response.
 */
export async function retryHttp(
    call: () => Promise<HttpResponse>,
    opts: { retries?: number; baseDelayMs?: number; log?: (message: string) => void } = {},
): Promise<HttpResponse> {
    const retries = opts.retries ?? 3;
    const baseDelayMs = opts.baseDelayMs ?? 500;
    for (let attempt = 0; ; attempt++) {
        try {
            const response = await call();
            if (response.status < 500 || attempt >= retries) {
                return response;
            }
            opts.log?.(`Transient HTTP ${response.status} from registry; retrying (${attempt + 1}/${retries}).`);
        } catch (err) {
            if (attempt >= retries) {
                throw err;
            }
            const reason = err instanceof Error ? err.message : String(err);
            opts.log?.(`Transient request failure (${reason}); retrying (${attempt + 1}/${retries}).`);
        }
        await delay(baseDelayMs * 2 ** attempt);
    }
}
