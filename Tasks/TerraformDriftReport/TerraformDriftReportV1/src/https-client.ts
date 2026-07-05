import * as https from 'https';
import { URL } from 'url';

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
}

export type HttpClient = (
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string,
) => Promise<HttpResponse>;

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
                    resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
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
