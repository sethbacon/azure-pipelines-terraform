import tasks = require('azure-pipelines-task-lib/task');
import tools = require('azure-pipelines-tool-lib/tool');
import path = require('path');
import os = require('os');
import fs = require('fs');
import crypto = require('crypto');

import { randomUUID as uuidV4 } from 'crypto';
import { fetchJson, fetchText, fetchTextAllow404 } from './http-client';
import { parseAllowedHosts, isRegistryHostAllowed } from './registry-allowlist';
import { getBoolInputDefaultTrue } from './bool-input';
import { verifyGpgSignature } from './gpg-verifier';
import { verifyCosignSignature } from './cosign-verifier';
import { extractUrlTokenSecrets, redactUrl, scrubSecretsFromMessage } from './url-secret-redaction';
import { VerificationFailure, isVerificationFailure } from './verification-failure';

const terraformToolName = "terraform";
const tofuToolName = "tofu";
const isWindows = os.type().match(/^Win/);

// File name of the local, per-cached-tool-directory integrity marker written after
// a verified download (see writeCacheIntegrityMarker / verifyCachedTool below).
const CACHE_INTEGRITY_MARKER = ".installer-verified.sha256";

export async function downloadTerraform(inputVersion: string): Promise<string> {
    const binary = tasks.getInput("binary") || "terraform";

    if (binary === "tofu") {
        return downloadTofu(inputVersion);
    }

    const downloadSource = tasks.getInput("downloadSource") || "hashicorp";

    // Step 1: Resolve version string (may require an API call for 'latest')
    let resolvedVersion: string;
    switch (downloadSource) {
        case "registry": {
            const registryUrl = tasks.getInput("registryUrl", true)!;
            const mirrorName = tasks.getInput("registryMirrorName", true)! || "terraform";
            resolvedVersion = await resolveVersionFromRegistry(inputVersion, registryUrl, mirrorName);
            break;
        }
        default: // "hashicorp" and "mirror" both use HashiCorp checkpoint for 'latest'
            resolvedVersion = await resolveVersionFromHashiCorp(inputVersion);
    }

    const version = tools.cleanVersion(resolvedVersion);
    if (!version) {
        throw new Error(tasks.loc("InputVersionNotValidSemanticVersion", resolvedVersion));
    }

    // Step 2: Check tool cache — skip download entirely if already present
    let cachedToolPath = tools.findLocalTool(terraformToolName, version);
    const cacheHit = !!cachedToolPath;

    // Step 3: Download, extract, and cache if not found
    let verified = false;
    if (!cachedToolPath) {
        let zipPath: string;
        switch (downloadSource) {
            case "registry": {
                const registryUrl = tasks.getInput("registryUrl", true)!;
                const mirrorName = tasks.getInput("registryMirrorName", true)! || "terraform";
                const result = await downloadZipFromRegistry(version, registryUrl, mirrorName);
                zipPath = result.zipPath;
                verified = result.verified;
                tasks.setVariable('terraformDownloadedFrom', `registry:${registryUrl}`);
                break;
            }
            case "mirror": {
                const mirrorBaseUrl = tasks.getInput("mirrorBaseUrl", true)!;
                const result = await downloadZipFromMirror(version, mirrorBaseUrl);
                zipPath = result.zipPath;
                verified = result.verified;
                tasks.setVariable('terraformDownloadedFrom', `mirror:${mirrorBaseUrl}`);
                break;
            }
            default: { // "hashicorp"
                zipPath = await downloadZipFromHashiCorp(version);
                verified = true;
                tasks.setVariable('terraformDownloadedFrom', 'hashicorp');
            }
        }

        const terraformUnzippedPath = await tools.extractZip(zipPath);
        cachedToolPath = await tools.cacheDir(terraformUnzippedPath, terraformToolName, version);
    } else {
        tasks.setVariable('terraformDownloadedFrom', 'cache');
    }

    const terraformPath = findTerraformExecutable(cachedToolPath);
    if (!terraformPath) {
        throw new Error(tasks.loc("TerraformNotFoundInFolder", cachedToolPath));
    }

    if (!isWindows) {
        fs.chmodSync(terraformPath, "755");
    }

    if (cacheHit) {
        // A version cached by a possibly-earlier job on this (potentially persistent,
        // self-hosted) agent is being reused without re-running the verification this
        // job demands. Re-verify against the local integrity marker recorded when it
        // was originally downloaded and verified — see verifyCachedTool — and, when
        // no marker exists (cached before markers, or cached with verification
        // disabled), re-verify against a freshly downloaded, verified release.
        const markerVerified = verifyCachedTool(cachedToolPath, terraformPath, `terraform ${version}`);
        if (!markerVerified) {
            await reverifyUnmarkedCacheEntry(
                `terraform ${version}`,
                cachedToolPath,
                terraformPath,
                () => downloadVerifiedZipForReverify(downloadSource, version),
                findTerraformExecutable,
            );
        }
    } else if (verified) {
        writeCacheIntegrityMarker(cachedToolPath, terraformPath);
    }

    // PipelineTerraformTask locates the binary via tasks.which() (a PATH lookup),
    // not the terraformLocation variable, so the installed directory must be on
    // PATH for the rest of the job — matching the convention of other
    // azure-pipelines-tool-lib-based installers.
    tools.prependPath(path.dirname(terraformPath));
    tasks.setVariable('terraformLocation', terraformPath);
    return terraformPath;
}

// --- Version resolution ---

async function resolveVersionFromHashiCorp(inputVersion: string): Promise<string> {
    if (inputVersion.toLowerCase() !== 'latest') {
        return inputVersion;
    }
    console.log(tasks.loc("GettingLatestTerraformVersion"));
    // Fail closed: if 'latest' cannot be resolved (network/timeout/5xx, already
    // retried by fetchJson, or a malformed response), throw rather than silently
    // installing a hardcoded stale version. A selective outage of only the version
    // endpoint must not force a silent downgrade to a since-superseded release.
    // (Matches TerraformDocsInstaller's fail-closed 'latest' resolution.)
    let data: { current_version: string };
    try {
        data = await fetchJson<{ current_version: string }>('https://checkpoint-api.hashicorp.com/v1/check/terraform');
    } catch (err) {
        throw new Error(`Failed to resolve the latest Terraform version from the HashiCorp checkpoint API (${err instanceof Error ? err.message : err}). Pin an explicit 'version' instead of 'latest', or retry — refusing to silently fall back to a stale version.`);
    }
    if (!data.current_version) {
        throw new Error("HashiCorp checkpoint API returned invalid response: missing current_version");
    }
    return data.current_version;
}

async function resolveVersionFromRegistry(inputVersion: string, registryUrl: string, mirrorName: string): Promise<string> {
    if (inputVersion.toLowerCase() !== 'latest') {
        return inputVersion;
    }
    console.log(tasks.loc("ResolvingLatestFromRegistry", registryUrl));
    const latestUrl = `${registryUrl}/terraform/binaries/${mirrorName}/versions/latest`;
    const data = await fetchJson<{ version: string }>(latestUrl);
    if (!data.version) {
        throw new Error(`Registry API returned invalid response: missing version field from ${latestUrl}`);
    }
    console.log(tasks.loc("ResolvedVersionFromRegistry", data.version));
    return data.version;
}

// --- Download strategies ---

async function downloadZipFromHashiCorp(version: string): Promise<string> {
    const downloadUrl = getHashiCorpDownloadUrl(version);
    const fileName = `${terraformToolName}-${version}-${uuidV4()}.zip`;
    let zipPath: string;
    try {
        zipPath = await tools.downloadTool(downloadUrl, fileName);
    } catch (exception) {
        throw new Error(tasks.loc("TerraformDownloadFailed", downloadUrl, exception));
    }

    const osPlatform = getPlatformString();
    const arch = getArchString();
    const zipFileName = `terraform_${version}_${osPlatform}_${arch}.zip`;
    const sha256SumsUrl = `https://releases.hashicorp.com/terraform/${version}/terraform_${version}_SHA256SUMS`;
    const sha256SumsSigUrl = `${sha256SumsUrl}.sig`;

    const sha256SumsContent = await fetchText(sha256SumsUrl);
    const requireGpg = getBoolInputDefaultTrue("requireGpgSignature");
    await verifyGpgSignature(sha256SumsContent, sha256SumsSigUrl, requireGpg);

    const expectedHash = parseSha256(sha256SumsContent, zipFileName);
    await verifySha256(zipPath, expectedHash);

    return zipPath;
}

async function downloadZipFromRegistry(version: string, registryUrl: string, mirrorName: string): Promise<{ zipPath: string; verified: boolean }> {
    const osPlatform = getPlatformString();
    const arch = getArchString();
    const infoUrl = `${registryUrl}/terraform/binaries/${mirrorName}/versions/${version}/${osPlatform}/${arch}`;

    const data = await fetchJson<{ download_url: string; sha256: string }>(infoUrl);
    if (!data.download_url) {
        throw new Error(`Registry API returned invalid response: missing download_url from ${infoUrl}`);
    }
    // data.download_url = pre-signed storage URL (15-minute TTL)
    // data.sha256       = hex SHA256 of the zip (may be empty if registry verified server-side)
    // The download URL is registry-controlled and fetched outside fetchJson's HTTPS
    // guard, so pin it to HTTPS before downloading — as the mirror path already does.
    if (!data.download_url.startsWith('https://')) {
        throw new Error(tasks.loc("InsecureUrlRejected", data.download_url));
    }

    // Optional opt-in host pin: a compromised registry could still point
    // download_url at an arbitrary HTTPS host (and tools.downloadTool follows
    // redirects with no way to disable that), so an operator who wants to
    // constrain the trusted storage host(s) can set registryAllowedHosts.
    // Default (empty) preserves the existing trust-the-registry behavior.
    const allowedHosts = parseAllowedHosts(tasks.getInput("registryAllowedHosts", false));
    if (allowedHosts.length > 0) {
        const downloadHost = new URL(data.download_url).hostname;
        if (!isRegistryHostAllowed(downloadHost, allowedHosts)) {
            throw new Error(tasks.loc("RegistryDownloadHostNotAllowed", downloadHost, allowedHosts.join(', ')));
        }
    }

    const fileName = `${terraformToolName}-${version}-${uuidV4()}.zip`;
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
    let zipPath: string;
    try {
        zipPath = await tools.downloadTool(data.download_url, fileName);
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
        throw new Error(tasks.loc("TerraformDownloadFailed", safeUrl, safeMsg));
    }

    if (data.sha256) {
        await verifySha256(zipPath, data.sha256);
        return { zipPath, verified: true };
    } else if (getBoolInputDefaultTrue("requireChecksum")) {
        // Empty sha256 means no local integrity check is possible. Fail closed when
        // the operator requires checksum verification rather than trusting the binary.
        throw new Error(`Checksum verification is required but the registry did not provide a sha256 for ${infoUrl}.`);
    } else {
        tasks.warning(`SHA256 not provided by registry for ${infoUrl}; skipping local verification (trusting the registry's server-side verification only). Set requireChecksum to enforce a local check.`);
    }
    return { zipPath, verified: false };
}

async function downloadZipFromMirror(version: string, mirrorBaseUrl: string): Promise<{ zipPath: string; verified: boolean }> {
    if (!mirrorBaseUrl.startsWith('https://')) {
        throw new Error(tasks.loc("InsecureUrlRejected", mirrorBaseUrl));
    }
    const osPlatform = getPlatformString();
    const arch = getArchString();
    // Mirror must serve files at the same path structure as releases.hashicorp.com/terraform
    const downloadUrl = `${mirrorBaseUrl}/${version}/terraform_${version}_${osPlatform}_${arch}.zip`;

    const fileName = `${terraformToolName}-${version}-${uuidV4()}.zip`;
    let zipPath: string;
    try {
        zipPath = await tools.downloadTool(downloadUrl, fileName);
    } catch (exception) {
        throw new Error(tasks.loc("TerraformDownloadFailed", downloadUrl, exception));
    }

    // Verify the mirror download. requireGpgSignature (default true) governs whether
    // the SHA256SUMS must carry a valid HashiCorp GPG signature; requireChecksum
    // (default true) governs whether a SHA256SUMS must be present at all. Previously
    // the mirror path checked only sha256 (which a compromised mirror can recompute),
    // so requireGpgSignature was silently inert here despite its help text implying it
    // applied to mirrors — now the .sig is verified against the pinned HashiCorp key.
    const zipFileName = `terraform_${version}_${osPlatform}_${arch}.zip`;
    const sha256SumsUrl = `${mirrorBaseUrl}/${version}/terraform_${version}_SHA256SUMS`;
    const sha256SumsSigUrl = `${sha256SumsUrl}.sig`;
    const requireChecksum = getBoolInputDefaultTrue("requireChecksum");
    const requireGpg = getBoolInputDefaultTrue("requireGpgSignature");
    // Only a genuine 404 (fetchTextAllow404 returns null) means "no SHA256SUMS
    // published". Any other non-2xx / network / TLS failure is fatal regardless of
    // requireChecksum, rather than being classified by matching an error string.
    const sumsBody = await fetchTextAllow404(sha256SumsUrl);
    if (sumsBody === null) {
        if (requireChecksum) {
            throw new Error(`Checksum verification is required but the mirror did not publish a SHA256SUMS file (${sha256SumsUrl}).`);
        }
        if (requireGpg) {
            throw new Error(`GPG signature verification is required but the mirror did not publish a SHA256SUMS file to verify (${sha256SumsUrl}). Set requireGpgSignature to false for mirrors that do not serve signed checksums.`);
        }
        tasks.warning(`SHA256 verification skipped for mirror download: no SHA256SUMS published at ${sha256SumsUrl}.`);
        return { zipPath, verified: false };
    }

    // The SHA256SUMS exists: verify its GPG signature against HashiCorp's pinned
    // key (a missing .sig is fatal only when requireGpgSignature is set), then
    // verify the zip's hash. A missing asset entry or a hash mismatch is fatal.
    await verifyGpgSignature(sumsBody, sha256SumsSigUrl, requireGpg);
    await verifySha256(zipPath, parseSha256(sumsBody, zipFileName));
    return { zipPath, verified: true };
}

// --- Helpers ---

// NOTE: the OS/arch/checksum/exec-discovery helpers below are intentionally
// mirrored in PolicyAgentInstallerV1 (each task bundles independently); keep the two
// copies in sync — the parseSha256 binary-mode regex especially.
function parseSha256(sha256SumsContent: string, zipFileName: string): string {
    const lines = sha256SumsContent.split('\n');
    for (const line of lines) {
        // Format: "<hex-hash>  <filename>"; the optional leading "*" marks
        // binary mode (canonical regex shared with PolicyAgentInstaller).
        const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
        if (match && match[2].trim() === zipFileName) {
            tasks.debug(`Found SHA256 for ${zipFileName}: ${match[1]}`);
            return match[1];
        }
    }
    // The checksum file was obtained but does not cover the requested asset —
    // typed as a verification failure so the cache-hit re-verification path
    // fails closed instead of degrading to "material unavailable".
    throw new VerificationFailure(`SHA256 checksum not found for ${zipFileName}`);
}

async function verifySha256(filePath: string, expectedHash: string): Promise<void> {
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
 * - Release material unavailable (network/DNS failure, offline or air-gapped
 *   agent, version no longer published): degrade gracefully — warn and fall back
 *   to the pre-existing trust-the-cache behavior. Offline cache reuse keeps
 *   working; requireChecksum=false skips the attempt (and the warning) entirely.
 * - Material obtained but FAILS verification (bad GPG/cosign signature, checksum
 *   mismatch — see VerificationFailure): fail closed. The source is actively
 *   serving material that does not verify; never fall back to the cached copy.
 * - Cached executable differs from the freshly verified release: fail closed.
 * - Match: write the integrity marker so future cache hits verify locally
 *   (offline, one-time healing of pre-existing cache entries).
 */
async function reverifyUnmarkedCacheEntry(
    toolLabel: string,
    toolDir: string,
    cachedExePath: string,
    downloadVerifiedZip: () => Promise<string>,
    findExe: (rootFolder: string) => string,
): Promise<void> {
    if (!getBoolInputDefaultTrue("requireChecksum")) {
        tasks.debug(`Cache hit for ${toolLabel}: no stored integrity marker and requireChecksum is false; skipping remote re-verification.`);
        return;
    }
    console.log(tasks.loc("ReverifyingCachedTool", toolLabel));
    let zipPath: string;
    try {
        zipPath = await downloadVerifiedZip();
    } catch (err) {
        if (isVerificationFailure(err)) {
            throw err;
        }
        tasks.warning(tasks.loc("CachedToolReverificationUnavailable", toolLabel, err instanceof Error ? err.message : String(err)));
        return;
    }
    const freshDir = await tools.extractZip(zipPath);
    const freshExePath = findExe(freshDir);
    if (!freshExePath) {
        throw new Error(tasks.loc("TerraformNotFoundInFolder", freshDir));
    }
    const freshHash = hashFile(freshExePath).toLowerCase();
    const cachedHash = hashFile(cachedExePath).toLowerCase();
    if (freshHash !== cachedHash) {
        throw new Error(tasks.loc("CachedToolReverificationMismatch", toolLabel, freshHash, cachedHash));
    }
    writeCacheIntegrityMarker(toolDir, cachedExePath);
    console.log(tasks.loc("CachedToolReverified", toolLabel));
}

/**
 * Re-runs the configured source's download + verification exactly as a fresh
 * install would (same inputs, same toggles, same trust roots) and returns the
 * verified zip. Used only by the cache-hit re-verification path; the caller
 * gates on requireChecksum=true, under which the registry/mirror strategies
 * either verify or throw — they never return an unverified zip.
 */
async function downloadVerifiedZipForReverify(downloadSource: string, version: string): Promise<string> {
    switch (downloadSource) {
        case "registry": {
            const registryUrl = tasks.getInput("registryUrl", true)!;
            const mirrorName = tasks.getInput("registryMirrorName", true)! || "terraform";
            return (await downloadZipFromRegistry(version, registryUrl, mirrorName)).zipPath;
        }
        case "mirror": {
            const mirrorBaseUrl = tasks.getInput("mirrorBaseUrl", true)!;
            return (await downloadZipFromMirror(version, mirrorBaseUrl)).zipPath;
        }
        default: // "hashicorp"
            return downloadZipFromHashiCorp(version);
    }
}

function getPlatformString(): string {
    switch (os.type()) {
        case "Darwin": return "darwin";
        case "Linux": return "linux";
        case "Windows_NT": return "windows";
        default: throw new Error(tasks.loc("OperatingSystemNotSupported", os.type()));
    }
}

function getArchString(): string {
    switch (os.arch()) {
        case "x64": return "amd64";
        case "ia32": return "386";
        case "arm64": return "arm64";
        case "arm": return "arm";
        default: throw new Error(tasks.loc("ArchitectureNotSupported", os.arch()));
    }
}

function getHashiCorpDownloadUrl(version: string): string {
    return `https://releases.hashicorp.com/terraform/${version}/terraform_${version}_${getPlatformString()}_${getArchString()}.zip`;
}

function findTerraformExecutable(rootFolder: string): string {
    return findExecutable(rootFolder, terraformToolName);
}

function findExecutable(rootFolder: string, toolName: string): string {
    const execPath = path.join(rootFolder, toolName + getExecutableExtension());
    const allPaths = tasks.find(rootFolder);
    const matchingResultFiles = tasks.match(allPaths, execPath, rootFolder);
    return matchingResultFiles[0];
}

function getExecutableExtension(): string {
    if (isWindows) {
        return ".exe";
    }
    return "";
}

// --- OpenTofu ---

async function downloadTofu(inputVersion: string): Promise<string> {
    const resolvedVersion = await resolveVersionFromOpenTofu(inputVersion);
    const version = tools.cleanVersion(resolvedVersion);
    if (!version) {
        throw new Error(tasks.loc("InputVersionNotValidSemanticVersion", resolvedVersion));
    }

    let cachedToolPath = tools.findLocalTool(tofuToolName, version);
    const cacheHit = !!cachedToolPath;

    if (!cachedToolPath) {
        const zipPath = await downloadZipFromOpenTofu(version);
        const unzippedPath = await tools.extractZip(zipPath);
        cachedToolPath = await tools.cacheDir(unzippedPath, tofuToolName, version);
        tasks.setVariable('terraformDownloadedFrom', 'opentofu');
    } else {
        tasks.setVariable('terraformDownloadedFrom', 'cache');
    }

    const tofuPath = findExecutable(cachedToolPath, tofuToolName);
    if (!tofuPath) {
        throw new Error(tasks.loc("TerraformNotFoundInFolder", cachedToolPath));
    }

    if (!isWindows) {
        fs.chmodSync(tofuPath, "755");
    }

    if (cacheHit) {
        // See the matching comment in downloadTerraform.
        const markerVerified = verifyCachedTool(cachedToolPath, tofuPath, `tofu ${version}`);
        if (!markerVerified) {
            await reverifyUnmarkedCacheEntry(
                `tofu ${version}`,
                cachedToolPath,
                tofuPath,
                () => downloadZipFromOpenTofu(version),
                (rootFolder) => findExecutable(rootFolder, tofuToolName),
            );
        }
    } else {
        // downloadZipFromOpenTofu always verifies the zip's SHA256 unconditionally
        // (cosign only gates authenticity of the SHA256SUMS itself).
        writeCacheIntegrityMarker(cachedToolPath, tofuPath);
    }

    // See the matching comment in downloadTerraform: PipelineTerraformTask finds
    // the binary via PATH, not the terraformLocation variable.
    tools.prependPath(path.dirname(tofuPath));
    tasks.setVariable('terraformLocation', tofuPath);
    return tofuPath;
}

async function resolveVersionFromOpenTofu(inputVersion: string): Promise<string> {
    if (inputVersion.toLowerCase() !== 'latest') {
        return inputVersion;
    }
    console.log(tasks.loc("GettingLatestOpenTofuVersion"));
    // Fail closed (same as resolveVersionFromHashiCorp): a request failure or a
    // malformed response throws rather than silently downgrading to a pinned version.
    let data: { tag_name: string };
    try {
        data = await fetchJson<{ tag_name: string }>('https://api.github.com/repos/opentofu/opentofu/releases/latest');
    } catch (err) {
        throw new Error(`Failed to resolve the latest OpenTofu version from the GitHub releases API (${err instanceof Error ? err.message : err}). Pin an explicit 'version' instead of 'latest', or retry — refusing to silently fall back to a stale version.`);
    }
    if (!data.tag_name) {
        throw new Error("GitHub API returned invalid response: missing tag_name");
    }
    // tag_name is "v1.11.6" — strip the leading "v"
    return data.tag_name.replace(/^v/, '');
}

async function downloadZipFromOpenTofu(version: string): Promise<string> {
    const osPlatform = getPlatformString();
    const arch = getArchString();
    const zipFileName = `tofu_${version}_${osPlatform}_${arch}.zip`;
    const downloadUrl = `https://github.com/opentofu/opentofu/releases/download/v${version}/${zipFileName}`;

    const fileName = `${tofuToolName}-${version}-${uuidV4()}.zip`;
    let zipPath: string;
    try {
        zipPath = await tools.downloadTool(downloadUrl, fileName);
    } catch (exception) {
        throw new Error(tasks.loc("TerraformDownloadFailed", downloadUrl, exception));
    }

    // SHA256 verification via SHA256SUMS file
    const sha256SumsUrl = `https://github.com/opentofu/opentofu/releases/download/v${version}/tofu_${version}_SHA256SUMS`;
    const sha256SumsContent = await fetchText(sha256SumsUrl);

    // Cosign verification of SHA256SUMS. Fail closed: require a verified signature
    // unless the operator has explicitly opted out (requireCosignVerification=false).
    // getBoolInputDefaultTrue reads the raw input so the default stays fail-closed
    // even on an agent that does not materialize task.json input defaults.
    const requireCosign = getBoolInputDefaultTrue("requireCosignVerification");
    const signatureUrl = `${sha256SumsUrl}.sig`;
    const certificateUrl = `${sha256SumsUrl}.pem`;
    await verifyCosignSignature(sha256SumsContent, signatureUrl, certificateUrl, requireCosign);

    const expectedHash = parseSha256(sha256SumsContent, zipFileName);
    await verifySha256(zipPath, expectedHash);

    return zipPath;
}
