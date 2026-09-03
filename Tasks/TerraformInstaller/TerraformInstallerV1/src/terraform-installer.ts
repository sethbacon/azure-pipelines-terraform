import tasks = require('azure-pipelines-task-lib/task');
import tools = require('azure-pipelines-tool-lib/tool');
import path = require('path');
import os = require('os');
import fs = require('fs');

import { randomUUID as uuidV4 } from 'crypto';
import { fetchJson, fetchText, fetchTextAllow404, downloadToFile, DOWNLOAD_TIMEOUT_MS } from './http-client';
import { getBoolInputDefaultTrue } from '@4cloudguru/pipeline-task-ado';
import { verifyGpgSignature } from './gpg-verifier';
import { verifyCosignSignature } from './cosign-verifier';
import { retryAsync, parseAllowedHosts, assertEgressHostAllowed, EgressHostMessages, validateUrlPathSegment, VerificationFailure, isVerificationFailure, discardArtifactOnFailure, extractUrlTokenSecrets, redactUrl, scrubSecretsFromMessage, redactUrlUserInfo } from '@4cloudguru/pipeline-task-core';
import { maskOperatorUrlCredentials, resolveVersionFromRegistry } from './registry-version-resolver';
import { getPlatformString, hashFile, verifySha256, writeCacheIntegrityMarker, verifyCachedTool } from './tool-integrity';
// Re-exported so this module's public surface is unchanged by the move to the
// shared copy: existing importers and tests keep resolving them here (#996).
export { getPlatformString, verifySha256, writeCacheIntegrityMarker, verifyCachedTool } from './tool-integrity';

// The package does not import the ADO task lib, so the discard's log line is wired here.
const discardLog = { debug: (message: string) => tasks.debug(message) };

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


const terraformToolName = "terraform";
const tofuToolName = "tofu";
const isWindows = os.type().match(/^Win/);

/**
 * Bounded retry for the binary download itself (#78): tools.downloadTool performs a
 * single HTTP GET with no retry of its own, so a single transient blip during the
 * largest and slowest fetch of the install failed the whole task. The metadata and
 * checksum fetches already retry inside http-client.ts. Verification is deliberately
 * OUTSIDE the retry -- a checksum or signature failure is deterministic and must
 * never be repeated.
 */
const DOWNLOAD_RETRY = { retries: 2, baseDelayMs: 250, maxBackoffMs: 2000 };

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
            const mirrorName = validateUrlPathSegment("registryMirrorName", tasks.getInput("registryMirrorName", true)! || "terraform");
            resolvedVersion = inputVersion.toLowerCase() !== 'latest'
                ? inputVersion
                : await resolveVersionFromRegistry(registryUrl, mirrorName, hostname =>
                    assertEgressHostAllowed(hostname, parseAllowedHosts(tasks.getInput("registryAllowedHosts", false)), REGISTRY_EGRESS_MESSAGES));
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
                const mirrorName = validateUrlPathSegment("registryMirrorName", tasks.getInput("registryMirrorName", true)! || "terraform");
                const result = await downloadZipFromRegistry(version, registryUrl, mirrorName);
                zipPath = result.zipPath;
                verified = result.verified;
                // Strip any embedded basic-auth userinfo before persisting the source
                // into a downstream-readable pipeline variable (#586).
                tasks.setVariable('terraformDownloadedFrom', `registry:${redactUrlUserInfo(registryUrl)}`);
                break;
            }
            case "mirror": {
                const mirrorBaseUrl = tasks.getInput("mirrorBaseUrl", true)!;
                const result = await downloadZipFromMirror(version, mirrorBaseUrl);
                zipPath = result.zipPath;
                verified = result.verified;
                // Strip any embedded basic-auth userinfo before persisting the source
                // into a downstream-readable pipeline variable (#586).
                tasks.setVariable('terraformDownloadedFrom', `mirror:${redactUrlUserInfo(mirrorBaseUrl)}`);
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
        //
        // forceOnlineReverification (default false) escalates even on a marker PASS:
        // the marker lives beside the executable it protects (see verifyCachedTool's
        // trust-boundary note), so an operator who does not trust that boundary on a
        // given agent can require the online check unconditionally instead.
        const forceReverify = tasks.getBoolInput("forceOnlineReverification", false);
        const markerVerified = await verifyCachedTool(cachedToolPath, terraformPath, `terraform ${version}`);
        if (!markerVerified || forceReverify) {
            await reverifyUnmarkedCacheEntry(
                `terraform ${version}`,
                cachedToolPath,
                terraformPath,
                () => downloadVerifiedZipForReverify(downloadSource, version),
                findTerraformExecutable,
                markerVerified ? 'forced' : 'unmarked',
            );
        }
    } else if (verified) {
        await writeCacheIntegrityMarker(cachedToolPath, terraformPath);
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

// --- Download strategies ---

async function downloadZipFromHashiCorp(version: string): Promise<string> {
    const downloadUrl = getHashiCorpDownloadUrl(version);
    const fileName = `${terraformToolName}-${version}-${uuidV4()}.zip`;
    let zipPath: string;
    try {
        zipPath = await retryAsync(() => tools.downloadTool(downloadUrl, fileName), DOWNLOAD_RETRY);
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
    // A failed signature or checksum check DELETES the zip rather than leaving a
    // rejected — possibly tampered — artifact in the agent's temp directory (#204).
    await discardArtifactOnFailure(zipPath, async () => {
        await verifyGpgSignature(sha256SumsContent, sha256SumsSigUrl, requireGpg);
        await verifySha256(zipPath, parseSha256(sha256SumsContent, zipFileName));
    }, discardLog);

    return zipPath;
}

async function downloadZipFromRegistry(version: string, registryUrl: string, mirrorName: string): Promise<{ zipPath: string; verified: boolean }> {
    // registryUrl may embed basic-auth userinfo; mask it before it can reach a log
    // via infoUrl in any error/warning below (#586).
    maskOperatorUrlCredentials(registryUrl);
    const osPlatform = getPlatformString();
    const arch = getArchString();
    const infoUrl = `${registryUrl}/terraform/binaries/${mirrorName}/versions/${version}/${osPlatform}/${arch}`;

    const data = await fetchJson<{ download_url: string; sha256: string; filename?: string; shasums_url?: string; shasums_signature_url?: string }>(infoUrl);
    if (!data.download_url) {
        throw new Error(`Registry API returned invalid response: missing download_url from ${infoUrl}`);
    }
    // data.download_url = pre-signed storage URL (15-minute TTL)
    // data.sha256       = hex SHA256 of the zip (may be empty if registry verified server-side)
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

    // Optional opt-in host pin: a compromised registry could still point
    // download_url at an arbitrary HTTPS host, so an operator who wants to
    // constrain the trusted storage host(s) can set registryAllowedHosts.
    // Default (empty) preserves the existing trust-the-registry behavior.
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

    const fileName = `${terraformToolName}-${version}-${uuidV4()}.zip`;
    let zipPath: string;
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
        zipPath = path.join(destDir, fileName);
        await downloadToFile(data.download_url, zipPath, DOWNLOAD_TIMEOUT_MS, hostname =>
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
        throw new Error(tasks.loc("TerraformDownloadFailed", safeUrl, safeMsg));
    }

    // #1024: terraform-registry-backend has served shasums_url/shasums_signature_url
    // since v1.2.5, GPG-verified by the sync job against the pinned HashiCorp key at
    // ingest -- the SAME key this task already embeds and trusts for the hashicorp
    // and mirror sources. Reachable here only for binary=terraform: downloadTofu
    // never calls this function, and OpenTofu's SHA256SUMS is signed with a
    // different key this task does not embed (its own official install path
    // verifies via cosign instead, see downloadZipFromOpenTofu). When the registry
    // advertises both URLs, verify the fetched SHA256SUMS' signature and derive the
    // checksum from that VERIFIED content -- a strictly stronger guarantee than
    // trusting data.sha256, which is only the registry's own unauthenticated
    // assertion delivered over the same TLS session as the archive. This does not
    // contradict the "don't fall back to shasums_url for a missing sha256" reasoning
    // below: that is about substituting one unauthenticated value from this host for
    // another; this authenticates shasums_url itself against an out-of-band,
    // embedded trust root before trusting anything it says.
    if (data.shasums_url && data.shasums_signature_url) {
        const shasumsUrl = data.shasums_url;
        const shasumsSignatureUrl = data.shasums_signature_url;
        // Both URLs come from the SAME registry-controlled JSON response as
        // download_url and get the SAME two defenses. fetchText's own redirect
        // policy defaults to same-host-only (pipeline-task-core's http.ts), which
        // bounds a redirect FROM either URL to the host it started on -- it does
        // not validate that starting host, which is what assertEgressHostAllowed
        // below covers, reusing the same allowedHosts decision as download_url.
        if (!shasumsUrl.startsWith('https://') || !shasumsSignatureUrl.startsWith('https://')) {
            throw new Error(tasks.loc("InsecureUrlRejected", redactUrl(!shasumsUrl.startsWith('https://') ? shasumsUrl : shasumsSignatureUrl)));
        }
        await assertEgressHostAllowed(new URL(shasumsUrl).hostname, allowedHosts, REGISTRY_EGRESS_MESSAGES);
        await assertEgressHostAllowed(new URL(shasumsSignatureUrl).hostname, allowedHosts, REGISTRY_EGRESS_MESSAGES);

        const sumsContent = await fetchText(shasumsUrl);
        const requireGpg = getBoolInputDefaultTrue("requireGpgSignature");
        await discardArtifactOnFailure(zipPath, async () => {
            await verifyGpgSignature(sumsContent, shasumsSignatureUrl, requireGpg);
            await verifySha256(zipPath, parseSha256(sumsContent, data.filename || `terraform_${version}_${osPlatform}_${arch}.zip`));
        }, discardLog);
        return { zipPath, verified: true };
    }

    if (data.sha256) {
        await discardArtifactOnFailure(zipPath, () => verifySha256(zipPath, data.sha256), discardLog);
        // The checksum matched, but it is the REGISTRY's own assertion about the
        // artifact, delivered over the same TLS session -- not a signature. This
        // registry did not advertise shasums_url/shasums_signature_url above (an
        // older terraform-registry-backend, gpg_verify disabled on this mirror
        // config, or a version synced before either existed), so there is nothing
        // to verify against the pinned HashiCorp key here. Say so rather than
        // reporting a bare success that reads identically to the GPG-anchored
        // paths (#1024).
        tasks.warning(tasks.loc("RegistryTrustAnchorIsChecksumOnly", infoUrl));
        return { zipPath, verified: true };
    } else if (getBoolInputDefaultTrue("requireChecksum")) {
        // Empty sha256 means no local integrity check is possible. Fail closed when
        // the operator requires checksum verification rather than trusting the binary.
        // Typed as a VerificationFailure: the reachable registry deterministically
        // withheld required material, so the cache-hit re-verification path re-throws
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
            + ` Populate sha256 in the registry, or set downloadSource to "hashicorp" to install from the upstream release instead.`,
        );
    } else {
        tasks.warning(`SHA256 not provided by registry for ${infoUrl}; skipping local verification (trusting the registry's server-side verification only). Set requireChecksum to enforce a local check.`);
    }
    return { zipPath, verified: false };
}

async function downloadZipFromMirror(version: string, mirrorBaseUrl: string): Promise<{ zipPath: string; verified: boolean }> {
    // mirrorBaseUrl may embed basic-auth userinfo; mask it before it can reach a log
    // via the rejection message or any derived download URL below (#586).
    maskOperatorUrlCredentials(mirrorBaseUrl);
    if (!mirrorBaseUrl.startsWith('https://')) {
        throw new Error(tasks.loc("InsecureUrlRejected", redactUrlUserInfo(mirrorBaseUrl)));
    }
    const osPlatform = getPlatformString();
    const arch = getArchString();
    // Mirror must serve files at the same path structure as releases.hashicorp.com/terraform
    const downloadUrl = `${mirrorBaseUrl}/${version}/terraform_${version}_${osPlatform}_${arch}.zip`;

    // Baseline SSRF protection (#799, follow-up to #729): mirrorBaseUrl is an
    // operator-configured input (unlike the registry path's dynamically-returned
    // download_url), but a compromised/misconfigured mirror SERVICE could still
    // redirect the actual download at a private/link-local address (notably the
    // cloud metadata service). Check the initial host up front, then re-validate
    // every redirect hop via downloadToFile() below -- tools.downloadTool() (the
    // prior implementation) follows redirects with no way to re-validate them,
    // the same underlying gap #729 closed for the registry path. An operator
    // running a legitimate mirror on a private/internal address (a real,
    // pre-existing use case -- the registry path's own registryAllowedHosts
    // exists for exactly this reason) can opt in via mirrorAllowedHosts,
    // mirroring the registry path's allowlist shape exactly.
    const mirrorAllowedHosts = parseAllowedHosts(tasks.getInput("mirrorAllowedHosts", false));
    const initialHost = new URL(downloadUrl).hostname;
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

    const fileName = `${terraformToolName}-${version}-${uuidV4()}.zip`;
    const destDir = tasks.getVariable("Agent.TempDirectory") || os.tmpdir();
    const zipPath = path.join(destDir, fileName);
    try {
        await downloadToFile(downloadUrl, zipPath, DOWNLOAD_TIMEOUT_MS, hostname =>
            assertEgressHostAllowed(hostname, mirrorAllowedHosts, MIRROR_EGRESS_MESSAGES));
    } catch (exception) {
        // downloadUrl embeds mirrorBaseUrl (possibly with userinfo); strip it from the
        // interpolated message (the userinfo is also setSecret-masked above) (#586).
        throw new Error(tasks.loc("TerraformDownloadFailed", redactUrlUserInfo(downloadUrl), exception));
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
        return { zipPath, verified: false };
    }

    // The SHA256SUMS exists: verify its GPG signature against HashiCorp's pinned
    // key (a missing .sig is fatal only when requireGpgSignature is set), then
    // verify the zip's hash. A missing asset entry or a hash mismatch is fatal.
    await discardArtifactOnFailure(zipPath, async () => {
        await verifyGpgSignature(sumsBody, sha256SumsSigUrl, requireGpg);
        await verifySha256(zipPath, parseSha256(sumsBody, zipFileName));
    }, discardLog);
    return { zipPath, verified: true };
}

// --- Helpers ---

// NOTE: the OS/arch/checksum/exec-discovery helpers below are intentionally
// mirrored in PolicyAgentInstallerV1 (each task bundles independently); keep the two
// copies in sync — the parseSha256 binary-mode regex especially.
export function parseSha256(sha256SumsContent: string, zipFileName: string): string {
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
 * - Source REACHABLE but the material FAILS verification (bad GPG/cosign signature,
 *   checksum mismatch) OR the reachable source WITHHOLDS material a require-flag
 *   makes mandatory (empty registry sha256, a 404'd-but-required SHA256SUMS/.sig)
 *   — both surface as a typed VerificationFailure: fail closed. The source is
 *   serving/withholding in a way that violates the required policy; never fall
 *   back to the cached copy.
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
    reason: 'unmarked' | 'forced' = 'unmarked',
): Promise<void> {
    if (!getBoolInputDefaultTrue("requireChecksum")) {
        tasks.debug(reason === 'forced'
            ? `Cache hit for ${toolLabel}: forceOnlineReverification is enabled but requireChecksum is false; skipping remote re-verification.`
            : `Cache hit for ${toolLabel}: no stored integrity marker and requireChecksum is false; skipping remote re-verification.`);
        return;
    }
    if (reason === 'forced') {
        console.log(tasks.loc("ForcingOnlineReverification", toolLabel));
    } else {
        console.log(tasks.loc("ReverifyingCachedTool", toolLabel));
    }
    let zipPath: string;
    try {
        zipPath = await downloadVerifiedZip();
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
    }
    const freshDir = await tools.extractZip(zipPath);
    const freshExePath = findExe(freshDir);
    if (!freshExePath) {
        throw new Error(tasks.loc("TerraformNotFoundInFolder", freshDir));
    }
    const freshHash = (await hashFile(freshExePath)).toLowerCase();
    const cachedHash = (await hashFile(cachedExePath)).toLowerCase();
    if (freshHash !== cachedHash) {
        throw new Error(tasks.loc("CachedToolReverificationMismatch", toolLabel, freshHash, cachedHash));
    }
    await writeCacheIntegrityMarker(toolDir, cachedExePath);
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
            const mirrorName = validateUrlPathSegment("registryMirrorName", tasks.getInput("registryMirrorName", true)! || "terraform");
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

export function getArchString(): string {
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

    // Mirrors downloadTerraform: the cache-integrity marker is written only for an
    // artifact this run actually verified. downloadZipFromOpenTofu verifies the zip's
    // SHA256 unconditionally (cosign only gates the AUTHENTICITY of the SHA256SUMS
    // itself), so reaching the line below means the artifact was verified — stated
    // explicitly rather than left as an invariant a future edit could quietly break.
    let verified = false;
    if (!cachedToolPath) {
        const zipPath = await downloadZipFromOpenTofu(version);
        verified = true;
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
        const forceReverify = tasks.getBoolInput("forceOnlineReverification", false);
        const markerVerified = await verifyCachedTool(cachedToolPath, tofuPath, `tofu ${version}`);
        if (!markerVerified || forceReverify) {
            await reverifyUnmarkedCacheEntry(
                `tofu ${version}`,
                cachedToolPath,
                tofuPath,
                () => downloadZipFromOpenTofu(version),
                (rootFolder) => findExecutable(rootFolder, tofuToolName),
                markerVerified ? 'forced' : 'unmarked',
            );
        }
    } else if (verified) {
        await writeCacheIntegrityMarker(cachedToolPath, tofuPath);
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
        zipPath = await retryAsync(() => tools.downloadTool(downloadUrl, fileName), DOWNLOAD_RETRY);
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
    // Optional, opt-in pin (#550): verifies the resolved `cosign` binary itself
    // against an operator-supplied hash before trusting it, closing the ambient
    // PATH-lookup trust gap. Unset (default), behavior is unchanged.
    const cosignSha256 = tasks.getInput("cosignSha256", false);
    // As on the hashicorp path: a failed cosign or checksum check discards the zip (#204).
    await discardArtifactOnFailure(zipPath, async () => {
        await verifyCosignSignature(sha256SumsContent, signatureUrl, certificateUrl, version, requireCosign, cosignSha256 || undefined);
        await verifySha256(zipPath, parseSha256(sha256SumsContent, zipFileName));
    }, discardLog);

    return zipPath;
}
