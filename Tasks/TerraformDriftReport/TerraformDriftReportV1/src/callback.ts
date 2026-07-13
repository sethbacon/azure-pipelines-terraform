import { createHttpsClient, HttpResponse, DEFAULT_REQUEST_TIMEOUT_MS } from './https-client';

// The HTTPS transport (createHttpsClient, truncateBody, types) is shared
// byte-for-byte with TerraformModulePublish via ./https-client and guarded by
// scripts/check-shared-modules.js.
export { truncateBody } from './https-client';

/**
 * Resolves the callback TLS-verification flag, fail-secure. The task input is a
 * boolean with a task.json defaultValue of "true", but that default only applies
 * in the classic editor — tasks.getBoolInput returns false for an absent or blank
 * runtime value (e.g. a YAML pipeline that omits rejectUnauthorized), which would
 * silently turn TLS verification OFF. Read the raw value and default a missing or
 * blank input to verify; only an explicit "false" (case-insensitive) disables it.
 */
export function resolveRejectUnauthorized(raw: string | undefined): boolean {
    return (raw || 'true').trim().toUpperCase() !== 'FALSE';
}

/**
 * Minimal HTTPS POST backed by the shared https client. rejectUnauthorized
 * = false disables TLS verification — only for an internal TSM callback fronted
 * by a private CA the agent does not trust.
 */
export function postJson(
    url: string,
    headers: Record<string, string>,
    body: string,
    rejectUnauthorized = true,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<HttpResponse> {
    return createHttpsClient(rejectUnauthorized, timeoutMs)(
        'POST',
        url,
        { ...headers, 'Content-Type': 'application/json' },
        body,
    );
}

/**
 * Retries postJson on a bounded number of pure TRANSPORT failures only (a
 * thrown error -- connection refused/reset, TLS failure, socket timeout, or
 * the response-size guard). A received HTTP response, including a 5xx, is
 * returned immediately and never retried: the callback token is one-shot, so
 * if the server received and validated the request but its response was
 * lost in transit, a retry could be rejected as a replay of an
 * already-consumed token -- indistinguishable, from the client's side, from
 * "the callback simply hasn't landed yet". A pure transport failure carries
 * no such ambiguity: no response was ever received, so the server cannot
 * have consumed the token.
 */
export async function postJsonWithRetry(
    url: string,
    headers: Record<string, string>,
    body: string,
    rejectUnauthorized = true,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    opts: { retries?: number; baseDelayMs?: number; log?: (message: string) => void } = {},
): Promise<HttpResponse> {
    const retries = opts.retries ?? 3;
    const baseDelayMs = opts.baseDelayMs ?? 500;
    for (let attempt = 0; ; attempt++) {
        try {
            return await postJson(url, headers, body, rejectUnauthorized, timeoutMs);
        } catch (err) {
            if (attempt >= retries) {
                throw err;
            }
            const reason = err instanceof Error ? err.message : String(err);
            opts.log?.(`Drift callback transport failure (${reason}); retrying (${attempt + 1}/${retries}).`);
            await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
        }
    }
}
