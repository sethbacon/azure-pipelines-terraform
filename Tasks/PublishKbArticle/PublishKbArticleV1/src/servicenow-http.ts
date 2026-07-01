/**
 * Minimal hardened HTTPS client for the ServiceNow REST API.
 *
 * Built on Node's raw https.request (no axios) to match this repo's
 * credential-bearing transport posture: an https:// guard (refuse to send the
 * bearer/basic credential over cleartext), a socket timeout, and a bounded
 * response buffer. Supports exactly what the ServiceNow table + attachment APIs
 * need — GET/POST/PATCH/DELETE with query params and JSON, form-urlencoded, or
 * raw-binary (attachment upload) bodies.
 *
 * Like axios (which this replaces), a non-2xx response REJECTS: several call
 * sites rely on that to fall back or return null.
 */

import * as https from 'https';
import { URL } from 'url';

export const DEFAULT_REQUEST_TIMEOUT_MS = 100_000;

// Bound how much of a response we buffer; ServiceNow table/attachment responses
// are small JSON, so this only guards against a misbehaving/hostile endpoint.
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export interface SnRequestOptions {
    headers?: Record<string, string>;
    params?: Record<string, string>;
    body?: string | Buffer | Record<string, unknown>;
    timeoutMs?: number;
}

export interface SnResponse {
    status: number;
    data: Record<string, unknown>;
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
                        reject(new Error(
                            `ServiceNow request ${method} ${parsed.pathname} failed with status ${status}: ${truncate(raw)}`,
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
