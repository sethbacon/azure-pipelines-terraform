import * as https from 'https';
import { URL } from 'url';

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
 */
export function createHttpsClient(rejectUnauthorized = true): HttpClient {
    return (method, url, headers, body) =>
        new Promise<HttpResponse>((resolve, reject) => {
            const parsed = new URL(url);
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

/** Resolves after the given number of milliseconds. */
export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
