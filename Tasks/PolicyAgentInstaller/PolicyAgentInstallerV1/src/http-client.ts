import tasks = require('azure-pipelines-task-lib/task');
import { ProxyAgent } from 'undici';

/**
 * Per-request timeouts (ms). Without an AbortController a hung TCP connection
 * stalls the install until the agent job timeout. Metadata lookups are quick;
 * binary downloads need a far larger ceiling.
 */
export const METADATA_TIMEOUT_MS = 60_000;
export const DOWNLOAD_TIMEOUT_MS = 600_000;

function buildFetchOptions(): RequestInit {
    const proxy = tasks.getHttpProxyConfiguration();
    if (!proxy) return {};

    let proxyUrl = proxy.proxyUrl;
    if (proxy.proxyUsername !== "") {
        const url = new URL(proxy.proxyUrl);
        url.username = proxy.proxyUsername ?? "";
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
 * the response headers, AND body consumption — the consume callback runs inside
 * the timeout guard, so a stalled body stream is bounded too. On timeout the
 * request is aborted and a clear error is thrown rather than hanging the job.
 */
export async function fetchWithTimeout<T>(
    url: string,
    timeoutMs: number,
    consume: (response: Response) => Promise<T>,
): Promise<T> {
    if (!url.startsWith('https://')) {
        throw new Error(tasks.loc("InsecureUrlRejected", url));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...buildFetchOptions(), signal: controller.signal });
        return await consume(response);
    } catch (err) {
        if (controller.signal.aborted) {
            throw new Error(`Request to ${url} timed out after ${timeoutMs}ms.`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

export function fetchJson<T>(url: string): Promise<T> {
    return fetchWithTimeout(url, METADATA_TIMEOUT_MS, async (response) => {
        if (!response.ok) {
            throw new Error(tasks.loc("RegistryRequestFailed", url, response.status));
        }
        return (await response.json()) as T;
    });
}

export function fetchText(url: string): Promise<string> {
    return fetchWithTimeout(url, METADATA_TIMEOUT_MS, async (response) => {
        if (!response.ok) {
            throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
        }
        // The returned promise is awaited inside fetchWithTimeout's guard, so the
        // body read stays bounded by the timeout without a redundant await here.
        return response.text();
    });
}

export function fetchBuffer(url: string): Promise<Uint8Array> {
    return fetchWithTimeout(url, DOWNLOAD_TIMEOUT_MS, async (response) => {
        if (!response.ok) {
            throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
        }
        return new Uint8Array(await response.arrayBuffer());
    });
}
