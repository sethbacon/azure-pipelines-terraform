import tasks = require('azure-pipelines-task-lib/task');
import tools = require('azure-pipelines-tool-lib/tool');
import path = require('path');
import os = require('os');
import fs = require('fs');
import crypto = require('crypto');
import { pipeline } from 'stream/promises';

import { randomUUID as uuidV4 } from 'crypto';
import { fetchJson, fetchTextAllow404, downloadToFile, DOWNLOAD_TIMEOUT_MS } from './http-client';
import { parseAllowedHosts, isRegistryHostAllowed, isPrivateOrLinkLocalHost, resolvesToPrivateOrLinkLocalAddress } from './registry-allowlist';
import { getBoolInputDefaultTrue } from './bool-input';
import { extractUrlTokenSecrets, redactUrl, scrubSecretsFromMessage, redactUrlUserInfo } from './url-secret-redaction';
import { VerificationFailure, isVerificationFailure } from './verification-failure';
import { maskOperatorUrlCredentials, resolveVersionFromRegistry } from './registry-version-resolver';

const toolName = "terraform-docs";
const isWindows = os.type().match(/^Win/);

// File name of the local, per-cached-tool-directory integrity marker written after
// a verified download (see writeCacheIntegrityMarker / verifyCachedTool below).
const CACHE_INTEGRITY_MARKER = ".installer-verified.sha256";

/**
 * Downloads the requested terraform-docs version, verifies its SHA256 checksum,
 * caches it via the tool cache, and returns the path to the executable.
 *
 * terraform-docs ships as a .tar.gz (Unix) / .zip (Windows) archive on GitHub
 * releases, each release carrying a single terraform-docs-v{version}.sha256sum
 * file that lists every asset. There is no detached GPG/cosign signature (unlike
 * the HashiCorp binaries), so — like OPA — the checksum and the archive share the
 * same GitHub release origin: this guarantees transport integrity, not authenticity
 * against a poisoned release, with HTTPS + GitHub's release infrastructure as the
 * trust root. A private registry and a custom mirror are also supported for
 * air-gapped or controlled supply chains.
 */
export async function downloadTerraformDocs(inputVersion: string): Promise<string> {
    const downloadSource = tasks.getInput("downloadSource") || "official";

    const resolvedVersion = await resolveVersion(downloadSource, inputVersion);
    const version = tools.cleanVersion(resolvedVersion);
    if (!version) {
        throw new Error(tasks.loc("InputVersionNotValidSemanticVersion", resolvedVersion));
    }

    let cachedToolPath = tools.findLocalTool(toolName, version);
    const cacheHit = !!cachedToolPath;

    let verified = false;
    if (!cachedToolPath) {
        const artifact = await downloadArtifact(downloadSource, version);
        verified = artifact.verified;
        // Every source serves an archive: .tar.gz on Unix, .zip on Windows.
        const toolDir = isWindows ? await tools.extractZip(artifact.path) : await tools.extractTar(artifact.path);
        cachedToolPath = await tools.cacheDir(toolDir, toolName, version);
    } else {
        tasks.setVariable('terraformDocsDownloadedFrom', 'cache');
    }

    const exePath = findExecutable(cachedToolPath, toolName);
    if (!exePath) {
        throw new Error(tasks.loc("TerraformDocsNotFoundInFolder", cachedToolPath));
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
        const markerVerified = await verifyCachedTool(cachedToolPath, exePath, `terraform-docs ${version}`);
        if (!markerVerified) {
            await reverifyUnmarkedCacheEntry(downloadSource, version, cachedToolPath, exePath);
        }
    } else if (verified) {
        await writeCacheIntegrityMarker(cachedToolPath, exePath);
    }

    tasks.setVariable('terraformDocsLocation', exePath);
    return exePath;
}

// --- Version resolution ---

async function resolveVersion(downloadSource: string, inputVersion: string): Promise<string> {
    if (inputVersion.toLowerCase() !== 'latest') {
        return inputVersion;
    }

    if (downloadSource === "registry") {
        const registryUrl = tasks.getInput("registryUrl", true)!;
        const mirrorName = tasks.getInput("registryMirrorName", true)! || toolName;
        return resolveVersionFromRegistry(registryUrl, mirrorName);
    }

    return resolveLatestFromGitHub();
}

async function resolveLatestFromGitHub(): Promise<string> {
    console.log(tasks.loc("GettingLatestVersion"));
    let data: { tag_name: string };
    try {
        data = await fetchJson<{ tag_name: string }>('https://api.github.com/repos/terraform-docs/terraform-docs/releases/latest');
    } catch (error) {
        // Fail closed: a caller who explicitly asked for 'latest' (often precisely for
        // security currency) must not be silently handed a stale pinned version on an
        // upstream outage. Surface the failure so they can pin an explicit version or retry.
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Unable to resolve the latest terraform-docs version from GitHub (${message}). Specify an explicit version instead of 'latest', or retry when the GitHub releases API is reachable.`);
    }
    if (!data.tag_name) {
        throw new Error("GitHub API returned invalid response: missing tag_name");
    }
    // tag_name is like "v0.24.0" — strip the leading "v".
    return data.tag_name.replace(/^v/, '');
}

// --- Download strategies (return the path to the downloaded archive, and
// whether it was actually checksum-verified) ---

async function downloadArtifact(downloadSource: string, version: string): Promise<{ path: string; verified: boolean }> {
    switch (downloadSource) {
        case "registry": {
            const registryUrl = tasks.getInput("registryUrl", true)!;
            const mirrorName = tasks.getInput("registryMirrorName", true)! || toolName;
            const result = await downloadFromRegistry(version, registryUrl, mirrorName);
            // Strip any embedded basic-auth userinfo before persisting the source
            // into a downstream-readable pipeline variable (#586).
            tasks.setVariable('terraformDocsDownloadedFrom', `registry:${redactUrlUserInfo(registryUrl)}`);
            return result;
        }
        case "mirror": {
            const mirrorBaseUrl = tasks.getInput("mirrorBaseUrl", true)!;
            const result = await downloadFromMirror(version, mirrorBaseUrl);
            // Strip any embedded basic-auth userinfo before persisting the source
            // into a downstream-readable pipeline variable (#586).
            tasks.setVariable('terraformDocsDownloadedFrom', `mirror:${redactUrlUserInfo(mirrorBaseUrl)}`);
            return result;
        }
        default: { // "official"
            const result = await downloadOfficial(version);
            tasks.setVariable('terraformDocsDownloadedFrom', 'official');
            return result;
        }
    }
}

async function downloadOfficial(version: string): Promise<{ path: string; verified: boolean }> {
    const assetName = getAssetName(version);
    const downloadUrl = `https://github.com/terraform-docs/terraform-docs/releases/download/v${version}/${assetName}`;
    const archivePath = await downloadTo(downloadUrl, `terraform-docs-${version}-${uuidV4()}.${getArchiveExtension()}`);

    const sha256Url = `https://github.com/terraform-docs/terraform-docs/releases/download/v${version}/terraform-docs-v${version}.sha256sum`;
    const verified = await verifyChecksumOrSkip(archivePath, sha256Url, assetName, "official release");
    return { path: archivePath, verified };
}

async function downloadFromRegistry(version: string, registryUrl: string, mirrorName: string): Promise<{ path: string; verified: boolean }> {
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
    const initialHost = new URL(data.download_url).hostname;
    if (allowedHosts.length > 0) {
        // Fail fast, before any temp-path resolution or network activity, when
        // the registry's own advertised download_url host is already
        // disallowed. downloadToFile() below re-validates this same host (and
        // every redirect hop) again as defense in depth (#679), but this
        // upfront check keeps the common case (registry itself is fine, only
        // a redirect might misbehave) cheap and matches the original
        // synchronous rejection behavior exactly.
        if (!isRegistryHostAllowed(initialHost, allowedHosts)) {
            throw new Error(tasks.loc("RegistryDownloadHostNotAllowed", initialHost, allowedHosts.join(', ')));
        }
    } else if (isPrivateOrLinkLocalHost(initialHost) || await resolvesToPrivateOrLinkLocalAddress(initialHost)) {
        // Baseline protection even on the DEFAULT (no explicit allowlist) path
        // (#729): a compromised or misconfigured registry pointing download_url
        // straight at a loopback/link-local/private address (notably the cloud
        // metadata service, conventionally at 169.254.169.254) is refused
        // without requiring the operator to opt into registryAllowedHosts.
        // Does not apply once an explicit allowlist is configured, so an
        // operator who deliberately points at a private-IP mirror for an
        // air-gapped environment is unaffected. Also resolves the host and
        // re-checks every returned address (resolvesToPrivateOrLinkLocalAddress),
        // so a DNS name that simply resolves to a private/metadata address is
        // refused too, not just a literal IP (#769). This resolves at check
        // time and does not pin the IP into the download connection, so it is
        // defense-in-depth against the static case, not a complete defense
        // against active DNS rebinding.
        throw new Error(tasks.loc("RegistryDownloadHostIsPrivate", initialHost));
    }

    const fileName = `terraform-docs-${version}-${uuidV4()}.${getArchiveExtension()}`;
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
            // Baseline redirect-hop protection on the DEFAULT (no explicit allowlist)
            // path (#729 follow-up): tools.downloadTool() follows redirects with no
            // way to re-validate them, so a compromised/misconfigured registry could
            // return an initially-safe download_url that itself 302s to a
            // private/link-local address (notably the cloud metadata service) -- the
            // initial-host check above only covers the first hop. Route through the
            // same manual-redirect downloadToFile() used on the allowlist path,
            // re-checking every hop against isPrivateOrLinkLocalHost. This is a
            // synchronous literal-IP/hostname check (unlike the initial-host check,
            // it does not also perform a DNS lookup per hop), so a redirect Location
            // that is a DNS name resolving to a private address is not caught here --
            // only a literal private/link-local host/IP is.
            const destDir = tasks.getVariable("Agent.TempDirectory") || os.tmpdir();
            filePath = path.join(destDir, fileName);
            await downloadToFile(data.download_url, filePath, DOWNLOAD_TIMEOUT_MS, (hostname) => {
                if (isPrivateOrLinkLocalHost(hostname)) {
                    throw new Error(tasks.loc("RegistryDownloadHostIsPrivate", hostname));
                }
            });
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
        throw new Error(tasks.loc("TerraformDocsDownloadFailed", safeUrl, safeMsg));
    }

    if (data.sha256) {
        await verifySha256(filePath, data.sha256);
        return { path: filePath, verified: true };
    } else if (getBoolInputDefaultTrue("requireChecksum")) {
        // Empty sha256 means no local integrity check is possible. Fail closed when
        // the operator requires checksum verification rather than trusting the archive.
        // Typed as VerificationFailure so the cache-hit re-verification path re-throws
        // (fail closed) instead of degrading to the cached archive (#589).
        throw new VerificationFailure(`Checksum verification is required but the registry did not provide a sha256 for ${infoUrl}.`);
    } else {
        tasks.warning(`SHA256 not provided by registry for ${infoUrl}; skipping local verification (trusting the registry's server-side verification only). Set requireChecksum to enforce a local check.`);
    }
    return { path: filePath, verified: false };
}

async function downloadFromMirror(version: string, mirrorBaseUrl: string): Promise<{ path: string; verified: boolean }> {
    // mirrorBaseUrl may embed basic-auth userinfo; mask it before it can reach a log
    // via the rejection message or any derived download URL below (#586).
    maskOperatorUrlCredentials(mirrorBaseUrl);
    if (!mirrorBaseUrl.startsWith('https://')) {
        throw new Error(tasks.loc("InsecureUrlRejected", redactUrlUserInfo(mirrorBaseUrl)));
    }
    const assetName = getAssetName(version);
    const downloadUrl = `${mirrorBaseUrl}/${version}/${assetName}`;
    const archivePath = await downloadTo(downloadUrl, `terraform-docs-${version}-${uuidV4()}.${getArchiveExtension()}`);

    const sha256Url = `${mirrorBaseUrl}/${version}/terraform-docs-v${version}.sha256sum`;
    const verified = await verifyChecksumOrSkip(archivePath, sha256Url, assetName, "mirror");
    return { path: archivePath, verified };
}

/**
 * Fetches the sha256sum file, verifies the archive, and applies the requireChecksum
 * policy consistently across the official and mirror paths: when the checksum file
 * is unavailable and requireChecksum is false, warn and skip; otherwise fail closed.
 * Returns whether the archive was actually checksum-verified.
 */
async function verifyChecksumOrSkip(filePath: string, sha256Url: string, assetName: string, sourceLabel: string): Promise<boolean> {
    const requireChecksum = getBoolInputDefaultTrue("requireChecksum");
    // Only a genuine 404 (fetchTextAllow404 returns null) counts as "no checksum file
    // published". Any other non-2xx / network / TLS failure propagates fatally,
    // regardless of requireChecksum, instead of being classified by error-string.
    const sumsBody = await fetchTextAllow404(sha256Url);
    if (sumsBody === null) {
        if (requireChecksum) {
            // Reachable source (genuine 404) withholding a required checksum is a
            // deterministic policy failure — typed so the cache-hit re-verification
            // path fails closed instead of degrading to the cached archive (#589).
            throw new VerificationFailure(`Checksum verification is required but no SHA256SUMS file is published for the ${sourceLabel} download (${sha256Url}).`);
        }
        tasks.warning(`SHA256 verification skipped for ${sourceLabel} download: no checksum file published at ${sha256Url}.`);
        return false;
    }
    // The checksum file exists: a missing asset entry or a hash mismatch is always fatal.
    await verifySha256(filePath, parseSha256(sumsBody, assetName));
    return true;
}

// --- Helpers ---

async function downloadTo(url: string, fileName: string): Promise<string> {
    try {
        return await tools.downloadTool(url, fileName);
    } catch (exception) {
        // A mirror download URL can embed operator basic-auth userinfo; strip it from
        // the interpolated message (no-op for the official GitHub release URLs) (#586).
        throw new Error(tasks.loc("TerraformDocsDownloadFailed", redactUrlUserInfo(url), exception));
    }
}

export function parseSha256(sha256SumsContent: string, fileName: string): string {
    for (const line of sha256SumsContent.split('\n')) {
        // Format: "<hex-hash>  <filename>"; the optional leading "*" marks binary mode.
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
    try {
        fs.writeFileSync(path.join(toolDir, CACHE_INTEGRITY_MARKER), await hashFile(exePath), 'utf8');
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
async function verifyCachedTool(toolDir: string, exePath: string, toolLabel: string): Promise<boolean> {
    const markerPath = path.join(toolDir, CACHE_INTEGRITY_MARKER);
    if (!fs.existsSync(markerPath)) {
        tasks.debug(`Cache hit for ${toolLabel}: no stored integrity marker found (cached before this check existed, or without checksum verification).`);
        return false;
    }
    const storedHash = fs.readFileSync(markerPath, 'utf8').trim().toLowerCase();
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
 * - Source REACHABLE but the material FAILS verification (checksum mismatch) OR the
 *   reachable source WITHHOLDS a checksum requireChecksum makes mandatory (empty
 *   registry sha256, a 404'd-but-required sha256sum) — both surface as a typed
 *   VerificationFailure: fail closed. Never fall back to the cached copy.
 * - Cached executable differs from the freshly verified release: fail closed.
 * - Match: write the integrity marker so future cache hits verify locally
 *   (offline, one-time healing of pre-existing cache entries).
 */
async function reverifyUnmarkedCacheEntry(downloadSource: string, version: string, toolDir: string, cachedExePath: string): Promise<void> {
    const toolLabel = `terraform-docs ${version}`;
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
        artifact = await downloadArtifact(downloadSource, version);
    } catch (err) {
        if (isVerificationFailure(err)) {
            throw err;
        }
        tasks.warning(tasks.loc("CachedToolReverificationUnavailable", toolLabel, err instanceof Error ? err.message : String(err)));
        return;
    } finally {
        // downloadArtifact records the source it fetched from; the executable this
        // job actually runs still comes from the cache — re-assert that.
        tasks.setVariable('terraformDocsDownloadedFrom', 'cache');
    }
    const freshDir = isWindows ? await tools.extractZip(artifact.path) : await tools.extractTar(artifact.path);
    const freshExePath = findExecutable(freshDir, toolName);
    if (!freshExePath) {
        throw new Error(tasks.loc("TerraformDocsNotFoundInFolder", freshDir));
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

/** terraform-docs publishes amd64, arm64 and arm builds only (no 386). */
export function getArchString(): string {
    switch (os.arch()) {
        case "x64": return "amd64";
        case "arm64": return "arm64";
        case "arm": return "arm";
        default: throw new Error(tasks.loc("ArchitectureNotSupported", os.arch()));
    }
}

/** terraform-docs archives are .zip on Windows, .tar.gz everywhere else. */
export function getArchiveExtension(): string {
    return isWindows ? "zip" : "tar.gz";
}

/** Builds the release asset file name for the current platform/architecture. */
export function getAssetName(version: string): string {
    return `terraform-docs-v${version}-${getPlatformString()}-${getArchString()}.${getArchiveExtension()}`;
}

function findExecutable(rootFolder: string, exeName: string): string {
    const execPath = path.join(rootFolder, exeName + (isWindows ? ".exe" : ""));
    const allPaths = tasks.find(rootFolder);
    const matchingResultFiles = tasks.match(allPaths, execPath, rootFolder);
    return matchingResultFiles[0];
}
