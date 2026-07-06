import tasks = require('azure-pipelines-task-lib/task');
import tools = require('azure-pipelines-tool-lib/tool');
import path = require('path');
import os = require('os');
import fs = require('fs');
import crypto = require('crypto');

import { randomUUID as uuidV4 } from 'crypto';
import { fetchJson, fetchTextAllow404 } from './http-client';
import { parseAllowedHosts, isRegistryHostAllowed } from './registry-allowlist';

const toolName = "terraform-docs";
const isWindows = os.type().match(/^Win/);

/**
 * Reads a boolean input whose intended default is TRUE (fail-closed). It reads the
 * raw input rather than getBoolInput(name, false) so the default still holds on an
 * agent that does not materialize task.json defaultValues into the input env var
 * (where getBoolInput would silently return false). Mirrors TerraformInstaller's helper.
 */
function getBoolInputDefaultTrue(name: string): boolean {
  const raw = tasks.getInput(name, false);
  return raw === undefined || raw.trim() === '' ? true : raw.trim().toLowerCase() !== 'false';
}

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

  if (!cachedToolPath) {
    const archivePath = await downloadArtifact(downloadSource, version);
    // Every source serves an archive: .tar.gz on Unix, .zip on Windows.
    const toolDir = isWindows ? await tools.extractZip(archivePath) : await tools.extractTar(archivePath);
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

// --- Download strategies (return the path to the downloaded archive) ---

async function downloadArtifact(downloadSource: string, version: string): Promise<string> {
  switch (downloadSource) {
    case "registry": {
      const registryUrl = tasks.getInput("registryUrl", true)!;
      const mirrorName = tasks.getInput("registryMirrorName", true)! || toolName;
      const filePath = await downloadFromRegistry(version, registryUrl, mirrorName);
      tasks.setVariable('terraformDocsDownloadedFrom', `registry:${registryUrl}`);
      return filePath;
    }
    case "mirror": {
      const mirrorBaseUrl = tasks.getInput("mirrorBaseUrl", true)!;
      const filePath = await downloadFromMirror(version, mirrorBaseUrl);
      tasks.setVariable('terraformDocsDownloadedFrom', `mirror:${mirrorBaseUrl}`);
      return filePath;
    }
    default: { // "official"
      const filePath = await downloadOfficial(version);
      tasks.setVariable('terraformDocsDownloadedFrom', 'official');
      return filePath;
    }
  }
}

async function downloadOfficial(version: string): Promise<string> {
  const assetName = getAssetName(version);
  const downloadUrl = `https://github.com/terraform-docs/terraform-docs/releases/download/v${version}/${assetName}`;
  const archivePath = await downloadTo(downloadUrl, `terraform-docs-${version}-${uuidV4()}.${getArchiveExtension()}`);

  const sha256Url = `https://github.com/terraform-docs/terraform-docs/releases/download/v${version}/terraform-docs-v${version}.sha256sum`;
  await verifyChecksumOrSkip(archivePath, sha256Url, assetName, "official release");
  return archivePath;
}

async function downloadFromRegistry(version: string, registryUrl: string, mirrorName: string): Promise<string> {
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

  const filePath = await downloadTo(data.download_url, `terraform-docs-${version}-${uuidV4()}.${getArchiveExtension()}`);

  if (data.sha256) {
    await verifySha256(filePath, data.sha256);
  } else if (getBoolInputDefaultTrue("requireChecksum")) {
    // Empty sha256 means no local integrity check is possible. Fail closed when
    // the operator requires checksum verification rather than trusting the archive.
    throw new Error(`Checksum verification is required but the registry did not provide a sha256 for ${infoUrl}.`);
  } else {
    tasks.warning(`SHA256 not provided by registry for ${infoUrl}; skipping local verification (trusting the registry's server-side verification only). Set requireChecksum to enforce a local check.`);
  }
  return filePath;
}

async function downloadFromMirror(version: string, mirrorBaseUrl: string): Promise<string> {
  if (!mirrorBaseUrl.startsWith('https://')) {
    throw new Error(tasks.loc("InsecureUrlRejected", mirrorBaseUrl));
  }
  const assetName = getAssetName(version);
  const downloadUrl = `${mirrorBaseUrl}/${version}/${assetName}`;
  const archivePath = await downloadTo(downloadUrl, `terraform-docs-${version}-${uuidV4()}.${getArchiveExtension()}`);

  const sha256Url = `${mirrorBaseUrl}/${version}/terraform-docs-v${version}.sha256sum`;
  await verifyChecksumOrSkip(archivePath, sha256Url, assetName, "mirror");
  return archivePath;
}

/**
 * Fetches the sha256sum file, verifies the archive, and applies the requireChecksum
 * policy consistently across the official and mirror paths: when the checksum file
 * is unavailable and requireChecksum is false, warn and skip; otherwise fail closed.
 */
async function verifyChecksumOrSkip(filePath: string, sha256Url: string, assetName: string, sourceLabel: string): Promise<void> {
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
    return;
  }
  // The checksum file exists: a missing asset entry or a hash mismatch is always fatal.
  await verifySha256(filePath, parseSha256(sumsBody, assetName));
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
