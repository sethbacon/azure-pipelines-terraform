/**
 * The ServiceNow REST API client.
 *
 * The TRANSPORT is @4cloudguru/pipeline-task-core's httpsRequest: the https://
 * guard (refuse to send the bearer/basic credential over cleartext), the socket
 * timeout, the bounded response buffer, and agent proxy support via a
 * CONNECT-tunnelling https.Agent. What stays here is what is actually specific
 * to this API — query-string params, JSON/form/raw-binary body encoding, and
 * axios-like non-2xx REJECTION, which several call sites rely on to fall back or
 * return null.
 *
 * That split is the point. Until now this was a third, independently-maintained
 * credential-bearing transport alongside TerraformModulePublish's and
 * TerraformDriftReport's https-client.ts, kept in step by three `#region shared:`
 * families in scripts/check-shared-modules.js — with the https-only guard itself
 * outside every gate, tracked by hand. A repo-local gate cannot see across a
 * repository boundary, and this task is moving to azure-pipelines-release-docs;
 * a versioned dependency survives that move, a region marker does not.
 *
 * Built on raw https.request rather than fetch/undici, deliberately: fetch has
 * no `agent` option at all, so a port would silently drop the agent-proxy
 * support below and every test that drives a request through a real CONNECT
 * proxy (see Tests/ProxyL0.ts).
 */

import * as https from 'https';
import { URL } from 'url';
import type * as TaskLib from 'azure-pipelines-task-lib/task';
import {
    retryAsync,
    parseRetryAfterMs,
    createProxyTunnelAgent,
    httpsRequest,
    DEFAULT_REQUEST_TIMEOUT_MS as CORE_DEFAULT_REQUEST_TIMEOUT_MS,
    truncateBody,
} from '@4cloudguru/pipeline-task-core';

/**
 * Re-exported so this module's own callers keep importing it from here. The
 * value is the package's, shared with every other credential-bearing transport
 * in the estate rather than hand-copied into each.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = CORE_DEFAULT_REQUEST_TIMEOUT_MS;



/**
 * Reads the agent's configured HTTP(S) proxy (tasks.getHttpProxyConfiguration())
 * and, when one is set, returns an agent that routes the connection through it.
 * Returns undefined when no proxy is configured, so callers fall back to a
 * direct connection unchanged.
 *
 * azure-pipelines-task-lib is require()'d lazily here (instead of a top-level
 * import) so merely importing this module never loads it -- see the identical
 * note in https-client.ts's buildProxyAgent for the mock-run test-harness
 * ordering hazard this avoids.
 *
 * The masking cannot be forgotten: createProxyTunnelAgent takes registerSecret
 * as a REQUIRED option, so dropping the tasks.setSecret wiring is a compile
 * error rather than a silently unmasked proxy password. ADO's masker matches
 * literal registered strings only, which is why the package hands back every
 * spelling of the credential (raw password, percent-encoded form, and the
 * derived base64 Basic value) rather than only the one the operator typed --
 * the same reason auth.ts's basicAuthHeader() registers its encoded form.
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

export interface SnRequestOptions {
    headers?: Record<string, string>;
    params?: Record<string, string>;
    body?: string | Buffer | Record<string, unknown>;
    timeoutMs?: number;
    /**
     * Request secrets (e.g. an OAuth client_secret POSTed in the body) to scrub
     * from a non-2xx response body before it is interpolated into the thrown
     * error message (#647) — a validation-error body that reflects request
     * parameters back must not leak the credential into the unmasked
     * task-failure text. Scrubbing runs BEFORE truncation so a full secret
     * occurrence straddling the truncation boundary cannot survive as a
     * partial prefix. Mirrors TerraformTaskV5's oci-token-exchange convention
     * (literal split/join, no regex; only non-trivial values scrubbed).
     */
    scrubValues?: string[];
}

export interface SnResponse {
    status: number;
    data: Record<string, unknown>;
}

/**
 * Thrown for a non-2xx ServiceNow response (as opposed to a pure transport
 * failure -- connection error, timeout, or the response-size guard, which
 * throw a plain Error with no `status`). Lets withRetry() distinguish "the
 * server responded with an error" from "no response was ever received".
 * `retryAfterMs` carries the capped 429 Retry-After delay when the server sent
 * one (#584); it is undefined otherwise, and withRetry() then falls back to its
 * exponential backoff.
 */
export class ServiceNowHttpError extends Error {
    constructor(message: string, public readonly status: number, public readonly retryAfterMs?: number) {
        super(message);
        this.name = 'ServiceNowHttpError';
    }
}

function encodeBody(body: SnRequestOptions['body']): Buffer | undefined {
    if (body === undefined) {
        return undefined;
    }
    if (Buffer.isBuffer(body)) {
        return body;
    }
    if (typeof body === 'string') {
        return Buffer.from(body, 'utf8');
    }
    return Buffer.from(JSON.stringify(body), 'utf8');
}


/** Remove known request secrets from a response body (see SnRequestOptions.scrubValues). */
function scrubSecrets(body: string, secrets: string[] | undefined): string {
    let scrubbed = body;
    for (const secret of secrets ?? []) {
        if (secret && secret.length >= 8) {
            scrubbed = scrubbed.split(secret).join('***');
        }
    }
    return scrubbed;
}

/**
 * Issue a request to the ServiceNow REST API. Resolves with the HTTP status and
 * the parsed JSON body (empty object when there is no JSON body); rejects on a
 * non-HTTPS URL, transport error, timeout, or non-2xx status.
 *
 * The URL is parsed HERE rather than by the transport, so an operator-supplied
 * instance URL that will not parse fails with a message naming ServiceNow
 * instead of a bare TypeError.
 */
export async function snRequest(
    method: string,
    url: string,
    options: SnRequestOptions = {},
): Promise<SnResponse> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`Invalid ServiceNow URL: ${url}`);
    }

    if (options.params) {
        for (const [key, value] of Object.entries(options.params)) {
            parsed.searchParams.set(key, value);
        }
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    // The https:// guard, the socket timeout and the response byte cap all live
    // in the shared transport. Content-Length is derived there from the encoded
    // body, which is why encodeBody's "an empty buffer is still a body"
    // distinction is preserved rather than collapsed to a truthiness check.
    const { status, body: raw, headers } = await httpsRequest({
        method,
        url: parsed,
        headers: options.headers,
        body: encodeBody(options.body),
        timeoutMs,
        agent: buildProxyAgent(timeoutMs),
    });

    let data: Record<string, unknown> = {};
    if (raw) {
        try {
            data = JSON.parse(raw) as Record<string, unknown>;
        } catch {
            data = {};
        }
    }

    // Non-2xx REJECTS, like the axios client this replaced: several call sites
    // rely on that to fall back or return null. This is the ServiceNow-specific
    // half of the split -- the transport returns a status and takes no view of
    // it, because the sibling registry-publish client inspects the same status
    // instead of throwing on it.
    if (status < 200 || status >= 300) {
        // On a 429 Too Many Requests, capture a capped Retry-After so
        // withRetry can honor it (#584); other statuses carry none.
        const retryAfterMs = status === 429 ? parseRetryAfterMs(headers['retry-after']) : undefined;
        throw new ServiceNowHttpError(
            `ServiceNow request ${method} ${parsed.pathname} failed with status ${status}: ${truncateBody(scrubSecrets(raw, options.scrubValues))}`,
            status,
            retryAfterMs,
        );
    }

    return { status, data };
}

/**
 * Wraps a mutating ServiceNow call (create/update/publish/upload) with bounded
 * exponential-backoff retry on TRANSIENT failures only: a thrown transport
 * error (no response ever received -- connection reset, timeout, response-size
 * guard) or a captured 5xx or 429 status. A captured 4xx other than 429 (bad
 * request, auth failure, not-found, validation error, etc.) is never retried --
 * retrying an unchanged request wouldn't produce a different result. A 429 Too
 * Many Requests IS retried, honoring a capped Retry-After when present (#584).
 * Delegates to the shared bounded-backoff helper (retry.ts) so a future
 * hardening change lands in one place across every task.
 *
 * `retryError` may be overridden by the caller (audit id18, 2026-07-20): the
 * default treats a thrown error with NO captured status (a pure transport
 * failure -- the request may or may not have reached the server) as
 * retryable, which is safe for idempotent/read calls but NOT for a
 * non-idempotent create, where the server may have already processed the
 * request and the response was simply lost in transit -- retrying would then
 * create a duplicate record with no way to tell. Callers making a
 * non-idempotent create/POST should pass a `retryError` that excludes the
 * status-undefined case, retrying only a captured 5xx/429 (a definitive
 * response was received, so the ambiguity does not apply) and otherwise
 * treating the transport failure as fatal so the operator can safely re-run
 * (self-healing via a get-or-create lookup on the next invocation).
 */
export async function withRetry<T>(
    call: () => Promise<T>,
    opts: { retries?: number; baseDelayMs?: number; log?: (message: string) => void; retryError?: (err: unknown) => boolean } = {},
): Promise<T> {
    const retries = opts.retries ?? 3;
    const baseDelayMs = opts.baseDelayMs ?? 500;
    const retryError = opts.retryError ?? ((err) => {
        const status = err instanceof ServiceNowHttpError ? err.status : undefined;
        return status === undefined || status >= 500 || status === 429;
    });
    return retryAsync(call, {
        retries,
        baseDelayMs,
        retryError,        // Honor a capped 429 Retry-After when the server sent one; otherwise the
        // exponential backoff.
        delayMs: (_attempt, backoffMs, outcome) => {
            if (
                outcome.kind === 'error'
                && outcome.error instanceof ServiceNowHttpError
                && outcome.error.status === 429
                && outcome.error.retryAfterMs !== undefined
            ) {
                return outcome.error.retryAfterMs;
            }
            return backoffMs;
        },
        onRetry: (attempt, _delayMs, outcome) => {
            if (outcome.kind === 'error') {
                const reason = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
                opts.log?.(`Transient ServiceNow request failure (${reason}); retrying (${attempt + 1}/${retries}).`);
            }
        },
    });
}

/**
 * `retryError` policy for a non-idempotent create/POST (audit id18, 2026-07-20):
 * pass this to {@link withRetry}'s `retryError` option for
 * createKnowledgeArticle / uploadAttachment. Retries ONLY a captured 5xx/429
 * response (the server definitively responded, so the create is known to have
 * failed server-side); a thrown error with no status at all (a pure transport
 * failure -- the response may have been lost after the server already created
 * the record) is treated as fatal instead of retried, so the operator's own
 * pipeline re-run is what recovers, via the existing get-or-create lookup
 * (findArticleBySourceKey) rather than a same-invocation retry that could
 * create a second, orphaned record with no way to detect it.
 */
export function nonIdempotentCreateRetryError(err: unknown): boolean {
    const status = err instanceof ServiceNowHttpError ? err.status : undefined;
    return status === 429 || (status !== undefined && status >= 500);
}
