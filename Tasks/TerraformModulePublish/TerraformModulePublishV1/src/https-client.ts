import * as https from 'https';
import * as http from 'http';
import * as tls from 'tls';
import * as net from 'net';
import { Duplex } from 'stream';
import { URL } from 'url';
import type * as TaskLib from 'azure-pipelines-task-lib/task';

/**
 * Per-request socket timeout (ms). Without it a hung TCP connection makes the
 * caller's own timeout silently ineffective until the agent job timeout.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 100_000;

/**
 * Upper bound on the response body buffered in memory. The socket timeout above
 * is an *inactivity* timer, so an endpoint that streams bytes continuously never
 * trips it and could exhaust the agent's memory; this cap makes such a response
 * fail fast instead. Mirrors servicenow-http.ts and is kept byte-identical
 * across the module-publish and drift-report copies by check-shared-modules.js.
 */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

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
 * An https.Agent that tunnels every connection through the agent's configured
 * HTTP(S) proxy via an HTTP CONNECT request, then upgrades the tunneled socket
 * to TLS, instead of connecting to the target host directly. Mirrors the
 * proxy-awareness already implemented for the installer family
 * (tasks.getHttpProxyConfiguration() + undici's ProxyAgent in
 * TerraformInstallerV1/src/http-client.ts), adapted to this module's raw
 * https.request transport, which has no fetch-style dispatcher to hand a
 * ProxyAgent to.
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
        // registration in PublishKbArticle's auth.ts basicAuthHeader()).
        const proxyCredentials = Buffer.from(`${proxy.proxyUsername}:${proxy.proxyPassword ?? ''}`).toString('base64');
        tasks.setSecret(proxyCredentials);
        proxyAuthHeader = `Basic ${proxyCredentials}`;
    }
    const proxyPort = Number(proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80));
    return new ProxyTunnelAgent(proxyUrl.hostname, proxyPort, proxyAuthHeader, tunnelTimeoutMs);
}

/**
 * Creates an HTTPS client backed by Node's built-in https module. Both the module
 * publish (registry API key) and the drift callback (TSM token) send a credential,
 * so this transport is shared byte-for-byte across those tasks and guarded by
 * scripts/check-shared-modules.js — a fix to the https-pin or the socket timeout
 * here can never be applied to one copy and silently missed in the other.
 * @param rejectUnauthorized when false, TLS certificate validation is disabled
 *        (only appropriate for an internal endpoint fronted by a private CA the agent does not trust).
 * @param timeoutMs per-request socket timeout; a stalled connection is destroyed
 *        and rejected rather than hanging until the agent job timeout.
 */
export function createHttpsClient(rejectUnauthorized = true, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): HttpClient {
    return (method, url, headers, body) =>
        new Promise<HttpResponse>((resolve, reject) => {
            const parsed = new URL(url);
            // Never send a credential-bearing request over a non-HTTPS connection.
            if (parsed.protocol !== 'https:') {
                reject(new Error(
                    `Refusing to send credentials over a non-HTTPS URL (scheme '${parsed.protocol}//' on host '${parsed.host}'). Use an https:// URL.`,
                ));
                return;
            }
            const payload = body ?? '';
            const options: https.RequestOptions = {
                method,
                hostname: parsed.hostname,
                port: parsed.port || 443,
                path: `${parsed.pathname}${parsed.search}`,
                headers: body
                    ? { ...headers, 'Content-Length': Buffer.byteLength(payload).toString() }
                    : headers,
                rejectUnauthorized,
                agent: buildProxyAgent(timeoutMs),
            };
            const req = https.request(options, (res) => {
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
                    resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers });
                });
            });
            req.setTimeout(timeoutMs, () => {
                req.destroy(new Error(`Request to ${parsed.host} timed out after ${timeoutMs}ms.`));
            });
            req.on('error', reject);
            if (body) {
                req.write(payload);
            }
            req.end();
        });
}

/**
 * Bounds a remote response body before it is interpolated into a thrown error
 * or log line, so a large — or credential-reflecting — body cannot be dumped
 * wholesale. The credential itself is also registered with setSecret(), so the
 * agent masks it; this is defense-in-depth against verbose error bodies.
 */
export function truncateBody(body: string, max = 500): string {
    if (!body) {
        return '';
    }
    return body.length > max ? `${body.slice(0, max)}… (truncated)` : body;
}
