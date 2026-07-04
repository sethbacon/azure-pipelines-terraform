// SHARED MODULE — intentionally duplicated across TerraformInstallerV1/src,
// PolicyAgentInstallerV1/src, and TerraformDocsInstallerV1/src. CI
// (scripts/check-shared-modules.js) enforces that the copies stay
// byte-identical, failing the build on any divergence, so a fix or key
// rotation here MUST be applied to ALL THREE copies. This duplication is
// deliberate (each task bundles independently) — not drift to be flagged.
//
// Also shared conceptually (not CI-enforced across repos) with
// azure-pipelines-packer's PackerInstallerV1 copy: this file was brought up
// to parity with packer's hardening on 2026-07-04 (redirect re-validation +
// MAX_REDIRECTS, a typed HttpError + withRetry backoff wrapper,
// fetchTextAllow404/fetchBufferAllow404, and proxy-password masking).
// Apply future fixes to both repos' copies where they still apply.
import tasks = require('azure-pipelines-task-lib/task');
import { ProxyAgent } from 'undici';

/**
 * Per-request timeouts (ms). Without an AbortController a hung TCP connection
 * stalls the install until the agent job timeout. Metadata lookups are quick;
 * binary downloads need a far larger ceiling.
 */
export const METADATA_TIMEOUT_MS = 60_000;
export const DOWNLOAD_TIMEOUT_MS = 600_000;

const MAX_REDIRECTS = 5;
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 200;

/** Error carrying whether the failure is worth retrying (transient) vs deterministic (4xx / insecure URL). */
class HttpError extends Error {
    constructor(message: string, readonly retryable: boolean) {
        super(message);
        this.name = 'HttpError';
    }
}

function buildFetchOptions(): RequestInit {
    const proxy = tasks.getHttpProxyConfiguration();
    if (!proxy) return {};

    let proxyUrl = proxy.proxyUrl;
    if (proxy.proxyUsername) {
        if (proxy.proxyPassword) {
            tasks.setSecret(proxy.proxyPassword);
        }
        let url: URL;
        try {
            url = new URL(proxy.proxyUrl);
        } catch (err) {
            throw new Error(`Invalid proxy URL configured on the agent: ${err instanceof Error ? err.message : err}`);
        }
        url.username = proxy.proxyUsername;
        url.password = proxy.proxyPassword ?? "";
        proxyUrl = url.toString();
    }

    return {
        // @ts-expect-error Node.js fetch accepts undici dispatcher
        dispatcher: new ProxyAgent(proxyUrl)
    };
}

/**
 * Fetches an https:// URL under a wall-clock timeout that covers the connection,
 * every redirect hop, the response headers, AND body consumption — the consume
 * callback runs inside the timeout guard, so a stalled body stream is bounded
 * too. On timeout the request is aborted and a clear error is thrown rather
 * than hanging the job.
 *
 * Redirects are followed manually (not via fetch's automatic redirect:'follow')
 * so each hop's Location can be re-validated before following it: it must stay
 * https:// AND stay on the original host. These callers (checkpoint API,
 * registry version/info endpoints, SHA256SUMS, .sig) have no legitimate reason
 * to redirect to a different host, so an off-host redirect is refused rather
 * than followed.
 */
export async function fetchWithTimeout<T>(
    url: string,
    timeoutMs: number,
    consume: (response: Response) => Promise<T>,
): Promise<T> {
    if (!url.startsWith('https://')) {
        throw new HttpError(tasks.loc("InsecureUrlRejected", url), false);
    }
    const originHost = new URL(url).host;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        let currentUrl = url;
        for (let redirects = 0; ; redirects++) {
            const response = await fetch(currentUrl, { ...buildFetchOptions(), signal: controller.signal, redirect: 'manual' });
            const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
            if (!location) {
                return await consume(response);
            }
            if (redirects >= MAX_REDIRECTS) {
                throw new HttpError(`Too many redirects fetching ${url} (limit ${MAX_REDIRECTS}).`, false);
            }
            const next = new URL(location, currentUrl);
            if (next.protocol !== 'https:') {
                throw new HttpError(tasks.loc("InsecureUrlRejected", next.toString()), false);
            }
            if (next.host !== originHost) {
                throw new HttpError(`Refusing to follow an off-host redirect (${originHost} -> ${next.host}) while fetching ${url}.`, false);
            }
            currentUrl = next.toString();
        }
    } catch (err) {
        if (controller.signal.aborted) {
            throw new HttpError(`Request to ${url} timed out after ${timeoutMs}ms.`, true);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

/** Retries a fetch on transient failures (network error, timeout, 5xx) with exponential backoff. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            // A non-HttpError is a network/DNS/TLS failure — treat as transient.
            const retryable = err instanceof HttpError ? err.retryable : true;
            if (!retryable || attempt === RETRY_ATTEMPTS) throw err;
            tasks.debug(`Fetch attempt ${attempt} failed (${err instanceof Error ? err.message : err}); retrying...`);
            await new Promise(resolve => setTimeout(resolve, RETRY_BASE_MS * Math.pow(2, attempt - 1)));
        }
    }
    throw lastErr;
}

export function fetchJson<T>(url: string): Promise<T> {
    return withRetry(() => fetchWithTimeout(url, METADATA_TIMEOUT_MS, async (response) => {
        if (!response.ok) {
            throw new HttpError(tasks.loc("RegistryRequestFailed", url, response.status), response.status >= 500);
        }
        return (await response.json()) as T;
    }));
}

export function fetchText(url: string): Promise<string> {
    return withRetry(() => fetchWithTimeout(url, METADATA_TIMEOUT_MS, async (response) => {
        if (!response.ok) {
            throw new HttpError(`Failed to fetch ${url}: HTTP ${response.status}`, response.status >= 500);
        }
        // The returned promise is awaited inside fetchWithTimeout's guard, so the
        // body read stays bounded by the timeout without a redundant await here.
        return response.text();
    }));
}

/**
 * Like fetchText, but returns null on a 404 (resource genuinely absent) so
 * callers can distinguish "not published" from a transient/other failure
 * without substring-matching error text. Other non-2xx and network errors
 * still throw (5xx is retried).
 */
export function fetchTextAllow404(url: string): Promise<string | null> {
    return withRetry(() => fetchWithTimeout(url, METADATA_TIMEOUT_MS, async (response) => {
        if (response.status === 404) return null;
        if (!response.ok) {
            throw new HttpError(`Failed to fetch ${url}: HTTP ${response.status}`, response.status >= 500);
        }
        return response.text();
    }));
}

export function fetchBuffer(url: string): Promise<Uint8Array> {
    return withRetry(() => fetchWithTimeout(url, DOWNLOAD_TIMEOUT_MS, async (response) => {
        if (!response.ok) {
            throw new HttpError(`Failed to fetch ${url}: HTTP ${response.status}`, response.status >= 500);
        }
        return new Uint8Array(await response.arrayBuffer());
    }));
}

/**
 * Like fetchBuffer, but returns null on a 404 (resource genuinely absent) so
 * callers can distinguish "not published" from a transient/other failure
 * without substring-matching error text. Other non-2xx and network errors
 * still throw (5xx is retried).
 */
export function fetchBufferAllow404(url: string): Promise<Uint8Array | null> {
    return withRetry(() => fetchWithTimeout(url, DOWNLOAD_TIMEOUT_MS, async (response) => {
        if (response.status === 404) return null;
        if (!response.ok) {
            throw new HttpError(`Failed to fetch ${url}: HTTP ${response.status}`, response.status >= 500);
        }
        return new Uint8Array(await response.arrayBuffer());
    }));
}
