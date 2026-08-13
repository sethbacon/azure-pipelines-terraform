import tasks = require('azure-pipelines-task-lib/task');
import tools = require('azure-pipelines-tool-lib/tool');
import path = require('path');
import os = require('os');
import fs = require('fs');
import crypto = require('crypto');
import { pipeline } from 'stream/promises';

import { randomUUID as uuidV4 } from 'crypto';
import { fetchJson, fetchText, fetchTextAllow404, downloadToFile, DOWNLOAD_TIMEOUT_MS } from './http-client';
import { parseAllowedHosts, assertEgressHostAllowed, EgressHostMessages } from './registry-allowlist';
import { validateUrlPathSegment } from './url-path-segment';
import { getBoolInputDefaultTrue } from './bool-input';
import { verifyGpgSignature } from './gpg-verifier';
import { extractUrlTokenSecrets, redactUrl, scrubSecretsFromMessage, redactUrlUserInfo } from './url-secret-redaction';
import { VerificationFailure, isVerificationFailure } from './verification-failure';
import { discardArtifactOnFailure } from './artifact-discard';
import { retryAsync } from '@4cloudguru/pipeline-task-core';
import { maskOperatorUrlCredentials, resolveVersionFromRegistry } from './registry-version-resolver';

/**
 * Localized rejection text for the egress authorization applied to a download
 * destination. assertEgressHostAllowed() itself carries no azure-pipelines-task-lib
 * dependency (it is shared verbatim with the sibling packer extension), so each
 * call site supplies its own message factories naming the offending host and the
 * applicable allowlist input.
 */
const REGISTRY_EGRESS_MESSAGES: EgressHostMessages = {
    notAllowed: (hostname, allowedHosts) => tasks.loc("RegistryDownloadHostNotAllowed", hostname, allowedHosts),
    isPrivate: (hostname) => tasks.loc("RegistryDownloadHostIsPrivate", hostname),
};

const MIRROR_EGRESS_MESSAGES: EgressHostMessages = {
    notAllowed: (hostname, allowedHosts) => tasks.loc("MirrorDownloadHostNotAllowed", hostname, allowedHosts),
    isPrivate: (hostname) => tasks.loc("MirrorDownloadHostIsPrivate", hostname),
};


const isWindows = os.type().match(/^Win/);

// File name of the local, per-cached-tool-directory integrity marker written after
// a verified download (see writeCacheIntegrityMarker / verifyCachedTool below).
const CACHE_INTEGRITY_MARKER = ".installer-verified.sha256";

// A marker's content must be exactly one 64-character SHA256 digest. Anything else --
// empty, truncated, or non-hex -- means the marker is UNVERIFIABLE, not that the tool
// was tampered with; see verifyCachedTool (#198).
const CACHE_INTEGRITY_MARKER_PATTERN = /^[a-fA-F0-9]{64}$/;

/**
 * Bounded retry for the binary download itself (#78): tools.downloadTool performs a
 * single HTTP GET with no retry of its own, so a single transient blip during the
 * largest and slowest fetch of the install failed the whole task. The metadata and
 * checksum fetches already retry inside http-client.ts. Verification is deliberately
 * OUTSIDE the retry -- a checksum or signature failure is deterministic and must
 * never be repeated.
 */
const DOWNLOAD_RETRY = { retries: 2, baseDelayMs: 250, maxBackoffMs: 2000 };

/**
 * Downloads the requested policy agent (Sentinel or OPA), verifies it, caches it
 * via the tool cache, and returns the path to the executable. Sentinel ships as a
 * GPG-signed zip on releases.hashicorp.com; OPA ships as a raw, sha256-verified
 * binary on GitHub releases. Both also support a private registry and custom
 * mirror source.
 */
export async function downloadPolicyAgent(inputVersion: string): Promise<string> {
    const agent = tasks.getInput("policyAgent") || "opa";
    const downloadSource = tasks.getInput("downloadSource") || "official";

    const resolvedVersion = await resolveVersion(agent, downloadSource, inputVersion);
    const version = tools.cleanVersion(resolvedVersion);
    if (!version) {
        throw new Error(tasks.loc("InputVersionNotValidSemanticVersion", resolvedVersion));
    }

    let cachedToolPath = tools.findLocalTool(agent, version);
    const cacheHit = !!cachedToolPath;

    let verified = false;
    if (!cachedToolPath) {
        const artifact = await downloadArtifact(agent, downloadSource, version);
        verified = artifact.verified;

        let toolDir: string;
        if (agent === "sentinel") {
            // Sentinel is distributed as a zip archive.
            toolDir = await tools.extractZip(artifact.path);
        } else {
            // OPA is distributed as a single raw binary; place it in its own dir
            // under the canonical executable name so the tool cache can host it.
            toolDir = placeBinaryInDir(artifact.path, agent);
        }
        cachedToolPath = await tools.cacheDir(toolDir, agent, version);
    } else {
        tasks.setVariable('policyAgentDownloadedFrom', 'cache');
    }

    const exePath = findExecutable(cachedToolPath, agent);
    if (!exePath) {
        throw new Error(tasks.loc("PolicyAgentNotFoundInFolder", cachedToolPath));
    }

    if (!isWindows) {
        fs.chmodSync(exePath, "755");
    }

    if (cacheHit) {
        // A version cached by a possibly-earlier job on this (potentially persistent,
        // self-hosted) agent is being reused without re-running the verification this
        // job demands. Re-verify against the local integrity marker recorded when it
        // was originally downloaded and verified — see verifyCachedTool — and, when
        // no marker exists (cached before markers, or cached with verification
        // disabled), re-verify against a freshly downloaded, verified release.
        const markerVerified = await verifyCachedTool(cachedToolPath, exePath, `${agent} ${version}`);
        if (!markerVerified) {
            await reverifyUnmarkedCacheEntry(agent, downloadSource, version, cachedToolPath, exePath);
        }
    } else if (verified) {
        await writeCacheIntegrityMarker(cachedToolPath, exePath);
    }

    tasks.setVariable('policyAgentLocation', exePath);
    return exePath;
}

// --- Version resolution ---

async function resolveVersion(agent: string, downloadSource: string, inputVersion: string): Promise<string> {
    if (inputVersion.toLowerCase() !== 'latest') {
        return inputVersion;
    }

    if (downloadSource === "registry") {
        const registryUrl = tasks.getInput("registryUrl", true)!;
        const mirrorName = validateUrlPathSegment("registryMirrorName", tasks.getInput("registryMirrorName", true)! || agent);
        return resolveVersionFromRegistry(registryUrl, mirrorName);
    }

    if (agent === "sentinel") {
        return resolveLatestSentinel();
    }
    return resolveLatestOpa();
}

async function resolveLatestSentinel(): Promise<string> {
    console.log(tasks.loc("GettingLatestVersion", "Sentinel"));
    // Fail closed: if 'latest' cannot be resolved, throw rather than silently
    // installing a hardcoded stale version (a selective outage of only the version
    // endpoint must not force a silent downgrade). Matches TerraformDocsInstaller.
    let data: { current_version: string };
    try {
        data = await fetchJson<{ current_version: string }>('https://checkpoint-api.hashicorp.com/v1/check/sentinel');
    } catch (err) {
        throw new Error(`Failed to resolve the latest Sentinel version from the HashiCorp checkpoint API (${err instanceof Error ? err.message : err}). Pin an explicit 'version' instead of 'latest', or retry — refusing to silently fall back to a stale version.`);
    }
    if (!data.current_version) {
        throw new Error("HashiCorp checkpoint API returned invalid response: missing current_version");
    }
    return data.current_version;
}

async function resolveLatestOpa(): Promise<string> {
    console.log(tasks.loc("GettingLatestVersion", "OPA"));
    // Fail closed (same as resolveLatestSentinel): a request failure or malformed
    // response throws rather than silently downgrading to a pinned version.
    let data: { tag_name: string };
    try {
        data = await fetchJson<{ tag_name: string }>('https://api.github.com/repos/open-policy-agent/opa/releases/latest');
    } catch (err) {
        throw new Error(`Failed to resolve the latest OPA version from the GitHub releases API (${err instanceof Error ? err.message : err}). Pin an explicit 'version' instead of 'latest', or retry — refusing to silently fall back to a stale version.`);
    }
    if (!data.tag_name) {
        throw new Error("GitHub API returned invalid response: missing tag_name");
    }
    // tag_name is like "v1.17.1" — strip the leading "v"
    return data.tag_name.replace(/^v/, '');
}

// --- Download strategies (return the path to the downloaded artifact, and
// whether it was actually checksum-verified) ---

async function downloadArtifact(agent: string, downloadSource: string, version: string): Promise<{ path: string; verified: boolean }> {
    switch (downloadSource) {
        case "registry": {
            const registryUrl = tasks.getInput("registryUrl", true)!;
            const mirrorName = validateUrlPathSegment("registryMirrorName", tasks.getInput("registryMirrorName", true)! || agent);
            const result = await downloadFromRegistry(agent, version, registryUrl, mirrorName);
            // Strip any embedded basic-auth userinfo before persisting the source
            // into a downstream-readable pipeline variable (#586).
            tasks.setVariable('policyAgentDownloadedFrom', `registry:${redactUrlUserInfo(registryUrl)}`);
            return result;
        }
        case "mirror": {
            const mirrorBaseUrl = tasks.getInput("mirrorBaseUrl", true)!;
            const result = await downloadFromMirror(agent, version, mirrorBaseUrl);
            // Strip any embedded basic-auth userinfo before persisting the source
            // into a downstream-readable pipeline variable (#586).
            tasks.setVariable('policyAgentDownloadedFrom', `mirror:${redactUrlUserInfo(mirrorBaseUrl)}`);
            return result;
        }
        default: { // "official"
            const result = agent === "sentinel"
                ? await downloadSentinelOfficial(version)
                : await downloadOpaOfficial(version);
            tasks.setVariable('policyAgentDownloadedFrom', 'official');
            return result;
        }
    }
}

async function downloadSentinelOfficial(version: string): Promise<{ path: string; verified: boolean }> {
    const osPlatform = getPlatformString();
    const arch = getArchString();
    const zipFileName = `sentinel_${version}_${osPlatform}_${arch}.zip`;
    const downloadUrl = `https://releases.hashicorp.com/sentinel/${version}/${zipFileName}`;

    const zipPath = await downloadTo(downloadUrl, `sentinel-${version}-${uuidV4()}.zip`);

    const sha256SumsUrl = `https://releases.hashicorp.com/sentinel/${version}/sentinel_${version}_SHA256SUMS`;
    const sha256SumsContent = await fetchText(sha256SumsUrl);
    const requireGpg = getBoolInputDefaultTrue("requireGpgSignature");
    // A failed signature or checksum check DELETES the zip rather than leaving a
    // rejected — possibly tampered — artifact in the agent's temp directory (#204).
    await discardArtifactOnFailure(zipPath, async () => {
        await verifyGpgSignature(sha256SumsContent, `${sha256SumsUrl}.sig`, requireGpg);
        await verifySha256(zipPath, parseSha256(sha256SumsContent, zipFileName));
    });
    return { path: zipPath, verified: true };
}

async function downloadOpaOfficial(version: string): Promise<{ path: string; verified: boolean }> {
    const assetName = getOpaAssetName();
    const downloadUrl = `https://github.com/open-policy-agent/opa/releases/download/v${version}/${assetName}`;

    const binaryPath = await downloadTo(downloadUrl, `opa-${version}-${uuidV4()}${isWindows ? '.exe' : ''}`);

    // OPA publishes a per-asset .sha256 file containing the hex digest.
    // Accepted limitation: OPA ships no detached GPG/cosign signature like the
    // HashiCorp (Sentinel/Terraform) path, so this checksum and the binary come from
    // the same GitHub release origin — it guarantees transport integrity, not
    // authenticity against a poisoned release. requireChecksum (default true) keeps
    // the check mandatory; HTTPS + GitHub's release infrastructure is the trust root.
    const sha256Url = `${downloadUrl}.sha256`;
    const requireChecksum = getBoolInputDefaultTrue("requireChecksum");
    // Only a genuine 404 (fetchTextAllow404 returns null) means "no checksum
    // published". Any other non-2xx / network / TLS failure is fatal regardless of
    // requireChecksum, rather than being classified by matching an error string.
    const sha256Body = await fetchTextAllow404(sha256Url);
    if (sha256Body === null) {
        if (requireChecksum) {
            // Reachable release (genuine 404) withholding a required checksum is a
            // deterministic policy failure — typed so the cache-hit re-verification
            // path fails closed instead of degrading to the cached binary (#589).
            throw new VerificationFailure(`Checksum verification is required but no .sha256 is published for the OPA download (${sha256Url}).`);
        }
        tasks.warning(`SHA256 verification skipped for OPA download: no checksum file published at ${sha256Url}.`);
        return { path: binaryPath, verified: false };
    }
    await discardArtifactOnFailure(binaryPath, () => verifySha256(binaryPath, parseFirstSha256(sha256Body, assetName)));
    return { path: binaryPath, verified: true };
}

async function downloadFromRegistry(agent: string, version: string, registryUrl: string, mirrorName: string): Promise<{ path: string; verified: boolean }> {
    // registryUrl may embed basic-auth userinfo; mask it before it can reach a log
    // via infoUrl in any error/warning below (#586).
    maskOperatorUrlCredentials(registryUrl);
    const osPlatform = getPlatformString();
    const arch = getArchString();
    const infoUrl = `${registryUrl}/terraform/binaries/${mirrorName}/versions/${version}/${osPlatform}/${arch}`;

    const data = await fetchJson<{ download_url: string; sha256: string; shasums_url?: string }>(infoUrl);
    if (!data.download_url) {
        throw new Error(`Registry API returned invalid response: missing download_url from ${infoUrl}`);
    }
    // The pre-signed download_url carries a live, read-scoped storage credential in
    // its query string. tools.downloadTool logs the URL at INFO and only auto-redacts
    // Azure `sig=`, so AWS X-Amz-Signature/X-Amz-Credential/X-Amz-Security-Token and
    // GCS X-Goog-Signature/X-Goog-Credential would otherwise print unredacted on every
    // normal registry run. Register each token component as a secret FIRST -- before
    // ANY emission that can carry this URL, including the https-pin rejection below,
    // which used to interpolate the raw pre-signed URL into its message while this
    // registration still sat further down the function (#66/#98).
    const urlTokenSecrets = extractUrlTokenSecrets(data.download_url);
    for (const secret of urlTokenSecrets) {
        tasks.setSecret(secret);
    }
    // The download URL is registry-controlled and fetched outside fetchJson's HTTPS
    // guard, so pin it to HTTPS before downloading — as the mirror path already does.
    if (!data.download_url.startsWith('https://')) {
        throw new Error(tasks.loc("InsecureUrlRejected", redactUrl(data.download_url)));
    }

    // Optional opt-in host pin: a compromised registry could still point download_url
    // at an arbitrary HTTPS host, so an operator can constrain the trusted storage
    // host(s) via registryAllowedHosts. Default (empty) preserves the
    // trust-the-registry behavior.
    const allowedHosts = parseAllowedHosts(tasks.getInput("registryAllowedHosts", false));
    const initialHost = new URL(data.download_url).hostname;
    // Egress authorization for the download destination -- ONE decision
    // (assertEgressHostAllowed) applied to the initial URL here and, via
    // downloadToFile below, to every redirect hop. With an explicit allowlist
    // only the pin is enforced (an operator may deliberately pin a private,
    // air-gapped host); with none, a host that IS or RESOLVES TO a private/
    // link-local/reserved address is refused. Addresses are classified
    // numerically, so `127.1`, `2130706433`, `[::ffff:127.0.0.1]` and
    // 100.64.0.0/10 cannot walk past a dotted-quad pattern (#161). The DNS
    // step resolves at check time and does not pin the address into the
    // connection, so it is defense-in-depth against a statically-private
    // host, not a complete DNS-rebinding defense.
    await assertEgressHostAllowed(initialHost, allowedHosts, REGISTRY_EGRESS_MESSAGES);

    const ext = agent === "sentinel" ? ".zip" : (isWindows ? ".exe" : "");
    const fileName = `${agent}-${version}-${uuidV4()}${ext}`;
    let filePath: string;
    try {
        // tools.downloadTool() follows redirects with no way to re-validate or
        // disable that, so a compromised registry could return an initially
        // acceptable download_url that itself 302s to an arbitrary host --
        // bypassing an explicit registryAllowedHosts pin, or reaching the
        // private/metadata address the initial-host check just cleared
        // (#679/#729/#769). Route through the manual-redirect downloadToFile(),
        // which re-applies the SAME assertEgressHostAllowed decision on every
        // hop. The pinned and default-deny paths share one branch now: the
        // allowlist-vs-blocklist choice lives inside the helper, so it can no
        // longer be made differently for the initial host and for a hop (#161).
        const destDir = tasks.getVariable("Agent.TempDirectory") || os.tmpdir();
        filePath = path.join(destDir, fileName);
        await downloadToFile(data.download_url, filePath, DOWNLOAD_TIMEOUT_MS, hostname =>
            assertEgressHostAllowed(hostname, allowedHosts, REGISTRY_EGRESS_MESSAGES));
    } catch (exception) {
        // download_url is a pre-signed URL whose query string carries the signing
        // token; drop the whole query (redactUrl) and scrub the raw URL out of the
        // tool-lib exception text so the live credential never reaches the build
        // log via the failure message.
        const safeUrl = redactUrl(data.download_url);
        const safeMsg = scrubSecretsFromMessage(
            String(exception instanceof Error ? exception.message : exception),
            data.download_url,
            urlTokenSecrets,
        );
        throw new Error(tasks.loc("PolicyAgentDownloadFailed", safeUrl, safeMsg));
    }

    if (data.sha256) {
        await discardArtifactOnFailure(filePath, () => verifySha256(filePath, data.sha256));
        return { path: filePath, verified: true };
    } else if (getBoolInputDefaultTrue("requireChecksum")) {
        // Empty sha256 means no local integrity check is possible. Fail closed when
        // the operator requires checksum verification rather than trusting the binary.
        // Typed as VerificationFailure so the cache-hit re-verification path re-throws
        // (fail closed) instead of degrading to the cached binary (#589).
        // Deliberately NOT falling back to data.shasums_url: it is served from the same host
        // as download_url, whereas sha256 is the registry's own hash of the artifact recorded at
        // ingest from upstream. Taking the checksum from the artifact's own host would collapse
        // the two authorities and stop detecting a tampered artifact.
        throw new VerificationFailure(
            `Checksum verification is required but the registry did not provide a sha256 for ${infoUrl}.`
            + (data.shasums_url
                ? ` The registry did advertise a shasums_url for this version, so it holds the checksum but left the sha256 field empty -- a registry-side data problem, not a missing upstream checksum.`
                : ``)
            + ` Populate sha256 in the registry, or set downloadSource to "official" to install from the upstream release instead.`,
        );
    } else {
        tasks.warning(`SHA256 not provided by registry for ${infoUrl}; skipping local verification (trusting the registry's server-side verification only). Set requireChecksum to enforce a local check.`);
    }
    return { path: filePath, verified: false };
}

async function downloadFromMirror(agent: string, version: string, mirrorBaseUrl: string): Promise<{ path: string; verified: boolean }> {
    // mirrorBaseUrl may embed basic-auth userinfo; mask it before it can reach a log
    // via the rejection message or any derived download URL below (#586).
    maskOperatorUrlCredentials(mirrorBaseUrl);
    if (!mirrorBaseUrl.startsWith('https://')) {
        throw new Error(tasks.loc("InsecureUrlRejected", redactUrlUserInfo(mirrorBaseUrl)));
    }
    const osPlatform = getPlatformString();
    const arch = getArchString();

    if (agent === "sentinel") {
        const zipFileName = `sentinel_${version}_${osPlatform}_${arch}.zip`;
        const downloadUrl = `${mirrorBaseUrl}/${version}/${zipFileName}`;
        const zipPath = await downloadFromMirrorUrl(downloadUrl, `sentinel-${version}-${uuidV4()}.zip`);

        const sha256SumsUrl = `${mirrorBaseUrl}/${version}/sentinel_${version}_SHA256SUMS`;
        const verified = await verifyMirrorChecksum(zipPath, sha256SumsUrl, zipFileName);
        return { path: zipPath, verified };
    }

    const assetName = getOpaAssetName();
    const downloadUrl = `${mirrorBaseUrl}/${version}/${assetName}`;
    const binaryPath = await downloadFromMirrorUrl(downloadUrl, `opa-${version}-${uuidV4()}${isWindows ? '.exe' : ''}`);

    const requireChecksum = getBoolInputDefaultTrue("requireChecksum");
    const sha256Url = `${downloadUrl}.sha256`;
    const sha256Body = await fetchTextAllow404(sha256Url);
    if (sha256Body === null) {
        if (requireChecksum) {
            // Reachable mirror (genuine 404) withholding a required checksum is a
            // deterministic policy failure — typed so the cache-hit re-verification
            // path fails closed instead of degrading to the cached binary (#589).
            throw new VerificationFailure(`Checksum verification is required but no .sha256 is published for the mirror download (${sha256Url}).`);
        }
        tasks.warning(`SHA256 verification skipped for mirror download: no checksum file published at ${sha256Url}.`);
        return { path: binaryPath, verified: false };
    }
    await discardArtifactOnFailure(binaryPath, () => verifySha256(binaryPath, parseFirstSha256(sha256Body, assetName)));
    return { path: binaryPath, verified: true };
}

async function verifyMirrorChecksum(filePath: string, sha256SumsUrl: string, fileName: string): Promise<boolean> {
    // Sentinel-only path. requireGpgSignature (default true) governs whether the
    // mirror's SHA256SUMS must carry a valid HashiCorp GPG signature; previously the
    // mirror path checked only sha256 (which a compromised mirror can recompute), so
    // requireGpgSignature was silently inert here despite its help text implying it
    // applied to mirrors — now the .sig is verified against the pinned HashiCorp key.
    const requireChecksum = getBoolInputDefaultTrue("requireChecksum");
    const requireGpg = getBoolInputDefaultTrue("requireGpgSignature");
    const body = await fetchTextAllow404(sha256SumsUrl);
    if (body === null) {
        // A reachable mirror (genuine 404, not a transport error) withholding a
        // SHA256SUMS it is required to serve is a deterministic policy failure —
        // typed as VerificationFailure so the cache-hit re-verification path fails
        // closed rather than degrading to the cached binary (#589).
        if (requireChecksum) {
            throw new VerificationFailure(`Checksum verification is required but the mirror did not publish a SHA256SUMS file (${sha256SumsUrl}).`);
        }
        if (requireGpg) {
            throw new VerificationFailure(`GPG signature verification is required but the mirror did not publish a SHA256SUMS file to verify (${sha256SumsUrl}). Set requireGpgSignature to false for mirrors that do not serve signed checksums.`);
        }
        tasks.warning(`SHA256 verification skipped for mirror download: no SHA256SUMS published at ${sha256SumsUrl}.`);
        return false;
    }
    // The file exists: verify its GPG signature against HashiCorp's pinned key
    // (a missing .sig is fatal only when requireGpgSignature is set), then verify
    // the hash. A missing asset entry or a hash mismatch is always fatal.
    await discardArtifactOnFailure(filePath, async () => {
        await verifyGpgSignature(body, `${sha256SumsUrl}.sig`, requireGpg);
        await verifySha256(filePath, parseSha256(body, fileName));
    });
    return true;
}

// --- Helpers ---

async function downloadTo(url: string, fileName: string): Promise<string> {
    try {
        return await retryAsync(() => tools.downloadTool(url, fileName), DOWNLOAD_RETRY);
    } catch (exception) {
        // A mirror download URL can embed operator basic-auth userinfo; strip it from
        // the interpolated message (no-op for the official releases/GitHub URLs) (#586).
        throw new Error(tasks.loc("PolicyAgentDownloadFailed", redactUrlUserInfo(url), exception));
    }
}

/**
 * Mirror-only download path (#799, follow-up to #729). mirrorBaseUrl is an
 * operator-configured input (unlike the registry path's dynamically-returned
 * download_url), but a compromised/misconfigured mirror SERVICE could still
 * redirect the actual download at a private/link-local address (notably the
 * cloud metadata service). Checks the initial host up front, then re-validates
 * every redirect hop via downloadToFile() -- unlike downloadTo() above (used
 * for the official/GitHub path, left unchanged), which calls
 * tools.downloadTool() and follows redirects with no way to re-validate them,
 * the same underlying gap #729 closed for the registry path. An operator
 * running a legitimate mirror on a private/internal address (a real,
 * pre-existing use case -- the registry path's own registryAllowedHosts
 * exists for exactly this reason) can opt in via mirrorAllowedHosts,
 * mirroring the registry path's allowlist shape exactly.
 */
async function downloadFromMirrorUrl(url: string, fileName: string): Promise<string> {
    const mirrorAllowedHosts = parseAllowedHosts(tasks.getInput("mirrorAllowedHosts", false));
    const initialHost = new URL(url).hostname;
    // Egress authorization for the download destination -- ONE decision
    // (assertEgressHostAllowed) applied to the initial URL here and, via
    // downloadToFile below, to every redirect hop. With an explicit allowlist
    // only the pin is enforced (an operator may deliberately pin a private,
    // air-gapped host); with none, a host that IS or RESOLVES TO a private/
    // link-local/reserved address is refused. Addresses are classified
    // numerically, so `127.1`, `2130706433`, `[::ffff:127.0.0.1]` and
    // 100.64.0.0/10 cannot walk past a dotted-quad pattern (#161). The DNS
    // step resolves at check time and does not pin the address into the
    // connection, so it is defense-in-depth against a statically-private
    // host, not a complete DNS-rebinding defense.
    await assertEgressHostAllowed(initialHost, mirrorAllowedHosts, MIRROR_EGRESS_MESSAGES);
    const destDir = tasks.getVariable("Agent.TempDirectory") || os.tmpdir();
    const destPath = path.join(destDir, fileName);
    try {
        await downloadToFile(url, destPath, DOWNLOAD_TIMEOUT_MS, hostname =>
            assertEgressHostAllowed(hostname, mirrorAllowedHosts, MIRROR_EGRESS_MESSAGES));
    } catch (exception) {
        // A mirror download URL can embed operator basic-auth userinfo; strip it from
        // the interpolated message (#586).
        throw new Error(tasks.loc("PolicyAgentDownloadFailed", redactUrlUserInfo(url), exception));
    }
    return destPath;
}

/** Copies a raw downloaded binary into a fresh directory under its canonical name. */
function placeBinaryInDir(binaryPath: string, agent: string): string {
    const destDir = path.join(os.tmpdir(), `${agent}-${uuidV4()}`);
    fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, agent + getExecutableExtension());
    fs.copyFileSync(binaryPath, destPath);
    return destDir;
}

// NOTE: the OS/arch/checksum/exec-discovery helpers below are intentionally
// mirrored in TerraformInstallerV1 (each task bundles independently); keep the two
// copies in sync — the parseSha256 binary-mode regex especially.
export function parseSha256(sha256SumsContent: string, fileName: string): string {
    for (const line of sha256SumsContent.split('\n')) {
        // Format: "<hex-hash>  <filename>"; the optional leading "*" marks binary
        // mode (canonical regex shared with TerraformInstaller — keep in sync).
        const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
        if (match && match[2].trim() === fileName) {
            return match[1];
        }
    }
    // The checksum file was obtained but does not cover the requested asset —
    // typed as a verification failure so the cache-hit re-verification path
    // fails closed instead of degrading to "material unavailable".
    throw new VerificationFailure(`SHA256 checksum not found for ${fileName}`);
}

/**
 * Extracts the SHA256 digest for `fileName` from a single-asset .sha256 file
 * (OPA official/mirror path). OPA's real per-asset .sha256 file contains just
 * the bare hex digest with no filename, so each line is anchored to be
 * EXACTLY 64 hex characters (nothing else) — this still rejects hex characters
 * embedded in unrelated text and a truncated prefix of a longer (e.g. sha512)
 * digest, since neither is a whole-line 64-hex match. As a defensive fallback
 * (in case a registry/mirror ever serves the multi-asset "SHA256SUMS" shape
 * for this URL instead), a hex+filename line is also accepted, bound to the
 * expected asset filename via parseSha256's ^<64hex>\s+\*?<filename>$ match,
 * so a checksum present only for a different asset is still rejected.
 * Previously this matched the first bare 64-hex run ANYWHERE in the body with
 * no anchoring or filename binding at all (#834).
 */
export function parseFirstSha256(content: string, fileName: string): string {
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (/^[a-fA-F0-9]{64}$/.test(trimmed)) {
            return trimmed;
        }
    }
    return parseSha256(content, fileName);
}

export async function verifySha256(filePath: string, expectedHash: string): Promise<void> {
    const actualHash = await computeSha256Streaming(filePath);
    if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
        throw new VerificationFailure(tasks.loc("Sha256VerificationFailed", expectedHash, actualHash));
    }
    tasks.debug(`SHA256 verification passed: ${actualHash}`);
}

/**
 * Computes a file's SHA256 via a streaming read (fs.createReadStream piped into
 * the hash) instead of buffering the whole file into memory at once (#728).
 * A compromised/malicious registry or mirror serving an oversized artifact
 * would otherwise drive the agent toward memory exhaustion at this step; the
 * streaming approach keeps memory usage constant regardless of file size.
 */
async function computeSha256Streaming(filePath: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(filePath), hash);
    return hash.digest('hex');
}

async function hashFile(filePath: string): Promise<string> {
    return computeSha256Streaming(filePath);
}

/**
 * Writes a local integrity marker recording the SHA256 of the just-verified,
 * just-cached executable, so a later job's cache hit for the same tool/version can
 * re-verify it (see verifyCachedTool) without re-downloading anything. Best-effort:
 * a write failure must never fail an install that has already been verified — it
 * only means a future cache hit for this tool degrades to the pre-existing
 * trust-the-cache behavior.
 */
async function writeCacheIntegrityMarker(toolDir: string, exePath: string): Promise<void> {
    const markerPath = path.join(toolDir, CACHE_INTEGRITY_MARKER);
    // ATOMIC: write to a temp name in the SAME directory, then rename into place. A
    // plain writeFileSync interrupted mid-write -- agent disk full, job cancellation,
    // a container kill -- leaves a marker that exists and is readable but is empty or
    // truncated, and every later install of that version then compares the real digest
    // against that fragment and fails with a tampering-shaped CachedToolVerificationFailed,
    // permanently bricking the version on that agent (#198). Renaming into place means
    // a reader only ever sees a complete digest or no marker at all.
    const tempPath = `${markerPath}.${uuidV4()}.tmp`;
    try {
        fs.writeFileSync(tempPath, await hashFile(exePath), 'utf8');
        fs.renameSync(tempPath, markerPath);
    } catch (err) {
        tasks.debug(`Could not write cache integrity marker for ${toolDir}: ${err instanceof Error ? err.message : err}`);
        try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
    }
}

/**
 * On a tool-cache hit, re-verifies the cached executable against the local
 * integrity marker written when it was originally downloaded and verified. This is
 * a purely local, offline comparison (no network call), so it can never break
 * offline/air-gapped cache usage.
 *
 * - No marker (cached before this check existed, or cached by a run where checksum
 *   verification was disabled): returns false — the caller escalates to a remote
 *   re-verification against a freshly downloaded release (see
 *   reverifyUnmarkedCacheEntry), closing the cross-job trust-on-first-use gap.
 * - Marker present but MALFORMED — empty, truncated, or not 64 hex characters, i.e.
 *   an interrupted write (#198): returns false, exactly like a missing marker. An
 *   unverifiable record is not evidence of tampering; feeding the fragment to the
 *   comparison would fail every subsequent install of that version with a
 *   tampering-shaped error and send an operator down a security-incident path for
 *   what is a torn file. The marker is NOT healed here — healing happens only after
 *   the escalated re-verification actually proves the cached executable.
 * - Marker present and it matches the cached executable's current hash: passes
 *   silently, returns true.
 * - Marker present, well-formed, and it does not match: the cached executable changed
 *   since it was verified (tampering or corruption on a shared agent) — fail closed.
 *
 * Trust-boundary note: the marker lives next to the executable it protects, so an
 * attacker who can rewrite the cached binary under the agent account can rewrite
 * the marker to match. This check is defense-in-depth against corruption and
 * cross-job verification-policy mixing, not against an attacker who already has
 * write access to the agent's tool cache (who effectively owns the agent).
 */
async function verifyCachedTool(toolDir: string, exePath: string, toolLabel: string): Promise<boolean> {
    const markerPath = path.join(toolDir, CACHE_INTEGRITY_MARKER);
    if (!fs.existsSync(markerPath)) {
        tasks.debug(`Cache hit for ${toolLabel}: no stored integrity marker found (cached before this check existed, or without checksum verification).`);
        return false;
    }
    const storedHash = fs.readFileSync(markerPath, 'utf8').trim().toLowerCase();
    if (!CACHE_INTEGRITY_MARKER_PATTERN.test(storedHash)) {
        tasks.debug(`Cache hit for ${toolLabel}: the stored integrity marker is not a 64-character SHA256 digest (${storedHash.length} character(s) recorded); treating the entry as unverifiable rather than tampered.`);
        return false;
    }
    const actualHash = (await hashFile(exePath)).toLowerCase();
    if (actualHash !== storedHash) {
        throw new Error(tasks.loc("CachedToolVerificationFailed", toolLabel, storedHash, actualHash));
    }
    tasks.debug(`Cache hit for ${toolLabel}: integrity marker verified (${actualHash}).`);
    return true;
}

/**
 * #496: a cache hit with NO integrity marker means the tool was cached either
 * before markers existed or by a job that ran with checksum verification
 * disabled — the two cross-job trust gaps the issue names (a persistent agent
 * silently serving a never-verified binary to later jobs that demand full
 * verification). When this job demands verification (requireChecksum, default
 * true), re-download the release through the exact same source/verification path
 * a fresh install would use and require the cached executable to byte-match the
 * freshly verified one:
 *
 * - Source UNREACHABLE (network/DNS/TLS failure, timeout, 5xx, offline or
 *   air-gapped agent, version no longer published): degrade gracefully — warn and
 *   fall back to the pre-existing trust-the-cache behavior. Offline cache reuse
 *   keeps working; requireChecksum=false skips the attempt (and warning) entirely.
 * - Source REACHABLE but the material FAILS verification (bad GPG signature,
 *   checksum mismatch) OR the reachable source WITHHOLDS material a require-flag
 *   makes mandatory (empty registry sha256, a 404'd-but-required .sha256/SHA256SUMS
 *   or .sig) — both surface as a typed VerificationFailure: fail closed. Never fall
 *   back to the cached copy.
 * - Cached executable differs from the freshly verified release: fail closed.
 * - Match: write the integrity marker so future cache hits verify locally
 *   (offline, one-time healing of pre-existing cache entries).
 */
async function reverifyUnmarkedCacheEntry(agent: string, downloadSource: string, version: string, toolDir: string, cachedExePath: string): Promise<void> {
    const toolLabel = `${agent} ${version}`;
    if (!getBoolInputDefaultTrue("requireChecksum")) {
        tasks.debug(`Cache hit for ${toolLabel}: no stored integrity marker and requireChecksum is false; skipping remote re-verification.`);
        return;
    }
    console.log(tasks.loc("ReverifyingCachedTool", toolLabel));
    let artifact: { path: string; verified: boolean };
    try {
        // Reuses the full fresh-install strategy (same inputs, same toggles, same
        // trust roots). Under requireChecksum=true the strategies either verify or
        // throw — they never return an unverified artifact.
        artifact = await downloadArtifact(agent, downloadSource, version);
    } catch (err) {
        if (isVerificationFailure(err)) {
            throw err;
        }
        // #778: on a shared persistent agent an operator can opt into failing
        // closed rather than degrading to an unverified cache entry when a
        // required re-verification cannot reach the source. Default (false)
        // preserves the availability-first degrade-with-warning behavior that
        // keeps offline/air-gapped cache reuse working.
        if (tasks.getBoolInput("requireOnlineReverification", false)) {
            throw new Error(tasks.loc("CachedToolReverificationSourceUnreachable", toolLabel, err instanceof Error ? err.message : String(err)));
        }
        tasks.warning(tasks.loc("CachedToolReverificationUnavailable", toolLabel, err instanceof Error ? err.message : String(err)));
        return;
    } finally {
        // downloadArtifact records the source it fetched from; the executable this
        // job actually runs still comes from the cache — re-assert that.
        tasks.setVariable('policyAgentDownloadedFrom', 'cache');
    }
    let freshExePath: string;
    if (agent === "sentinel") {
        const freshDir = await tools.extractZip(artifact.path);
        freshExePath = findExecutable(freshDir, agent);
        if (!freshExePath) {
            throw new Error(tasks.loc("PolicyAgentNotFoundInFolder", freshDir));
        }
    } else {
        // OPA ships as the raw binary itself — compare it directly.
        freshExePath = artifact.path;
    }
    const freshHash = (await hashFile(freshExePath)).toLowerCase();
    const cachedHash = (await hashFile(cachedExePath)).toLowerCase();
    if (freshHash !== cachedHash) {
        throw new Error(tasks.loc("CachedToolReverificationMismatch", toolLabel, freshHash, cachedHash));
    }
    await writeCacheIntegrityMarker(toolDir, cachedExePath);
    console.log(tasks.loc("CachedToolReverified", toolLabel));
}

export function getPlatformString(): string {
    switch (os.type()) {
        case "Darwin": return "darwin";
        case "Linux": return "linux";
        case "Windows_NT": return "windows";
        default: throw new Error(tasks.loc("OperatingSystemNotSupported", os.type()));
    }
}

export function getArchString(): string {
    switch (os.arch()) {
        case "x64": return "amd64";
        case "ia32": return "386";
        case "arm64": return "arm64";
        case "arm": return "arm";
        default: throw new Error(tasks.loc("ArchitectureNotSupported", os.arch()));
    }
}

/** OPA only publishes amd64 and arm64 binaries; reject other architectures. */
export function getOpaAssetName(): string {
    const osPlatform = getPlatformString();
    const arch = getArchString();
    if (arch !== "amd64" && arch !== "arm64") {
        throw new Error(tasks.loc("ArchitectureNotSupported", `${arch} (OPA publishes only amd64 and arm64)`));
    }
    return `opa_${osPlatform}_${arch}${isWindows ? '.exe' : ''}`;
}

function findExecutable(rootFolder: string, toolName: string): string {
    const execPath = path.join(rootFolder, toolName + getExecutableExtension());
    const allPaths = tasks.find(rootFolder);
    const matchingResultFiles = tasks.match(allPaths, execPath, rootFolder);
    return matchingResultFiles[0];
}

function getExecutableExtension(): string {
    return isWindows ? ".exe" : "";
}
