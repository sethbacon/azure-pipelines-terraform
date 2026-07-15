import tasks = require('azure-pipelines-task-lib/task');
import tools = require('azure-pipelines-tool-lib/tool');
import path = require('path');
import os = require('os');
import fs = require('fs');
import crypto = require('crypto');

import { randomUUID as uuidV4 } from 'crypto';
import { fetchJson, fetchTextAllow404 } from './http-client';
import { parseAllowedHosts, isRegistryHostAllowed } from './registry-allowlist';
import { getBoolInputDefaultTrue } from './bool-input';
import { extractUrlTokenSecrets, redactUrl, scrubSecretsFromMessage } from './url-secret-redaction';

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
        // was originally downloaded and verified — see verifyCachedTool.
        verifyCachedTool(cachedToolPath, exePath, `terraform-docs ${version}`);
    } else if (verified) {
        writeCacheIntegrityMarker(cachedToolPath, exePath);
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

async function resolveVersionFromRegistry(registryUrl: string, mirrorName: string): Promise<string> {
    console.log(tasks.loc("ResolvingLatestFromRegistry", registryUrl));
    const latestUrl = `${registryUrl}/terraform/binaries/${mirrorName}/versions/latest`;
    const data = await fetchJson<{ version: string }>(latestUrl);
    if (!data.version) {
        throw new Error(`Registry API returned invalid response: missing version field from ${latestUrl}`);
    }
    console.log(tasks.loc("ResolvedVersionFromRegistry", data.version));
    return data.version;
}

// --- Download strategies (return the path to the downloaded archive, and
// whether it was actually checksum-verified) ---

async function downloadArtifact(downloadSource: string, version: string): Promise<{ path: string; verified: boolean }> {
    switch (downloadSource) {
        case "registry": {
            const registryUrl = tasks.getInput("registryUrl", true)!;
            const mirrorName = tasks.getInput("registryMirrorName", true)! || toolName;
            const result = await downloadFromRegistry(version, registryUrl, mirrorName);
            tasks.setVariable('terraformDocsDownloadedFrom', `registry:${registryUrl}`);
            return result;
        }
        case "mirror": {
            const mirrorBaseUrl = tasks.getInput("mirrorBaseUrl", true)!;
            const result = await downloadFromMirror(version, mirrorBaseUrl);
            tasks.setVariable('terraformDocsDownloadedFrom', `mirror:${mirrorBaseUrl}`);
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
    // at an arbitrary HTTPS host (tools.downloadTool follows redirects with no way to
    // disable that), so an operator can constrain the trusted storage host(s) via
    // registryAllowedHosts. Default (empty) preserves the trust-the-registry behavior.
    const allowedHosts = parseAllowedHosts(tasks.getInput("registryAllowedHosts", false));
    if (allowedHosts.length > 0) {
        const downloadHost = new URL(data.download_url).hostname;
        if (!isRegistryHostAllowed(downloadHost, allowedHosts)) {
            throw new Error(tasks.loc("RegistryDownloadHostNotAllowed", downloadHost, allowedHosts.join(', ')));
        }
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
        filePath = await tools.downloadTool(data.download_url, fileName);
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
        throw new Error(`Checksum verification is required but the registry did not provide a sha256 for ${infoUrl}.`);
    } else {
        tasks.warning(`SHA256 not provided by registry for ${infoUrl}; skipping local verification (trusting the registry's server-side verification only). Set requireChecksum to enforce a local check.`);
    }
    return { path: filePath, verified: false };
}

async function downloadFromMirror(version: string, mirrorBaseUrl: string): Promise<{ path: string; verified: boolean }> {
    if (!mirrorBaseUrl.startsWith('https://')) {
        throw new Error(tasks.loc("InsecureUrlRejected", mirrorBaseUrl));
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
            throw new Error(`Checksum verification is required but no SHA256SUMS file is published for the ${sourceLabel} download (${sha256Url}).`);
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
        throw new Error(tasks.loc("TerraformDocsDownloadFailed", url, exception));
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
    throw new Error(`SHA256 checksum not found for ${fileName}`);
}

export async function verifySha256(filePath: string, expectedHash: string): Promise<void> {
    const fileBuffer = fs.readFileSync(filePath);
    const actualHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
        throw new Error(tasks.loc("Sha256VerificationFailed", expectedHash, actualHash));
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
 *   verification was disabled): degrades to the pre-existing trust-the-cache
 *   behavior with a debug note, exactly as before this check was added.
 * - Marker present and it matches the cached executable's current hash: passes
 *   silently.
 * - Marker present but it does not match: the cached executable changed since it
 *   was verified (tampering or corruption on a shared agent) — fail closed.
 */
function verifyCachedTool(toolDir: string, exePath: string, toolLabel: string): void {
    const markerPath = path.join(toolDir, CACHE_INTEGRITY_MARKER);
    if (!fs.existsSync(markerPath)) {
        tasks.debug(`Cache hit for ${toolLabel}: no stored integrity marker found (cached before this check existed, or without checksum verification). Proceeding without re-verification.`);
        return;
    }
    const storedHash = fs.readFileSync(markerPath, 'utf8').trim().toLowerCase();
    const actualHash = hashFile(exePath).toLowerCase();
    if (actualHash !== storedHash) {
        throw new Error(tasks.loc("CachedToolVerificationFailed", toolLabel, storedHash, actualHash));
    }
    tasks.debug(`Cache hit for ${toolLabel}: integrity marker verified (${actualHash}).`);
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
