// SHARED MODULE — intentionally duplicated across TerraformInstallerV1/src,
// PolicyAgentInstallerV1/src, and TerraformDocsInstallerV1/src. CI
// (scripts/check-shared-modules.js) enforces that the copies stay
// byte-identical, so a change here MUST be applied to ALL THREE copies. Each
// task bundles independently, so the duplication is deliberate — not drift.
//
// The transport comes from @4cloudguru/pipeline-task-core and the Azure DevOps
// wiring around it — proxy dispatch, secret registration, the debug channel —
// from @4cloudguru/pipeline-task-ado. What remains here is only what neither
// package can know: this task's localized message text and its redirect policy.
//
// This file stays a module rather than folding into its callers because it is
// also the TEST SEAM: the L0 suites mock './http-client' to stub the network
// while the real egress/verification guards keep resolving from -core and stay
// live. Mocking a package specifier instead would blank those guards too.
import tasks = require('azure-pipelines-task-lib/task');
import { createAdoHttpClient } from '@4cloudguru/pipeline-task-ado';
import {
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

// These installers download release assets from github.com (OpenTofu, OPA,
// terraform-docs), which 302 onto GitHub's own *.githubusercontent.com CDN.
// The package makes that exception opt-in; passing it preserves behaviour.
//
// Narrowing it to only the GitHub-bound callers is NOT a matter of dropping it
// from one site: the policy is per-client, and this same client also serves
// releases.hashicorp.com, so narrowing means splitting the GitHub downloads
// onto a client of their own. Deliberately left as separate work.
const redirectPolicy = anyRedirectPolicy(sameHostOnly, githubAssetRedirects);

const insecureUrl = (url: string) => tasks.loc("InsecureUrlRejected", url);

// Each client gets its own factory so the proxy-parity signature can name which
// construction it is reporting; two bare module-level calls are indistinguishable
// to it, and an unnamed site is the one thing that gate exists to avoid.
function createDefaultClient() {
    return createAdoHttpClient({
        redirectPolicy,
        messages: { insecureUrl, requestFailed: (url, status) => `Failed to fetch ${url}: HTTP ${status}` },
    });
}

// Registry metadata keeps its own localized message: "Registry request failed"
// is wrong on a releases.hashicorp.com SHA256SUMS fetch, which is not one.
function createRegistryClient() {
    return createAdoHttpClient({
        redirectPolicy,
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
