import tasks = require('azure-pipelines-task-lib/task');
import tools = require('azure-pipelines-tool-lib/tool');
import path = require('path');
import os = require('os');
import fs = require('fs');
import crypto = require('crypto');

import { randomUUID as uuidV4 } from 'crypto';
import { fetchJson, fetchText } from './http-client';
import { verifyGpgSignature } from './gpg-verifier';
import { verifyCosignSignature } from './cosign-verifier';

const terraformToolName = "terraform";
const tofuToolName = "tofu";
const isWindows = os.type().match(/^Win/);

/** Fallback version used when the HashiCorp checkpoint API is unreachable. Update periodically. */
const FALLBACK_TERRAFORM_VERSION = '1.14.8';

/** Fallback version used when the OpenTofu GitHub API is unreachable. Update periodically. */
const FALLBACK_TOFU_VERSION = '1.11.6';

/**
 * Reads a boolean input whose intended default is TRUE (fail-closed). It reads the
 * raw input rather than getBoolInput(name, false) so the default still holds on an
 * agent that does not materialize task.json defaultValues into the input env var
 * (where getBoolInput would silently return false). Mirrors the requireCosignVerification
 * handling: unset/empty -> true; any value other than "false" (case-insensitive) -> true.
 */
function getBoolInputDefaultTrue(name: string): boolean {
    const raw = tasks.getInput(name, false);
    return raw === undefined || raw.trim() === '' ? true : raw.trim().toLowerCase() !== 'false';
}

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

    // Step 3: Download, extract, and cache if not found
    if (!cachedToolPath) {
        let zipPath: string;
        switch (downloadSource) {
            case "registry": {
                const registryUrl = tasks.getInput("registryUrl", true)!;
                const mirrorName = tasks.getInput("registryMirrorName", true)! || "terraform";
                zipPath = await downloadZipFromRegistry(version, registryUrl, mirrorName);
                tasks.setVariable('terraformDownloadedFrom', `registry:${registryUrl}`);
                break;
            }
            case "mirror": {
                const mirrorBaseUrl = tasks.getInput("mirrorBaseUrl", true)!;
                zipPath = await downloadZipFromMirror(version, mirrorBaseUrl);
                tasks.setVariable('terraformDownloadedFrom', `mirror:${mirrorBaseUrl}`);
                break;
            }
            default: { // "hashicorp"
                zipPath = await downloadZipFromHashiCorp(version);
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
    try {
        const data = await fetchJson<{ current_version: string }>('https://checkpoint-api.hashicorp.com/v1/check/terraform');
        if (!data.current_version) {
            throw new Error("HashiCorp checkpoint API returned invalid response: missing current_version");
        }
        return data.current_version;
    } catch {
        tasks.warning(tasks.loc("TerraformVersionNotFound"));
        return FALLBACK_TERRAFORM_VERSION;
    }
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

async function downloadZipFromRegistry(version: string, registryUrl: string, mirrorName: string): Promise<string> {
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
    let zipPath: string;
    try {
        zipPath = await tools.downloadTool(data.download_url, fileName);
    } catch (exception) {
        throw new Error(tasks.loc("TerraformDownloadFailed", data.download_url, exception));
    }

    if (data.sha256) {
        await verifySha256(zipPath, data.sha256);
    } else if (getBoolInputDefaultTrue("requireChecksum")) {
        // Empty sha256 means no local integrity check is possible. Fail closed when
        // the operator requires checksum verification rather than trusting the binary.
        throw new Error(`Checksum verification is required but the registry did not provide a sha256 for ${infoUrl}.`);
    } else {
        tasks.warning(`SHA256 not provided by registry for ${infoUrl}; skipping local verification (trusting the registry's server-side verification only). Set requireChecksum to enforce a local check.`);
    }
    return zipPath;
}

/** Parses a comma/newline-separated registryAllowedHosts input into a normalized list. */
export function parseAllowedHosts(raw: string | undefined): string[] {
    if (!raw) {
        return [];
    }
    return raw
        .split(/[\n,]/)
        .map(h => h.trim().toLowerCase())
        .filter(h => h.length > 0);
}

/**
 * Matches a download_url hostname against the allowlist. A `*.` prefix on an
 * allowlist entry matches only its subdomains (not the bare host itself),
 * mirroring TLS wildcard-SAN semantics — useful for registry-controlled
 * storage hosts like *.s3.amazonaws.com.
 */
export function isRegistryHostAllowed(hostname: string, allowedHosts: string[]): boolean {
    const host = hostname.toLowerCase();
    return allowedHosts.some(allowed =>
        allowed.startsWith('*.') ? host.endsWith(allowed.slice(1)) : host === allowed,
    );
}

async function downloadZipFromMirror(version: string, mirrorBaseUrl: string): Promise<string> {
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

    // Attempt SHA256 verification from mirror — fail if SHA256SUMS is available but hash doesn't match
    const zipFileName = `terraform_${version}_${osPlatform}_${arch}.zip`;
    const sha256SumsUrl = `${mirrorBaseUrl}/${version}/terraform_${version}_SHA256SUMS`;
    const requireChecksum = getBoolInputDefaultTrue("requireChecksum");
    try {
        const expectedHash = await fetchExpectedSha256(sha256SumsUrl, zipFileName);
        await verifySha256(zipPath, expectedHash);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const checksumUnavailable = errorMessage.includes('SHA256 checksum not found') || errorMessage.includes('Failed to fetch');
        // A genuine hash mismatch is always fatal. An unavailable SHA256SUMS file is
        // fatal only when the user requires checksum verification; otherwise warn.
        if (checksumUnavailable && !requireChecksum) {
            tasks.warning(`SHA256 verification skipped for mirror download: ${errorMessage}`);
        } else if (checksumUnavailable) {
            throw new Error(`Checksum verification is required but the mirror did not provide a usable SHA256SUMS file (${sha256SumsUrl}): ${errorMessage}`);
        } else {
            throw error;
        }
    }

    return zipPath;
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
    throw new Error(`SHA256 checksum not found for ${zipFileName}`);
}

async function fetchExpectedSha256(sha256SumsUrl: string, zipFileName: string): Promise<string> {
    tasks.debug(`Fetching SHA256SUMS from ${sha256SumsUrl}`);
    const body = await fetchText(sha256SumsUrl);
    return parseSha256(body, zipFileName);
}

async function verifySha256(filePath: string, expectedHash: string): Promise<void> {
    const fileBuffer = fs.readFileSync(filePath);
    const actualHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
        throw new Error(tasks.loc("Sha256VerificationFailed", expectedHash, actualHash));
    }
    tasks.debug(`SHA256 verification passed: ${actualHash}`);
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
    try {
        const data = await fetchJson<{ tag_name: string }>('https://api.github.com/repos/opentofu/opentofu/releases/latest');
        if (!data.tag_name) {
            throw new Error("GitHub API returned invalid response: missing tag_name");
        }
        // tag_name is "v1.11.6" — strip the leading "v"
        return data.tag_name.replace(/^v/, '');
    } catch {
        tasks.warning(tasks.loc("TerraformVersionNotFound"));
        return FALLBACK_TOFU_VERSION;
    }
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
