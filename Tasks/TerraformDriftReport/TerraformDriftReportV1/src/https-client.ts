// SHARED MODULE — intentionally duplicated between TerraformModulePublishV1/src
// and TerraformDriftReportV1/src. CI (scripts/check-shared-modules.js) enforces
// that the two copies stay byte-identical, so a change here MUST be applied to
// BOTH. Each task bundles independently, so the duplication is deliberate.
//
// The transport itself now comes from @4cloudguru/pipeline-task-core. What used
// to live here — the CONNECT-tunnelling ProxyTunnelAgent, the socket-timeout and
// response-cap constants, the https:// guard, truncateBody — was hand-copied
// verbatim into PublishKbArticle's servicenow-http.ts as well, and held in step
// by three marked regions in this repo's own parity gate. That gate can only see
// files in THIS repository, and PublishKbArticle is moving to
// azure-pipelines-release-docs; a dependency survives that move, a region marker
// does not.
//
// What remains is only what the package refuses to own: it imports no
// azure-pipelines-task-lib, so reading the agent's proxy configuration and
// registering the credential with the log masker are injected from here.
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import type * as TaskLib from 'azure-pipelines-task-lib/task';
import {
    createProxyTunnelAgent,
    httpsRequest,
    DEFAULT_REQUEST_TIMEOUT_MS as CORE_DEFAULT_REQUEST_TIMEOUT_MS,
    truncateBody as coreTruncateBody,
} from '@4cloudguru/pipeline-task-core';

// Re-exported as values rather than `export { ... }`, which compiles to getter
// thunks that count as uncovered functions no test can meaningfully reach.
export const DEFAULT_REQUEST_TIMEOUT_MS = CORE_DEFAULT_REQUEST_TIMEOUT_MS;

/**
 * Bounds a remote response body before it is interpolated into a thrown error
 * or log line. Re-exported here so the publishers and the drift callback keep
 * importing it from the transport module they already import; the single
 * implementation now lives in the package, alongside the transports that were
 * each carrying their own copy of it.
 */
export const truncateBody = coreTruncateBody;

export interface HttpResponse {
    status: number;
    body: string;
    /**
     * Raw response headers (Node's http.IncomingHttpHeaders), so a caller can
     * inspect e.g. Retry-After (#633). Optional so a hand-built { status, body }
     * fixture (no real HTTP round-trip) in tests remains valid; the real
     * transport below (createHttpsClient) always populates it.
     */
    headers?: http.IncomingHttpHeaders;
}

export type HttpClient = (
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string,
) => Promise<HttpResponse>;

/**
 * Reads the agent's configured HTTP(S) proxy (tasks.getHttpProxyConfiguration())
 * and, when one is set, returns an agent that routes the connection through it.
 * Returns undefined when no proxy is configured, so callers fall back to a
 * direct connection unchanged.
 *
 * azure-pipelines-task-lib is require()'d lazily here (instead of a top-level
 * import) so merely importing this module never loads it: task-lib snapshots
 * process.env inputs into a vault the first time it is required in a process
 * (guarded by a process-global flag, so it never re-reads even under a later
 * require through the mock-task shim), so an eager top-level require here was
 * observed to run before a mock-run test harness's tr.setInput() calls when a
 * test imports this module's siblings (e.g. callback.ts) directly for a pure
 * helper, permanently poisoning that flag for the rest of the test process.
 * Requiring lazily, only when an actual request is being dispatched, avoids
 * that ordering hazard entirely.
 *
 * The masking is not optional and cannot be forgotten: createProxyTunnelAgent
 * takes registerSecret as a REQUIRED option, so dropping the tasks.setSecret
 * wiring below is a compile error rather than a silently unmasked proxy
 * password. ADO's masker matches literal registered strings only, which is why
 * the package hands back every spelling of the credential (the raw password,
 * the percent-encoded form, and the derived base64 Basic value) rather than
 * just the one the operator typed.
 *
 * @param tunnelTimeoutMs bounds the proxy CONNECT round-trip and inner TLS
 *        handshake, which run before the outer request's socket-timeout can arm.
 */
function buildProxyAgent(tunnelTimeoutMs: number): https.Agent | undefined {
    const tasks = require('azure-pipelines-task-lib/task') as typeof TaskLib;
    return createProxyTunnelAgent(tasks.getHttpProxyConfiguration(), {
        tunnelTimeoutMs,
        registerSecret: (secret: string) => tasks.setSecret(secret),
    });
}

/**
 * Creates an HTTPS client backed by the package's raw-https transport. Both the
 * module publish (registry API key) and the drift callback (TSM token) send a
 * credential, so this wrapper is shared byte-for-byte across those tasks and
 * guarded by scripts/check-shared-modules.js — a change to how the proxy agent
 * or the timeout is wired can never be applied to one copy and silently missed
 * in the other.
 * @param rejectUnauthorized when false, TLS certificate validation is disabled
 *        (only appropriate for an internal endpoint fronted by a private CA the agent does not trust).
 * @param timeoutMs per-request socket timeout; a stalled connection is destroyed
 *        and rejected rather than hanging until the agent job timeout.
 */
export function createHttpsClient(rejectUnauthorized = true, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): HttpClient {
    // `async` so an unparseable URL, or a malformed agent proxy configuration,
    // REJECTS the returned promise instead of throwing synchronously at the call
    // site — which is what the previous new Promise(...) body did, and what every
    // caller and test is written against.
    return async (method, url, headers, body) =>
        httpsRequest({
            method,
            url: new URL(url),
            headers,
            // Only a truthy body is sent, preserving the previous behaviour
            // exactly: an empty string sets no Content-Length and writes nothing.
            body: body ? Buffer.from(body, 'utf8') : undefined,
            timeoutMs,
            rejectUnauthorized,
            agent: buildProxyAgent(timeoutMs),
        });
}
