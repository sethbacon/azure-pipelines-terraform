import tasks = require('azure-pipelines-task-lib/task');
import { ProxyAgent } from 'undici';

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

export async function fetchJson<T>(url: string): Promise<T> {
    if (!url.startsWith('https://')) {
        throw new Error(tasks.loc("InsecureUrlRejected", url));
    }

    const options = buildFetchOptions();
    const response = await fetch(url, options);
    if (!response.ok) {
        throw new Error(tasks.loc("RegistryRequestFailed", url, response.status));
    }
    return response.json() as Promise<T>;
}

export async function fetchText(url: string): Promise<string> {
    if (!url.startsWith('https://')) {
        throw new Error(tasks.loc("InsecureUrlRejected", url));
    }

    const options = buildFetchOptions();
    const response = await fetch(url, options);
    if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
    }
    return response.text();
}
