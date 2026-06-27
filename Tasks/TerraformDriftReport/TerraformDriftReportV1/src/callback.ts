import * as https from 'https';
import { URL } from 'url';

export interface HttpResponse {
    status: number;
    body: string;
}

/**
 * Minimal HTTPS POST backed by Node's built-in https module. rejectUnauthorized
 * = false disables TLS verification — only for an internal TSM callback fronted
 * by a private CA the agent does not trust.
 */
export function postJson(
    url: string,
    headers: Record<string, string>,
    body: string,
    rejectUnauthorized = true,
): Promise<HttpResponse> {
    return new Promise<HttpResponse>((resolve, reject) => {
        const parsed = new URL(url);
        // Never send the callback token over a non-HTTPS connection.
        if (parsed.protocol !== 'https:') {
            reject(new Error(
                `Refusing to send the callback token over a non-HTTPS URL (scheme '${parsed.protocol}//' on host '${parsed.host}'). Use an https:// callback URL.`,
            ));
            return;
        }
        const options: https.RequestOptions = {
            method: 'POST',
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: `${parsed.pathname}${parsed.search}`,
            headers: {
                ...headers,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body).toString(),
            },
            rejectUnauthorized,
        };
        const req = https.request(options, (res) => {
            let chunks = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { chunks += chunk; });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: chunks }));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

/**
 * Bounds a remote response body before it is interpolated into a thrown error
 * or log line, so a large — or token-reflecting — body cannot be dumped
 * wholesale. The token is also registered with setSecret() for masking; this is
 * defense-in-depth against verbose error bodies.
 */
export function truncateBody(body: string, max = 500): string {
    if (!body) {
        return '';
    }
    return body.length > max ? `${body.slice(0, max)}… (truncated)` : body;
}
