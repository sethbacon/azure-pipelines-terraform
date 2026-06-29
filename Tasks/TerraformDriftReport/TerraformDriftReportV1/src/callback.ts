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
