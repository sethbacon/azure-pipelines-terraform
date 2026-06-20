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
