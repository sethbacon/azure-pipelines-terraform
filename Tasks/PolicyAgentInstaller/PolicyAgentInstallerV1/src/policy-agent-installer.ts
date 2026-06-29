import tasks = require('azure-pipelines-task-lib/task');
import tools = require('azure-pipelines-tool-lib/tool');
import path = require('path');
import os = require('os');
import fs = require('fs');
import crypto = require('crypto');

import { randomUUID as uuidV4 } from 'crypto';
import { fetchJson, fetchText } from './http-client';
import { verifyGpgSignature } from './gpg-verifier';

const isWindows = os.type().match(/^Win/);

/** Fallback versions used when the upstream "latest" lookup is unreachable. Update periodically. */
const FALLBACK_SENTINEL_VERSION = '0.40.0';
const FALLBACK_OPA_VERSION = '1.17.1';

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

    if (!cachedToolPath) {
        const artifactPath = await downloadArtifact(agent, downloadSource, version);

        let toolDir: string;
        if (agent === "sentinel") {
            // Sentinel is distributed as a zip archive.
            toolDir = await tools.extractZip(artifactPath);
        } else {
            // OPA is distributed as a single raw binary; place it in its own dir
            // under the canonical executable name so the tool cache can host it.
            toolDir = placeBinaryInDir(artifactPath, agent);
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
    try {
        const data = await fetchJson<{ current_version: string }>('https://checkpoint-api.hashicorp.com/v1/check/sentinel');
        if (!data.current_version) {
            throw new Error("HashiCorp checkpoint API returned invalid response: missing current_version");
        }
        return data.current_version;
    } catch {
        tasks.warning(tasks.loc("VersionNotFound"));
        return FALLBACK_SENTINEL_VERSION;
    }
}

async function resolveLatestOpa(): Promise<string> {
    console.log(tasks.loc("GettingLatestVersion", "OPA"));
    try {
        const data = await fetchJson<{ tag_name: string }>('https://api.github.com/repos/open-policy-agent/opa/releases/latest');
        if (!data.tag_name) {
            throw new Error("GitHub API returned invalid response: missing tag_name");
        }
        // tag_name is like "v1.17.1" — strip the leading "v"
        return data.tag_name.replace(/^v/, '');
    } catch {
        tasks.warning(tasks.loc("VersionNotFound"));
        return FALLBACK_OPA_VERSION;
    }
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

// --- Download strategies (return the path to the downloaded artifact) ---

async function downloadArtifact(agent: string, downloadSource: string, version: string): Promise<string> {
    switch (downloadSource) {
        case "registry": {
            const registryUrl = tasks.getInput("registryUrl", true)!;
            const mirrorName = tasks.getInput("registryMirrorName", true)! || agent;
            const filePath = await downloadFromRegistry(agent, version, registryUrl, mirrorName);
            tasks.setVariable('policyAgentDownloadedFrom', `registry:${registryUrl}`);
            return filePath;
        }
        case "mirror": {
            const mirrorBaseUrl = tasks.getInput("mirrorBaseUrl", true)!;
            const filePath = await downloadFromMirror(agent, version, mirrorBaseUrl);
            tasks.setVariable('policyAgentDownloadedFrom', `mirror:${mirrorBaseUrl}`);
            return filePath;
        }
        default: { // "official"
            const filePath = agent === "sentinel"
                ? await downloadSentinelOfficial(version)
                : await downloadOpaOfficial(version);
            tasks.setVariable('policyAgentDownloadedFrom', 'official');
            return filePath;
        }
    }
}

async function downloadSentinelOfficial(version: string): Promise<string> {
    const osPlatform = getPlatformString();
    const arch = getArchString();
    const zipFileName = `sentinel_${version}_${osPlatform}_${arch}.zip`;
    const downloadUrl = `https://releases.hashicorp.com/sentinel/${version}/${zipFileName}`;

    const zipPath = await downloadTo(downloadUrl, `sentinel-${version}-${uuidV4()}.zip`);

    const sha256SumsUrl = `https://releases.hashicorp.com/sentinel/${version}/sentinel_${version}_SHA256SUMS`;
    const sha256SumsContent = await fetchText(sha256SumsUrl);
    const requireGpg = tasks.getBoolInput("requireGpgSignature", false);
    await verifyGpgSignature(sha256SumsContent, `${sha256SumsUrl}.sig`, requireGpg);

    const expectedHash = parseSha256(sha256SumsContent, zipFileName);
    await verifySha256(zipPath, expectedHash);
    return zipPath;
}

async function downloadOpaOfficial(version: string): Promise<string> {
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
    const requireChecksum = tasks.getBoolInput("requireChecksum", false);
    try {
        const sha256Body = await fetchText(sha256Url);
        const expectedHash = parseFirstSha256(sha256Body);
        await verifySha256(binaryPath, expectedHash);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const checksumUnavailable = message.includes('SHA256 checksum not found') || message.includes('Failed to fetch');
        if (checksumUnavailable && !requireChecksum) {
            tasks.warning(`SHA256 verification skipped for OPA download: ${message}`);
        } else {
            throw error;
        }
    }
    return binaryPath;
}

async function downloadFromRegistry(agent: string, version: string, registryUrl: string, mirrorName: string): Promise<string> {
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

    const ext = agent === "sentinel" ? ".zip" : (isWindows ? ".exe" : "");
    const filePath = await downloadTo(data.download_url, `${agent}-${version}-${uuidV4()}${ext}`);

    if (data.sha256) {
        await verifySha256(filePath, data.sha256);
    } else if (tasks.getBoolInput("requireChecksum", false)) {
        // Empty sha256 means no local integrity check is possible. Fail closed when
        // the operator requires checksum verification rather than trusting the binary.
        throw new Error(`Checksum verification is required but the registry did not provide a sha256 for ${infoUrl}.`);
    } else {
        tasks.warning(`SHA256 not provided by registry for ${infoUrl}; skipping local verification (trusting the registry's server-side verification only). Set requireChecksum to enforce a local check.`);
    }
    return filePath;
}

async function downloadFromMirror(agent: string, version: string, mirrorBaseUrl: string): Promise<string> {
    if (!mirrorBaseUrl.startsWith('https://')) {
        throw new Error(tasks.loc("InsecureUrlRejected", mirrorBaseUrl));
    }
    const osPlatform = getPlatformString();
    const arch = getArchString();

    if (agent === "sentinel") {
        const zipFileName = `sentinel_${version}_${osPlatform}_${arch}.zip`;
        const downloadUrl = `${mirrorBaseUrl}/${version}/${zipFileName}`;
        const zipPath = await downloadTo(downloadUrl, `sentinel-${version}-${uuidV4()}.zip`);

        const sha256SumsUrl = `${mirrorBaseUrl}/${version}/sentinel_${version}_SHA256SUMS`;
        await verifyMirrorChecksum(zipPath, sha256SumsUrl, zipFileName);
        return zipPath;
    }

    const assetName = getOpaAssetName();
    const downloadUrl = `${mirrorBaseUrl}/${version}/${assetName}`;
    const binaryPath = await downloadTo(downloadUrl, `opa-${version}-${uuidV4()}${isWindows ? '.exe' : ''}`);

    const requireChecksum = tasks.getBoolInput("requireChecksum", false);
    try {
        const sha256Body = await fetchText(`${downloadUrl}.sha256`);
        await verifySha256(binaryPath, parseFirstSha256(sha256Body));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const checksumUnavailable = message.includes('SHA256 checksum not found') || message.includes('Failed to fetch');
        if (checksumUnavailable && !requireChecksum) {
            tasks.warning(`SHA256 verification skipped for mirror download: ${message}`);
        } else {
            throw error;
        }
    }
    return binaryPath;
}

async function verifyMirrorChecksum(filePath: string, sha256SumsUrl: string, fileName: string): Promise<void> {
    const requireChecksum = tasks.getBoolInput("requireChecksum", false);
    try {
        const body = await fetchText(sha256SumsUrl);
        await verifySha256(filePath, parseSha256(body, fileName));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const checksumUnavailable = message.includes('SHA256 checksum not found') || message.includes('Failed to fetch');
        if (checksumUnavailable && !requireChecksum) {
            tasks.warning(`SHA256 verification skipped for mirror download: ${message}`);
        } else if (checksumUnavailable) {
            throw new Error(`Checksum verification is required but the mirror did not provide a usable SHA256SUMS file (${sha256SumsUrl}): ${message}`);
        } else {
            throw error;
        }
    }
}

// --- Helpers ---

async function downloadTo(url: string, fileName: string): Promise<string> {
    try {
        return await tools.downloadTool(url, fileName);
    } catch (exception) {
        throw new Error(tasks.loc("PolicyAgentDownloadFailed", url, exception));
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
    throw new Error(`SHA256 checksum not found for ${fileName}`);
}

/** Extracts the first 64-hex digest from a single-asset .sha256 file. */
export function parseFirstSha256(content: string): string {
    const match = content.match(/[a-fA-F0-9]{64}/);
    if (!match) {
        throw new Error("SHA256 checksum not found in .sha256 file");
    }
    return match[0];
}

export async function verifySha256(filePath: string, expectedHash: string): Promise<void> {
    const fileBuffer = fs.readFileSync(filePath);
    const actualHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
        throw new Error(tasks.loc("Sha256VerificationFailed", expectedHash, actualHash));
    }
    tasks.debug(`SHA256 verification passed: ${actualHash}`);
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
