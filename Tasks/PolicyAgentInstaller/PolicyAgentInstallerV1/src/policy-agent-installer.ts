import tasks = require('azure-pipelines-task-lib/task');
import tools = require('azure-pipelines-tool-lib/tool');
import path = require('path');
import os = require('os');
import fs = require('fs');
import crypto = require('crypto');

import { randomUUID as uuidV4 } from 'crypto';
import { fetchJson, fetchText, fetchTextAllow404, downloadToFile, DOWNLOAD_TIMEOUT_MS } from './http-client';
import { parseAllowedHosts, isRegistryHostAllowed } from './registry-allowlist';
import { getBoolInputDefaultTrue } from './bool-input';
import { verifyGpgSignature } from './gpg-verifier';
import { extractUrlTokenSecrets, redactUrl, scrubSecretsFromMessage, extractUrlUserInfoSecrets, redactUrlUserInfo } from './url-secret-redaction';
import { VerificationFailure, isVerificationFailure } from './verification-failure';

const isWindows = os.type().match(/^Win/);

/**
 * setSecret() any basic-auth userinfo embedded in an operator-supplied
 * registry/mirror URL so the agent masks it everywhere the URL (or a URL derived
 * from it) might be echoed — pipeline variables, console output, error messages
 * (#586). Idempotent; call at the earliest use of each operator URL. Pair with
 * redactUrlUserInfo() to structurally strip the credential from any value stored
 * or displayed (setSecret only masks logs, not a persisted variable's value).
 */
function maskOperatorUrlCredentials(url: string): void {
    for (const secret of extractUrlUserInfoSecrets(url)) {
        tasks.setSecret(secret);
    }
}

// File name of the local, per-cached-tool-directory integrity marker written after
// a verified download (see writeCacheIntegrityMarker / verifyCachedTool below).
const CACHE_INTEGRITY_MARKER = ".installer-verified.sha256";

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
        const markerVerified = verifyCachedTool(cachedToolPath, exePath, `${agent} ${version}`);
        if (!markerVerified) {
            await reverifyUnmarkedCacheEntry(agent, downloadSource, version, cachedToolPath, exePath);
        }
    } else if (verified) {
        writeCacheIntegrityMarker(cachedToolPath, exePath);
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
        const mirrorName = tasks.getInput("registryMirrorName", true)! || agent;
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

async function resolveVersionFromRegistry(registryUrl: string, mirrorName: string): Promise<string> {
    maskOperatorUrlCredentials(registryUrl);
    console.log(tasks.loc("ResolvingLatestFromRegistry", redactUrlUserInfo(registryUrl)));
    const latestUrl = `${registryUrl}/terraform/binaries/${mirrorName}/versions/latest`;
    const data = await fetchJson<{ version: string }>(latestUrl);
    if (!data.version) {
        throw new Error(`Registry API returned invalid response: missing version field from ${latestUrl}`);
    }
    console.log(tasks.loc("ResolvedVersionFromRegistry", data.version));
    return data.version;
}

// --- Download strategies (return the path to the downloaded artifact, and
// whether it was actually checksum-verified) ---

async function downloadArtifact(agent: string, downloadSource: string, version: string): Promise<{ path: string; verified: boolean }> {
    switch (downloadSource) {
        case "registry": {
            const registryUrl = tasks.getInput("registryUrl", true)!;
            const mirrorName = tasks.getInput("registryMirrorName", true)! || agent;
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
    await verifyGpgSignature(sha256SumsContent, `${sha256SumsUrl}.sig`, requireGpg);

    const expectedHash = parseSha256(sha256SumsContent, zipFileName);
    await verifySha256(zipPath, expectedHash);
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
    await verifySha256(binaryPath, parseFirstSha256(sha256Body));
    return { path: binaryPath, verified: true };
}

async function downloadFromRegistry(agent: string, version: string, registryUrl: string, mirrorName: string): Promise<{ path: string; verified: boolean }> {
    // registryUrl may embed basic-auth userinfo; mask it before it can reach a log
    // via infoUrl in any error/warning below (#586).
    maskOperatorUrlCredentials(registryUrl);
    const osPlatform = getPlatformString();
    const arch = getArchString();
    const infoUrl = `${registryUrl}/terraform/binaries/${mirrorName}/versions/${version}/${osPlatform}/${arch}`;

    const data = await fetchJson<{ download_url: string; sha256: string }>(infoUrl);
    if (!data.download_url) {
        throw new Error(`Registry API returned invalid response: missing download_url from ${infoUrl}`);
    }
    // The download URL is registry-controlled and fetched outside fetchJson's HTTPS
    // guard, so pin it to HTTPS before downloading — as the mirror path already does.
    if (!data.download_url.startsWith('https://')) {
        throw new Error(tasks.loc("InsecureUrlRejected", data.download_url));
    }

    // Optional opt-in host pin: a compromised registry could still point download_url
    // at an arbitrary HTTPS host, so an operator can constrain the trusted storage
    // host(s) via registryAllowedHosts. Default (empty) preserves the
    // trust-the-registry behavior.
    const allowedHosts = parseAllowedHosts(tasks.getInput("registryAllowedHosts", false));
    if (allowedHosts.length > 0) {
        // Fail fast, before any temp-path resolution or network activity, when
        // the registry's own advertised download_url host is already
        // disallowed. downloadToFile() below re-validates this same host (and
        // every redirect hop) again as defense in depth (#679), but this
        // upfront check keeps the common case (registry itself is fine, only
        // a redirect might misbehave) cheap and matches the original
        // synchronous rejection behavior exactly.
        const initialHost = new URL(data.download_url).hostname;
        if (!isRegistryHostAllowed(initialHost, allowedHosts)) {
            throw new Error(tasks.loc("RegistryDownloadHostNotAllowed", initialHost, allowedHosts.join(', ')));
        }
    }

    const ext = agent === "sentinel" ? ".zip" : (isWindows ? ".exe" : "");
    const fileName = `${agent}-${version}-${uuidV4()}${ext}`;
    // The pre-signed download_url carries a live, read-scoped storage credential in
    // its query string. tools.downloadTool logs the URL at INFO and only auto-redacts
    // Azure `sig=`, so AWS X-Amz-Signature/X-Amz-Credential/X-Amz-Security-Token and
    // GCS X-Goog-Signature/X-Goog-Credential would otherwise print unredacted on every
    // normal registry run. Register each token component as a secret FIRST so the
    // agent masks it in tool-lib's log line (and in any failure message).
    const urlTokenSecrets = extractUrlTokenSecrets(data.download_url);
    for (const secret of urlTokenSecrets) {
        tasks.setSecret(secret);
    }
    let filePath: string;
    try {
        if (allowedHosts.length > 0) {
            // tools.downloadTool() follows redirects with no way to re-validate
            // or disable that, so a compromised registry could return an
            // allowlisted download_url that itself 302s to an arbitrary host,
            // bypassing the pin entirely. Route through the manual-redirect
            // downloadToFile() instead, which re-checks EVERY hop against
            // allowedHosts (#679) -- only when the operator actually opted into
            // the pin, so the default (no allowlist) path is unchanged.
            const destDir = tasks.getVariable("Agent.TempDirectory") || os.tmpdir();
            filePath = path.join(destDir, fileName);
            await downloadToFile(data.download_url, filePath, DOWNLOAD_TIMEOUT_MS, (hostname) => {
                if (!isRegistryHostAllowed(hostname, allowedHosts)) {
                    throw new Error(tasks.loc("RegistryDownloadHostNotAllowed", hostname, allowedHosts.join(', ')));
                }
            });
        } else {
            filePath = await tools.downloadTool(data.download_url, fileName);
        }
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
        await verifySha256(filePath, data.sha256);
        return { path: filePath, verified: true };
    } else if (getBoolInputDefaultTrue("requireChecksum")) {
        // Empty sha256 means no local integrity check is possible. Fail closed when
        // the operator requires checksum verification rather than trusting the binary.
        // Typed as VerificationFailure so the cache-hit re-verification path re-throws
        // (fail closed) instead of degrading to the cached binary (#589).
        throw new VerificationFailure(`Checksum verification is required but the registry did not provide a sha256 for ${infoUrl}.`);
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
        const zipPath = await downloadTo(downloadUrl, `sentinel-${version}-${uuidV4()}.zip`);

        const sha256SumsUrl = `${mirrorBaseUrl}/${version}/sentinel_${version}_SHA256SUMS`;
        const verified = await verifyMirrorChecksum(zipPath, sha256SumsUrl, zipFileName);
        return { path: zipPath, verified };
    }

    const assetName = getOpaAssetName();
    const downloadUrl = `${mirrorBaseUrl}/${version}/${assetName}`;
    const binaryPath = await downloadTo(downloadUrl, `opa-${version}-${uuidV4()}${isWindows ? '.exe' : ''}`);

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
    await verifySha256(binaryPath, parseFirstSha256(sha256Body));
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
    await verifyGpgSignature(body, `${sha256SumsUrl}.sig`, requireGpg);
    await verifySha256(filePath, parseSha256(body, fileName));
    return true;
}

// --- Helpers ---

async function downloadTo(url: string, fileName: string): Promise<string> {
    try {
        return await tools.downloadTool(url, fileName);
    } catch (exception) {
        // A mirror download URL can embed operator basic-auth userinfo; strip it from
        // the interpolated message (no-op for the official releases/GitHub URLs) (#586).
        throw new Error(tasks.loc("PolicyAgentDownloadFailed", redactUrlUserInfo(url), exception));
    }
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

/** Extracts the first 64-hex digest from a single-asset .sha256 file. */
export function parseFirstSha256(content: string): string {
    const match = content.match(/[a-fA-F0-9]{64}/);
    if (!match) {
        throw new VerificationFailure("SHA256 checksum not found in .sha256 file");
    }
    return match[0];
}

export async function verifySha256(filePath: string, expectedHash: string): Promise<void> {
    const fileBuffer = fs.readFileSync(filePath);
    const actualHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
        throw new VerificationFailure(tasks.loc("Sha256VerificationFailed", expectedHash, actualHash));
    }
    tasks.debug(`SHA256 verification passed: ${actualHash}`);
}

function hashFile(filePath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Writes a local integrity marker recording the SHA256 of the just-verified,
 * just-cached executable, so a later job's cache hit for the same tool/version can
 * re-verify it (see verifyCachedTool) without re-downloading anything. Best-effort:
 * a write failure must never fail an install that has already been verified — it
 * only means a future cache hit for this tool degrades to the pre-existing
 * trust-the-cache behavior.
 */
function writeCacheIntegrityMarker(toolDir: string, exePath: string): void {
    try {
        fs.writeFileSync(path.join(toolDir, CACHE_INTEGRITY_MARKER), hashFile(exePath), 'utf8');
    } catch (err) {
        tasks.debug(`Could not write cache integrity marker for ${toolDir}: ${err instanceof Error ? err.message : err}`);
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
 * - Marker present and it matches the cached executable's current hash: passes
 *   silently, returns true.
 * - Marker present but it does not match: the cached executable changed since it
 *   was verified (tampering or corruption on a shared agent) — fail closed.
 *
 * Trust-boundary note: the marker lives next to the executable it protects, so an
 * attacker who can rewrite the cached binary under the agent account can rewrite
 * the marker to match. This check is defense-in-depth against corruption and
 * cross-job verification-policy mixing, not against an attacker who already has
 * write access to the agent's tool cache (who effectively owns the agent).
 */
function verifyCachedTool(toolDir: string, exePath: string, toolLabel: string): boolean {
    const markerPath = path.join(toolDir, CACHE_INTEGRITY_MARKER);
    if (!fs.existsSync(markerPath)) {
        tasks.debug(`Cache hit for ${toolLabel}: no stored integrity marker found (cached before this check existed, or without checksum verification).`);
        return false;
    }
    const storedHash = fs.readFileSync(markerPath, 'utf8').trim().toLowerCase();
    const actualHash = hashFile(exePath).toLowerCase();
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
    const freshHash = hashFile(freshExePath).toLowerCase();
    const cachedHash = hashFile(cachedExePath).toLowerCase();
    if (freshHash !== cachedHash) {
        throw new Error(tasks.loc("CachedToolReverificationMismatch", toolLabel, freshHash, cachedHash));
    }
    writeCacheIntegrityMarker(toolDir, cachedExePath);
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
