import type * as TaskLib from 'azure-pipelines-task-lib/task';
import { createHttpsClient, HttpResponse, HttpPreflightError, DEFAULT_REQUEST_TIMEOUT_MS } from './https-client';
import { retryAsync, isPrivateOrLinkLocalHost, resolvesToPrivateOrLinkLocalAddress } from '@4cloudguru/pipeline-task-core';

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
 * rejectUnauthorized=false only makes sense for an internal callback endpoint
 * fronted by a private CA the agent doesn't trust -- there is never a
 * legitimate reason to disable TLS verification against a genuinely public
 * host, which is exactly the on-path MITM scenario #588 flags (this mirrors
 * the equivalent guard TerraformModulePublishV1 already has for registryUrl).
 * Unlike registryUrl there (a single well-known public host, terraform.io,
 * cheap to denylist), callbackUrl is fully operator-defined with no canonical
 * public equivalent, so this checks the actual resolved address instead:
 * fails closed on a URL that doesn't parse, and on a host that does NOT
 * resolve to a private/link-local/reserved address.
 *
 * azure-pipelines-task-lib is require()'d lazily here (instead of a top-level
 * import), matching https-client.ts's buildProxyAgent for the same reason: an
 * eager top-level require would run before a mock-run test harness's
 * tr.setInput() calls when a test imports this module's exports (e.g.
 * resolveRejectUnauthorized) directly for a pure helper, permanently
 * poisoning task-lib's process-global input/endpoint snapshot for the rest of
 * the test process.
 */
export async function assertRejectUnauthorizedNotAgainstPublicHost(callbackUrl: string): Promise<void> {
    const tasks = require('azure-pipelines-task-lib/task') as typeof TaskLib;
    let hostname: string;
    try {
        hostname = new URL(callbackUrl).hostname;
    } catch {
        throw new Error(tasks.loc('RejectUnauthorizedUrlUnparseable', callbackUrl));
    }
    const isPrivate = isPrivateOrLinkLocalHost(hostname) || await resolvesToPrivateOrLinkLocalAddress(hostname);
    if (!isPrivate) {
        throw new Error(tasks.loc('RejectUnauthorizedPublicHostRejected', hostname));
    }
}

/**
 * Resolves the callback-failure gating flag, fail-secure (same pattern as
 * resolveRejectUnauthorized above, for the same reason: tasks.getBoolInput
 * returns false for an absent or blank runtime value, which would silently
 * flip this from its non-breaking "true" default). The task defaults to
 * failing the task on a non-2xx callback response, preserving the task's
 * original behavior; only an explicit "false" makes a failed callback a
 * non-fatal warning.
 */
export function resolveFailOnCallbackError(raw: string | undefined): boolean {
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
    return retryAsync(() => postJson(url, headers, body, rejectUnauthorized, timeoutMs), {
        retries,
        baseDelayMs,
        // Deliberately NEVER retry a received response -- even a 5xx (see the
        // doc-comment above): the one-shot callback token makes a retry-after-
        // response ambiguous with a token-replay rejection. retryResult defaults to
        // "never", but it is set explicitly here to lock that design decision.
        retryResult: () => false,
        // A pure transport failure (no response received) is retried -- EXCEPT
        // HttpPreflightError: a malformed url or proxy config throws
        // synchronously, before any request is dispatched, from inputs fixed for
        // the whole task run -- so it fails identically on every attempt.
        // Retrying it wastes the entire budget delaying a guaranteed failure
        // rather than surfacing it immediately.
        retryError: (err) => !(err instanceof HttpPreflightError),
        onRetry: (attempt, _delayMs, outcome) => {
            if (outcome.kind === 'error') {
                const reason = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
                opts.log?.(`Drift callback transport failure (${reason}); retrying (${attempt + 1}/${retries}).`);
            }
        },
    });
}
