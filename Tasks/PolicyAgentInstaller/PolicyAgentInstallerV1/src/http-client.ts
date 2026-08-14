// SHARED MODULE — intentionally duplicated across TerraformInstallerV1/src,
// PolicyAgentInstallerV1/src, and TerraformDocsInstallerV1/src. CI
// (scripts/check-shared-modules.js) enforces that the copies stay
// byte-identical, so a change here MUST be applied to ALL THREE copies. Each
// task bundles independently, so the duplication is deliberate — not drift.
//
// The client itself now comes from @4cloudguru/pipeline-task-core, which took
// the UNION of this file and azure-pipelines-packer's copy: this side
// contributed the response-size cap, 429/Retry-After handling and the GitHub
// asset-redirect exception, packer's contributed the retry-safe download
// attempt. What remains here is only what the package refuses to own — it
// imports neither azure-pipelines-task-lib nor undici, so proxy dispatch,
// secret masking, localized message text and the redirect policy are injected
// from the task.
import tasks = require('azure-pipelines-task-lib/task');
import { ProxyAgent } from 'undici';
import {
    createHttpClient,
    resolveProxy,
    anyRedirectPolicy,
    sameHostOnly,
    githubAssetRedirects,
    parseRetryAfterMs as coreParseRetryAfterMs,
    DOWNLOAD_TIMEOUT_MS as CORE_DOWNLOAD_TIMEOUT_MS,
    METADATA_TIMEOUT_MS as CORE_METADATA_TIMEOUT_MS,
} from '@4cloudguru/pipeline-task-core';

// Re-exported as values rather than `export { ... }`, which compiles to getter
// thunks that count as uncovered functions no test can meaningfully reach.
export const METADATA_TIMEOUT_MS = CORE_METADATA_TIMEOUT_MS;
export const DOWNLOAD_TIMEOUT_MS = CORE_DOWNLOAD_TIMEOUT_MS;
export const parseRetryAfterMs = coreParseRetryAfterMs;

function buildFetchOptions(): RequestInit {
    const resolved = resolveProxy(tasks.getHttpProxyConfiguration());
    if (!resolved) return {};

    // Every spelling of the credential the resolver found, including the
    // percent-encoded form the dispatcher URL actually embeds and any userinfo
    // already inside Agent.ProxyUrl: the agent's masker matches registered
    // literals, never derivations of them.
    for (const secret of resolved.secrets) {
        tasks.setSecret(secret);
    }

    return {
        // @ts-expect-error Node.js fetch accepts undici dispatcher
        dispatcher: new ProxyAgent(resolved.proxyUrl)
    };
}

const injected = {
    // Re-evaluated per attempt, so a proxy change between retries is picked up.
    fetchOptions: buildFetchOptions,
    debug: (message: string) => tasks.debug(message),
    // These installers download release assets from github.com (OpenTofu, OPA,
    // terraform-docs), which 302 onto GitHub's own *.githubusercontent.com CDN.
    // The package makes that exception opt-in; this repo has always applied it
    // to every caller, so it stays enabled here to preserve behaviour exactly.
    redirectPolicy: anyRedirectPolicy(sameHostOnly, githubAssetRedirects),
};

const insecureUrl = (url: string) => tasks.loc("InsecureUrlRejected", url);

// Each client gets its own factory so the proxy-parity signature can name which
// construction it is reporting; two bare module-level calls are indistinguishable
// to it, and an unnamed site is the one thing that gate exists to avoid.
function createDefaultClient() {
    return createHttpClient({
        ...injected,
        messages: { insecureUrl, requestFailed: (url, status) => `Failed to fetch ${url}: HTTP ${status}` },
    });
}

// Registry metadata keeps its own localized message: "Registry request failed"
// is wrong on a releases.hashicorp.com SHA256SUMS fetch, which is not one.
function createRegistryClient() {
    return createHttpClient({
        ...injected,
        messages: { insecureUrl, requestFailed: (url, status) => tasks.loc("RegistryRequestFailed", url, status) },
    });
}

const client = createDefaultClient();
const registryClient = createRegistryClient();

export const fetchWithTimeout = client.fetchWithTimeout;
export const fetchText = client.fetchText;
export const fetchTextAllow404 = client.fetchTextAllow404;
export const fetchBuffer = client.fetchBuffer;
export const fetchBufferAllow404 = client.fetchBufferAllow404;
export const downloadToFile = client.downloadToFile;
export const fetchJson = registryClient.fetchJson;
