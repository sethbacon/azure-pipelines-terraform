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
import { retryAsync } from './retry';

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

/**
 * Upper bound on the non-JSON response body echoed in a fetchJson parse-failure
 * message, so a credential-reflecting 2xx body (e.g. a captive portal or an auth
 * proxy's HTML error page returned with a 200) cannot be dumped to the log whole.
 */
const JSON_ERROR_BODY_CHARS = 512;

/** Upper bound (ms) on an honored HTTP 429 Retry-After, so a hostile/misconfigured server cannot stall the install. */
const RETRY_AFTER_CAP_MS = 30_000;

/**
 * Upper bound on a response body buffered in memory. Node's built-in fetch()
 * has no default limit on response.json()/.text()/.arrayBuffer() -- they
 * buffer until stream end or process OOM, so a compromised/malicious endpoint
 * behind a registryUrl/mirrorUrl input could otherwise exhaust agent memory.
 * Mirrors the 10MB cap already enforced by the credential-bearing
 * https-client.ts/servicenow-http.ts families (see the "why two module
 * families" note in check-shared-modules.js). The actual Terraform/OpenTofu
 * binary download does not go through this client -- it uses
 * azure-pipelines-tool-lib's downloadTool(), which streams to a temp file --
 * so this only bounds the small metadata/checksum/signature payloads that do.
 */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * Error carrying whether the failure is worth retrying (transient) vs
 * deterministic (4xx / insecure URL). `retryAfterMs` carries the capped 429
 * Retry-After delay when the server sent one (#584); undefined otherwise, in
 * which case withRetry falls back to its exponential backoff.
 */
class HttpError extends Error {
    constructor(message: string, readonly retryable: boolean, readonly retryAfterMs?: number) {
        super(message);
        this.name = 'HttpError';
    }
}

/**
 * A response status worth retrying: a server-side 5xx, or 429 Too Many Requests
 * (#584). GitHub's release API (called unauthenticated for OpenTofu/OPA/
 * terraform-docs latest resolution), the checkpoint API, and the registry
 * endpoints all rate-limit with 429, so a single 429 must back off rather than
 * fail the install outright.
 */
function isRetryableHttpStatus(status: number): boolean {
    return status >= 500 || status === 429;
}

/**
 * Parse an HTTP `Retry-After` header into a capped millisecond delay, or
 * undefined when it is absent/blank/invalid (the caller then falls back to its
 * exponential backoff). Accepts both the delta-seconds form (`Retry-After: 120`)
 * and the HTTP-date form; a past date is treated as invalid. Clamped to
 * RETRY_AFTER_CAP_MS so a hostile/misconfigured server cannot stall the install.
 */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
    if (value === null || value === undefined) {
        return undefined;
    }
    const trimmed = value.trim();
    if (trimmed === '') {
        return undefined;
    }
    if (/^\d+$/.test(trimmed)) {
        const seconds = Number(trimmed);
        if (!Number.isFinite(seconds)) {
            return undefined;
        }
        return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
    }
    const dateMs = Date.parse(trimmed);
    if (Number.isNaN(dateMs)) {
        return undefined;
    }
    const delta = dateMs - Date.now();
    return delta > 0 ? Math.min(delta, RETRY_AFTER_CAP_MS) : undefined;
}

/** The capped 429 Retry-After delay from a response, or undefined for any other status/absent header. */
function retryAfterMsFromResponse(response: Response): number | undefined {
    return response.status === 429 ? parseRetryAfterMs(response.headers.get('retry-after')) : undefined;
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
 * GitHub release-asset URLs (https://github.com/<org>/<repo>/releases/download/...)
 * answer with a 302 onto GitHub's asset CDN at a *.githubusercontent.com host
 * (e.g. objects.githubusercontent.com, release-assets.githubusercontent.com), so
 * a strict same-host rule would fail every GitHub-sourced verification-material
 * fetch closed (OpenTofu SHA256SUMS, OPA .sha256, terraform-docs .sha256sum).
 * This narrowly allows that one boundary: the redirect must have been issued by
 * the TLS-authenticated github.com origin itself, the target must stay https://
 * (no protocol downgrade), and the target host must sit under GitHub's own
 * githubusercontent.com asset domain. The suffix match keeps working when GitHub
 * rotates the CDN label; every other origin and every non-GitHub target host
 * stays refused.
 */
function isGithubAssetRedirect(originHost: string, next: URL): boolean {
    return (originHost === 'github.com' || originHost === 'www.github.com')
        && next.protocol === 'https:'
        && next.host.endsWith('.githubusercontent.com');
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
 * https:// AND stay on the original host, with one narrow exception for
 * github.com release-asset redirects onto GitHub's own *.githubusercontent.com
 * CDN (see isGithubAssetRedirect). The remaining callers (checkpoint API,
 * registry version/info endpoints, releases.hashicorp.com SHA256SUMS/.sig) have
 * no legitimate reason to redirect to a different host, so any other off-host
 * redirect is refused rather than followed.
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
            if (next.host !== originHost && !isGithubAssetRedirect(originHost, next)) {
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

/**
 * Retries a fetch on transient failures (network error, timeout, 5xx, 429) with
 * exponential backoff. Delegates to the shared retry.ts helper (retryAsync) so the
 * installer family shares the one bounded-backoff loop with the rest of the repo
 * (#645); the exact previous semantics are preserved via predicates:
 *   - total attempts = RETRY_ATTEMPTS (retries + the initial try),
 *   - a non-HttpError (network/DNS/TLS failure) is transient; an HttpError is
 *     retried only when its `retryable` flag is set,
 *   - a capped 429 Retry-After is honored when the server sent one (#584),
 *     otherwise the RETRY_BASE_MS * 2**n exponential backoff is used.
 */
function withRetry<T>(fn: () => Promise<T>): Promise<T> {
    return retryAsync(fn, {
        retries: RETRY_ATTEMPTS - 1,
        baseDelayMs: RETRY_BASE_MS,
        // A non-HttpError is a network/DNS/TLS failure — treat as transient.
        retryError: (err) => (err instanceof HttpError ? err.retryable : true),
        // Honor a capped 429 Retry-After when the server sent one (#584);
        // otherwise fall back to the exponential backoff (backoffMs).
        delayMs: (_attempt, backoffMs, outcome) =>
            outcome.kind === 'error' && outcome.error instanceof HttpError && outcome.error.retryAfterMs !== undefined
                ? outcome.error.retryAfterMs
                : backoffMs,
        onRetry: (attempt, _delayMs, outcome) => {
            const err = outcome.kind === 'error' ? outcome.error : undefined;
            tasks.debug(`Fetch attempt ${attempt + 1} failed (${err instanceof Error ? err.message : String(err)}); retrying...`);
        },
    });
}

/**
 * Reads a fetch Response body into memory with a hard byte-count guard,
 * cancelling the stream rather than buffering an unbounded/oversized response.
 */
async function readBoundedArrayBuffer(response: Response, url: string): Promise<ArrayBuffer> {
    if (!response.body) {
        return response.arrayBuffer();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
            await reader.cancel(`Response exceeded ${MAX_RESPONSE_BYTES} bytes.`).catch(() => { /* best-effort */ });
            throw new HttpError(`Response from ${url} exceeded ${MAX_RESPONSE_BYTES} bytes.`, false);
        }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out.buffer;
}

export function fetchJson<T>(url: string): Promise<T> {
    return withRetry(() => fetchWithTimeout(url, METADATA_TIMEOUT_MS, async (response) => {
        if (!response.ok) {
            throw new HttpError(tasks.loc("RegistryRequestFailed", url, response.status), isRetryableHttpStatus(response.status), retryAfterMsFromResponse(response));
        }
        const buf = await readBoundedArrayBuffer(response, url);
        const text = Buffer.from(buf).toString('utf8');
        try {
            return JSON.parse(text) as T;
        } catch {
            // A 2xx whose body is not valid JSON (a captive portal, a misconfigured
            // proxy/WAF, or an internal registry returning an HTML error page with a
            // 200 status) is a DETERMINISTIC failure, not a transient one. Classify it
            // as a non-retryable HttpError so withRetry does not waste RETRY_ATTEMPTS
            // retries on it (a bare JSON.parse SyntaxError would default to retryable),
            // and surface a clear, body-bounded diagnostic instead of a raw
            // "Unexpected token ... in JSON" — mirroring module-publish's parseJson().
            throw new HttpError(`Response from ${url} was not valid JSON; first ${JSON_ERROR_BODY_CHARS} bytes: ${text.slice(0, JSON_ERROR_BODY_CHARS)}`, false);
        }
    }));
}

export function fetchText(url: string): Promise<string> {
    return withRetry(() => fetchWithTimeout(url, METADATA_TIMEOUT_MS, async (response) => {
        if (!response.ok) {
            throw new HttpError(`Failed to fetch ${url}: HTTP ${response.status}`, isRetryableHttpStatus(response.status), retryAfterMsFromResponse(response));
        }
        // The returned promise is awaited inside fetchWithTimeout's guard, so the
        // body read stays bounded by the timeout without a redundant await here.
        const buf = await readBoundedArrayBuffer(response, url);
        return Buffer.from(buf).toString('utf8');
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
            throw new HttpError(`Failed to fetch ${url}: HTTP ${response.status}`, isRetryableHttpStatus(response.status), retryAfterMsFromResponse(response));
        }
        const buf = await readBoundedArrayBuffer(response, url);
        return Buffer.from(buf).toString('utf8');
    }));
}

export function fetchBuffer(url: string): Promise<Uint8Array> {
    return withRetry(() => fetchWithTimeout(url, DOWNLOAD_TIMEOUT_MS, async (response) => {
        if (!response.ok) {
            throw new HttpError(`Failed to fetch ${url}: HTTP ${response.status}`, isRetryableHttpStatus(response.status), retryAfterMsFromResponse(response));
        }
        return new Uint8Array(await readBoundedArrayBuffer(response, url));
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
            throw new HttpError(`Failed to fetch ${url}: HTTP ${response.status}`, isRetryableHttpStatus(response.status), retryAfterMsFromResponse(response));
        }
        return new Uint8Array(await readBoundedArrayBuffer(response, url));
    }));
}
