import { createHttpsClient, HttpResponse, DEFAULT_REQUEST_TIMEOUT_MS } from './https-client';

// The HTTPS transport (createHttpsClient, truncateBody, types) is shared
// byte-for-byte with TerraformModulePublish via ./https-client and guarded by
// scripts/check-shared-modules.js.
export { truncateBody } from './https-client';

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
