import * as https from 'https';
import { URL } from 'url';

/**
 * Per-request socket timeout (ms). Without it a hung TCP connection makes the
 * task's own timeoutSeconds silently ineffective until the agent job timeout.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 100_000;

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
 * Creates an HTTPS client backed by Node's built-in https module.
 * @param rejectUnauthorized when false, TLS certificate validation is disabled
 *        (only appropriate for internal registries fronted by a private CA the agent does not trust).
 * @param timeoutMs per-request socket timeout; a stalled connection is destroyed
 *        and rejected rather than hanging until the agent job timeout.
 */
export function createHttpsClient(rejectUnauthorized = true, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): HttpClient {
    return (method, url, headers, body) =>
        new Promise<HttpResponse>((resolve, reject) => {
            const parsed = new URL(url);
            // Never send the registry credential over a non-HTTPS connection.
            if (parsed.protocol !== 'https:') {
                reject(new Error(
                    `Refusing to send credentials over a non-HTTPS URL (scheme '${parsed.protocol}//' on host '${parsed.host}'). Use an https:// registry URL.`,
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
                let chunks = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    chunks += chunk;
                });
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: chunks }));
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

/** Parses a JSON response body into the requested shape. */
export function parseJson<T>(body: string): T {
    return JSON.parse(body) as T;
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

/** Resolves after the given number of milliseconds. */
export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
