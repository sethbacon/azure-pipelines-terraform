/**
 * Minimal hardened HTTPS client for the ServiceNow REST API.
 *
 * Built on Node's raw https.request (no axios) to match this repo's
 * credential-bearing transport posture: an https:// guard (refuse to send the
 * bearer/basic credential over cleartext), a socket timeout, a bounded
 * response buffer, and agent proxy support (tasks.getHttpProxyConfiguration(),
 * via a CONNECT-tunneling https.Agent -- see buildProxyAgent()/ProxyTunnelAgent
 * below). Supports exactly what the ServiceNow table + attachment APIs
 * need — GET/POST/PATCH/DELETE with query params and JSON, form-urlencoded, or
 * raw-binary (attachment upload) bodies.
 *
 * Like axios (which this replaces), a non-2xx response REJECTS: several call
 * sites rely on that to fall back or return null.
 *
 * This is a third, independently-maintained credential-bearing transport
 * alongside Tasks/TerraformModulePublish/TerraformModulePublishV1/src/https-client.ts
 * (shared byte-for-byte with TerraformDriftReport and enforced by
 * scripts/check-shared-modules.js). It is not merged into that shared client
 * because this API needs JSON-body encoding, query-string params, and
 * axios-like non-2xx rejection that the other client's callers don't — see the
 * tracking note in check-shared-modules.js for the split: the ProxyTunnelAgent
 * class below is byte-identity-gated automatically via that script's
 * REGION_FAMILIES (the `#region shared:ProxyTunnelAgent` markers bracketing it
 * here and in both https-client.ts copies), while the remaining parallels
 * (https-only guard, request timeout, response size cap) stay in sync by hand.
 */

import * as https from 'https';
import * as http from 'http';
import * as tls from 'tls';
import * as net from 'net';
import { Duplex } from 'stream';
import { URL } from 'url';
import type * as TaskLib from 'azure-pipelines-task-lib/task';
import { retryAsync, parseRetryAfterMs } from './retry';

export const DEFAULT_REQUEST_TIMEOUT_MS = 100_000;

// Bound how much of a response we buffer; ServiceNow table/attachment responses
// are small JSON, so this only guards against a misbehaving/hostile endpoint.
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * An https.Agent that tunnels every connection through the agent's configured
 * HTTP(S) proxy via an HTTP CONNECT request, then upgrades the tunneled socket
 * to TLS, instead of connecting to the target host directly. Mirrors the
 * proxy-awareness already implemented for the installer family
 * (tasks.getHttpProxyConfiguration() + undici's ProxyAgent in
 * TerraformInstallerV1/src/http-client.ts) and for the shared
 * TerraformModulePublish/TerraformDriftReport https-client.ts, adapted here to
 * this module's own raw https.request transport (see the file header for why
 * this is an independent copy rather than a shared module).
 */
// #region shared:ProxyTunnelAgent -- byte-identical across ModulePublish/DriftReport https-client.ts and PublishKbArticle servicenow-http.ts; enforced by scripts/check-shared-modules.js (REGION_FAMILIES). Edit every copy together.
class ProxyTunnelAgent extends https.Agent {
    constructor(
        private readonly proxyHostname: string,
        private readonly proxyPort: number,
        private readonly proxyAuthHeader: string | undefined,
        private readonly tunnelTimeoutMs: number,
    ) {
        super();
    }

    createConnection(
        options: https.RequestOptions,
        callback?: (err: Error | null, stream: Duplex) => void,
    ): Duplex | null | undefined {
        const targetHost = String(options.hostname ?? options.host ?? '');
        const targetPort = options.port ? Number(options.port) : 443;
        const target = `${targetHost}:${targetPort}`;
        let settled = false;
        let tlsSocket: tls.TLSSocket | undefined;
        // Boxed so settle() (defined before the timer is armed) can clear it.
        const deadline: { timer?: ReturnType<typeof setTimeout> } = {};
        const connectReq = http.request({
            host: this.proxyHostname,
            port: this.proxyPort,
            method: 'CONNECT',
            path: target,
            headers: {
                Host: target,
                ...(this.proxyAuthHeader ? { 'Proxy-Authorization': this.proxyAuthHeader } : {}),
            },
        });
        // Settle this connection attempt exactly once, then stop the deadline timer.
        // On failure, actively tear down the pending CONNECT request and any
        // half-open TLS socket so a wedged proxy leaves nothing dangling.
        const settle = (err: Error | null, stream?: tls.TLSSocket) => {
            if (settled) {
                return;
            }
            settled = true;
            if (deadline.timer) {
                clearTimeout(deadline.timer);
            }
            if (err) {
                connectReq.destroy();
                tlsSocket?.destroy();
            }
            callback?.(err, (stream ?? undefined) as unknown as Duplex);
        };
        // Bound the whole CONNECT round-trip AND the inner TLS handshake below with
        // the caller's configured timeout. The outer request's req.setTimeout() only
        // arms once this createConnection callback fires (invoking that callback is
        // what emits the request's 'socket' event), so a proxy that accepts the TCP
        // connection but never answers the CONNECT -- a wedged/overloaded corporate
        // proxy -- would otherwise hang past timeoutMs until the agent job timeout.
        // This timer is that phase's only deadline; it is cleared the instant the
        // tunnel is established (or fails), after which req.setTimeout() takes over.
        deadline.timer = setTimeout(
            () => settle(new Error(`Proxy CONNECT tunnel to ${target} via ${this.proxyHostname}:${this.proxyPort} timed out after ${this.tunnelTimeoutMs}ms.`)),
            this.tunnelTimeoutMs,
        );
        connectReq.on('connect', (res, socket) => {
            if (res.statusCode !== 200) {
                socket.destroy();
                settle(new Error(`Proxy CONNECT to ${target} failed with status ${res.statusCode}.`));
                return;
            }
            try {
                // Node's TLS SNI extension (servername) may not carry an IP-address
                // literal (RFC 6066) -- Node throws synchronously if asked to. Node's
                // own default (non-proxied) connection path silently omits servername
                // in that case; mirror that here rather than sending SNI only when the
                // target host is a literal IP.
                const sniName = options.servername || targetHost;
                const tlsOptions: tls.ConnectionOptions = {
                    socket,
                    servername: net.isIP(sniName) ? undefined : sniName,
                };
                // Only set rejectUnauthorized when the caller passed an explicit value.
                // Node's own TLS layer treats an explicitly-present `undefined` key
                // differently from an absent one: an absent key falls back to the
                // NODE_TLS_REJECT_UNAUTHORIZED env var (matching the non-proxied
                // https.request default path), while an explicit `undefined` does not.
                if (options.rejectUnauthorized !== undefined) {
                    tlsOptions.rejectUnauthorized = options.rejectUnauthorized;
                }
                tlsSocket = tls.connect(tlsOptions);
                tlsSocket.once('secureConnect', () => settle(null, tlsSocket));
                tlsSocket.once('error', (err) => settle(err));
            } catch (err) {
                socket.destroy();
                settle(err instanceof Error ? err : new Error(String(err)));
            }
        });
        connectReq.on('error', (err) => settle(err));
        connectReq.end();
        return undefined;
    }
}
// #endregion shared:ProxyTunnelAgent

/**
 * Reads the agent's configured HTTP(S) proxy (tasks.getHttpProxyConfiguration())
 * and, when one is set, returns a ProxyTunnelAgent that routes the connection
 * through it. Returns undefined when no proxy is configured, so callers fall
 * back to a direct connection (the previous, unproxied behavior) unchanged.
 *
 * azure-pipelines-task-lib is require()'d lazily here (instead of a top-level
 * import) so merely importing this module never loads it -- see the identical
 * note in https-client.ts's buildProxyAgent for the mock-run test-harness
 * ordering hazard this avoids.
 *
 * @param tunnelTimeoutMs bounds the proxy CONNECT round-trip and inner TLS
 *        handshake, which run before the outer request's socket-timeout can
 *        arm; passed straight through to the returned ProxyTunnelAgent.
 */
function buildProxyAgent(tunnelTimeoutMs: number): https.Agent | undefined {
    const tasks = require('azure-pipelines-task-lib/task') as typeof TaskLib;
    const proxy = tasks.getHttpProxyConfiguration();
    if (!proxy) {
        return undefined;
    }
    let proxyUrl: URL;
    try {
        proxyUrl = new URL(proxy.proxyUrl);
    } catch (err) {
        throw new Error(`Invalid proxy URL configured on the agent: ${err instanceof Error ? err.message : err}`);
    }
    let proxyAuthHeader: string | undefined;
    if (proxy.proxyUsername) {
        if (proxy.proxyPassword) {
            tasks.setSecret(proxy.proxyPassword);
        }
        // ADO's log masking matches literal registered strings only, so the
        // derived base64 form needs its own setSecret registration even though
        // the plain password above is already masked (mirrors the encoded-form
        // registration in auth.ts basicAuthHeader()).
        const proxyCredentials = Buffer.from(`${proxy.proxyUsername}:${proxy.proxyPassword ?? ''}`).toString('base64');
        tasks.setSecret(proxyCredentials);
        proxyAuthHeader = `Basic ${proxyCredentials}`;
    }
    const proxyPort = Number(proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80));
    return new ProxyTunnelAgent(proxyUrl.hostname, proxyPort, proxyAuthHeader, tunnelTimeoutMs);
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

function truncate(s: string, max = 500): string {
    return s.length > max ? `${s.slice(0, max)}… (truncated)` : s;
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
 */
export function snRequest(
    method: string,
    url: string,
    options: SnRequestOptions = {},
): Promise<SnResponse> {
    return new Promise<SnResponse>((resolve, reject) => {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            reject(new Error(`Invalid ServiceNow URL: ${url}`));
            return;
        }

        if (parsed.protocol !== 'https:') {
            reject(new Error(
                `Refusing to send credentials over a non-HTTPS URL (scheme '${parsed.protocol}//' on host '${parsed.host}'). Use an https:// URL.`,
            ));
            return;
        }

        if (options.params) {
            for (const [key, value] of Object.entries(options.params)) {
                parsed.searchParams.set(key, value);
            }
        }

        const bodyBuf = encodeBody(options.body);
        const headers: Record<string, string> = { ...(options.headers ?? {}) };
        if (bodyBuf) {
            headers['Content-Length'] = String(bodyBuf.length);
        }

        const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

        const req = https.request(
            {
                method,
                hostname: parsed.hostname,
                port: parsed.port || 443,
                path: parsed.pathname + parsed.search,
                headers,
                agent: buildProxyAgent(timeoutMs),
            },
            (res) => {
                const chunks: Buffer[] = [];
                let total = 0;
                let overflowed = false;

                res.on('data', (chunk: Buffer) => {
                    total += chunk.length;
                    if (total > MAX_RESPONSE_BYTES) {
                        overflowed = true;
                        req.destroy(new Error(`Response from ${parsed.host} exceeded ${MAX_RESPONSE_BYTES} bytes.`));
                        return;
                    }
                    chunks.push(chunk);
                });

                res.on('end', () => {
                    if (overflowed) {
                        return;
                    }
                    const status = res.statusCode ?? 0;
                    const raw = Buffer.concat(chunks).toString('utf8');
                    let data: Record<string, unknown> = {};
                    if (raw) {
                        try {
                            data = JSON.parse(raw) as Record<string, unknown>;
                        } catch {
                            data = {};
                        }
                    }
                    if (status < 200 || status >= 300) {
                        // On a 429 Too Many Requests, capture a capped Retry-After so
                        // withRetry can honor it (#584); other statuses carry none.
                        const retryAfterMs = status === 429 ? parseRetryAfterMs(res.headers['retry-after']) : undefined;
                        reject(new ServiceNowHttpError(
                            `ServiceNow request ${method} ${parsed.pathname} failed with status ${status}: ${truncate(scrubSecrets(raw, options.scrubValues))}`,
                            status,
                            retryAfterMs,
                        ));
                        return;
                    }
                    resolve({ status, data });
                });
            },
        );

        req.on('error', (err) => reject(err));
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Request to ${parsed.host} timed out after ${timeoutMs}ms.`));
        });

        if (bodyBuf) {
            req.write(bodyBuf);
        }
        req.end();
    });
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
 */
export async function withRetry<T>(
    call: () => Promise<T>,
    opts: { retries?: number; baseDelayMs?: number; log?: (message: string) => void } = {},
): Promise<T> {
    const retries = opts.retries ?? 3;
    const baseDelayMs = opts.baseDelayMs ?? 500;
    return retryAsync(call, {
        retries,
        baseDelayMs,
        retryError: (err) => {
            const status = err instanceof ServiceNowHttpError ? err.status : undefined;
            return status === undefined || status >= 500 || status === 429;
        },
        // Honor a capped 429 Retry-After when the server sent one; otherwise the
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
