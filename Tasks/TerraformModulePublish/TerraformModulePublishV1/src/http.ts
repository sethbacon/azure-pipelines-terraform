import { HttpResponse, truncateBody } from './https-client';
import { retryAsync, parseRetryAfterMs } from './retry';
import tasks = require('azure-pipelines-task-lib/task');

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
        throw new Error(tasks.loc('RegistryNonJsonResponse', truncateBody(body)));
    }
}

/** Resolves after the given number of milliseconds. */
export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A response status worth retrying: a server-side 5xx, or 429 Too Many Requests
 * (#584) — a textbook transient condition on the HCP/registry APIs this task
 * calls. Any other status (including 202/404/422, which the publishers handle
 * explicitly) is returned immediately and never retried.
 */
function isRetryableStatus(status: number): boolean {
    return status >= 500 || status === 429;
}

/**
 * Wraps a single HTTP call with bounded exponential-backoff retry on TRANSIENT
 * failures only — a thrown transport error (socket timeout / connection reset)
 * or a retryable response (5xx, or 429 Too Many Requests). Any other response
 * (including 202/404/422, which the publishers handle explicitly) is returned
 * immediately and never retried. Use this only for calls that are safe to
 * repeat: idempotent GETs, or POSTs the caller has already made idempotent
 * (e.g. the 422-tolerant version create). Genuine create/sync POSTs with no
 * server-side idempotency must NOT be wrapped, to avoid duplicate resources on a
 * retry after a lost response.
 *
 * A 429 Retry-After (#633), when present on the response, is honored (capped)
 * over the default exponential backoff -- see the delayMs override below.
 */
export async function retryHttp(
    call: () => Promise<HttpResponse>,
    opts: { retries?: number; baseDelayMs?: number; log?: (message: string) => void } = {},
): Promise<HttpResponse> {
    const retries = opts.retries ?? 3;
    const baseDelayMs = opts.baseDelayMs ?? 500;
    return retryAsync(call, {
        retries,
        baseDelayMs,
        retryResult: (response) => isRetryableStatus(response.status),
        // A thrown transport error (no response received) is always safe to repeat
        // within the budget; only a RESPONSE is classified by status above.
        retryError: () => true,
        // Honor a capped 429 Retry-After when the server sent one (#633); any other
        // retryable response (a 5xx, or a 429 with no usable Retry-After) falls back
        // to the default exponential backoff.
        delayMs: (_attempt, backoffMs, outcome) => {
            if (outcome.kind === 'result' && outcome.result.status === 429) {
                const retryAfter = outcome.result.headers?.['retry-after'];
                const retryAfterMs = parseRetryAfterMs(Array.isArray(retryAfter) ? retryAfter[0] : retryAfter);
                if (retryAfterMs !== undefined) {
                    return retryAfterMs;
                }
            }
            return backoffMs;
        },
        onRetry: (attempt, _delayMs, outcome) => {
            if (outcome.kind === 'result') {
                opts.log?.(tasks.loc('TransientHttpRetry', outcome.result.status, attempt + 1, retries));
            } else {
                const reason = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
                opts.log?.(tasks.loc('TransientRequestFailureRetry', reason, attempt + 1, retries));
            }
        },
    });
}
