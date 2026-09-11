import tasks = require('azure-pipelines-task-lib/task');
import tools = require('azure-pipelines-tool-lib/tool');
import fs = require('fs');
import os = require('os');
import path = require('path');

import { createHash, randomUUID as uuidV4 } from 'crypto';
import { pipeline } from 'stream/promises';
import { fetchBufferAllow404 } from './http-client';
import { retryAsync, VerificationFailure, discardArtifactOnFailure } from '@4cloudguru/pipeline-task-core';
import { getPlatformString, hashFile, verifySha256, writeCacheIntegrityMarker, verifyCachedTool } from './tool-integrity';
import { COSIGN_PINNED_TAG, COSIGN_PINNED_VERSION, resolveCosignPin } from './cosign-pins';

/**
 * Computes a file's SHA256 via a streaming read (fs.createReadStream piped into
 * the hash) rather than buffering the whole file into memory at once, mirroring
 * the same memory-safety property terraform-installer.ts's own
 * computeSha256Streaming establishes for downloaded archives (#728). Used to
 * verify the resolved `cosign` binary itself against an operator-pinned
 * cosignSha256 (#550).
 */
async function computeSha256Streaming(filePath: string): Promise<string> {
    const hash = createHash('sha256');
    await pipeline(fs.createReadStream(filePath), hash);
    return hash.digest('hex');
}

// The package does not import the ADO task lib, so the discard's log line is
// wired here -- same shape as terraform-installer.ts's own discardLog.
const discardLog = { debug: (message: string) => tasks.debug(message) };

// Matches terraform-installer.ts's DOWNLOAD_RETRY. Declared locally rather than
// imported because terraform-installer.ts imports THIS module; taking the
// constant from there would make the pair a require cycle.
const COSIGN_DOWNLOAD_RETRY = { retries: 2, baseDelayMs: 250, maxBackoffMs: 2000 };

// Tool-cache key for the managed cosign. Version-keyed, so rotating the pin in
// cosign-pins.ts lands in a fresh cache directory rather than colliding with the
// entry an earlier pin populated.
const COSIGN_TOOL_NAME = 'cosign';

/**
 * Where the `cosign` binary used to verify OpenTofu's SHA256SUMS comes from.
 *
 * - `managed` (default): the task downloads the pinned sigstore/cosign release
 *   asset for this agent's platform and verifies it against the SHA256 shipped in
 *   cosign-pins.ts before running it. Ambient PATH is never consulted.
 * - `ambient`: the historical behaviour -- `tasks.which('cosign')`, i.e. whatever
 *   the agent image or an earlier pipeline step put on PATH. Kept for
 *   image-baked/air-gapped agents that provision cosign themselves.
 */
export type CosignSource = 'managed' | 'ambient';

/**
 * Resolves cosign the way this task did before #1118: a bare PATH lookup.
 *
 * Retained ONLY for `cosignSource: ambient`. The binary it returns is not
 * integrity-verified by anything unless the operator also sets `cosignSha256`,
 * which is why the caller emits a real ##[warning] on this path and does not on
 * the managed one.
 *
 * Returns null when cosign is absent and verification is not required (the
 * caller then skips verification, as it always has).
 */
function resolveAmbientCosign(required: boolean): string | null {
    try {
        return tasks.which('cosign', true);
    } catch {
        if (required) {
            // A missing cosign binary is a deterministic, reproducible local policy
            // failure, not a transient outage -- typed as VerificationFailure so the
            // cache-hit re-verification path (reverifyUnmarkedCacheEntry) fails
            // closed instead of degrading to the cached, never-verified tofu binary
            // (#589/19).
            throw new VerificationFailure('cosign is required for OpenTofu signature verification but was not found on the agent. Install cosign on the agent, or leave cosignSource at its default (managed) to let the task install a pinned, hash-verified cosign itself, or set requireCosignVerification to false.');
        }
        tasks.warning('cosign not found on agent. SHA256SUMS will be trusted without signature verification.');
        return null;
    }
}

/**
 * Installs (or reuses) the PINNED cosign release and returns the path to it --
 * the fix for #1027/#1118.
 *
 * The verifier this task runs is downloaded from the sigstore/cosign release
 * named by COSIGN_PINNED_TAG and checked against the per-platform SHA256 in
 * cosign-pins.ts before it is ever executed, so `requireCosignVerification: true`
 * on the SHIPPED DEFAULT now depends on a binary this task established the
 * identity of, not on whatever a prior or concurrent job left on PATH.
 *
 * Fails CLOSED, in every direction, and never falls back to ambient PATH:
 * - no pinned asset for this platform/arch -> VerificationFailure naming the
 *   `cosignSource: ambient` opt-out (when required);
 * - download failure -> VerificationFailure (when required);
 * - digest mismatch -> VerificationFailure from verifySha256, with the rejected
 *   artifact deleted rather than left on a persistent agent's disk (#204).
 *
 * Returns null only in the one case the task has always tolerated: cosign cannot
 * be obtained AND verification is not required.
 */
async function resolveManagedCosign(required: boolean): Promise<string | null> {
    const platform = getPlatformString();
    const pin = resolveCosignPin(platform, os.arch());
    if (!pin) {
        const unsupported = `The pinned cosign release ${COSIGN_PINNED_TAG} publishes no binary for ${platform}/${os.arch()}, so the task cannot install a hash-verified cosign on this agent. Provision cosign yourself and set cosignSource to 'ambient', or set requireCosignVerification to false.`;
        if (required) {
            throw new VerificationFailure(unsupported);
        }
        tasks.warning(`${unsupported} SHA256SUMS will be trusted without signature verification.`);
        return null;
    }

    const cacheLabel = `${COSIGN_TOOL_NAME} ${COSIGN_PINNED_VERSION}`;
    const cachedDir = tools.findLocalTool(COSIGN_TOOL_NAME, COSIGN_PINNED_VERSION);
    if (cachedDir && fs.existsSync(path.join(cachedDir, pin.assetName))) {
        const cachedExe = path.join(cachedDir, pin.assetName);
        // Two independent local checks, both offline. verifyCachedTool compares the
        // cached executable against the integrity marker this agent wrote when it
        // downloaded it (and hard-fails if it changed underneath); the pin
        // comparison then re-asserts the digest this SHIPPED table names, so an
        // entry cached under this version key by anything other than the pinned
        // asset is re-downloaded rather than admitted.
        const markerVerified = await verifyCachedTool(cachedDir, cachedExe, cacheLabel).catch((error: unknown) => {
            // verifyCachedTool throws a BARE Error when a well-formed marker no
            // longer matches the cached executable -- i.e. the verifier itself was
            // altered on this agent since it was verified. Retype it: a bare Error
            // propagating out of here is caught by reverifyUnmarkedCacheEntry's
            // transient-failure branch, which warns and proceeds with the cached,
            // never-verified tofu binary (#589/19). Tampering with the verifier is
            // the last thing that may degrade to a warning.
            throw new VerificationFailure(`The cached ${cacheLabel} this task uses to verify OpenTofu signatures failed its own integrity re-verification: ${error instanceof Error ? error.message : String(error)}`);
        });
        if (markerVerified && (await hashFile(cachedExe)).toLowerCase() === pin.sha256.toLowerCase()) {
            tasks.debug(`Reusing the cached, pin-verified ${cacheLabel} at ${cachedExe}.`);
            return cachedExe;
        }
        tasks.debug(`Cached ${cacheLabel} at ${cachedExe} carries no integrity marker or does not match the pinned digest; re-downloading it.`);
    }

    // Literal host, deliberately: the destination of the verifier's own download
    // must not be reachable from any task input (the check-egress-authorization gate
    // reads this expression and records it as a constant host).
    const downloadUrl = `https://github.com/sigstore/cosign/releases/download/${COSIGN_PINNED_TAG}/${pin.assetName}`;
    let downloadedPath: string;
    try {
        downloadedPath = await retryAsync(
            () => tools.downloadTool(downloadUrl, `${COSIGN_TOOL_NAME}-${COSIGN_PINNED_VERSION}-${uuidV4()}-${pin.assetName}`),
            COSIGN_DOWNLOAD_RETRY,
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failure = `Could not download the pinned cosign ${COSIGN_PINNED_TAG} from ${downloadUrl}: ${message}.`;
        if (required) {
            // Deliberately NOT a fallback to ambient PATH: degrading to an
            // unverified verifier on a download failure would hand an attacker who
            // can break egress the exact outcome this fix removes (#1118).
            throw new VerificationFailure(`${failure} Refusing to fall back to an unverified cosign from the agent's PATH. Set cosignSource to 'ambient' to use a cosign you provision yourself, or set requireCosignVerification to false.`);
        }
        tasks.warning(`${failure} SHA256SUMS will be trusted without signature verification.`);
        return null;
    }

    let verified = false;
    // A digest mismatch DELETES the rejected download rather than leaving a
    // possibly-tampered binary in the agent's temp directory (#204).
    await discardArtifactOnFailure(downloadedPath, () => verifySha256(downloadedPath, pin.sha256), discardLog);
    verified = true;

    const toolDir = await tools.cacheFile(downloadedPath, pin.assetName, COSIGN_TOOL_NAME, COSIGN_PINNED_VERSION);
    const exePath = path.join(toolDir, pin.assetName);
    if (platform !== 'windows') {
        fs.chmodSync(exePath, '755');
    }
    if (verified) {
        // Only ever record a marker for an artifact this run actually verified
        // against the pin (#136) -- a marker written for an unverified binary would
        // make a later cache hit "verify" nothing.
        await writeCacheIntegrityMarker(toolDir, exePath);
    }
    console.log(`Installed the pinned cosign ${COSIGN_PINNED_TAG} at ${exePath} (SHA256 ${pin.sha256}) for OpenTofu signature verification.`);
    return exePath;
}

/**
 * Escapes every regular-expression metacharacter in `value` so it matches
 * literally when embedded in a larger pattern. Used to interpolate the exact
 * requested version into the OpenTofu certificate-identity regexp without the
 * version's own `.` (or any other metacharacter) widening the match.
 */
function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds the anchored, escaped regular expression for the Fulcio certificate
 * identity (SAN) that OpenTofu's keyless release signing produces for the
 * SPECIFIC requested version.
 *
 * OpenTofu's actual signing ref depends on the release: some releases sign from
 * a version TAG ref (`refs/tags/v<version>`), but as of the 1.12.x line OpenTofu
 * cuts patch releases from a long-lived per-minor release-maintenance BRANCH, and
 * the release.yml run that performs the keyless signing is triggered on that
 * branch push — so the Fulcio certificate's SAN carries `refs/heads/v<major>.<minor>`
 * (no patch component) instead of a tag ref. Confirmed directly against the real,
 * current upstream certificate (`tofu_1.12.4_SHA256SUMS.pem`'s SAN is
 * `https://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/heads/v1.12`)
 * after the weekly cosign trust-root canary caught the previous tag-only pattern
 * rejecting every current release (#734-era incident). The pattern therefore
 * accepts EITHER form: the full-version tag ref, or the major.minor branch ref —
 * both bound to the requested version (the branch alternative to its major.minor
 * only, since that is all the ref itself encodes; the SHA256SUMS content is still
 * independently bound to the exact patch version by `parseSha256`'s exact
 * `tofu_<version>_<file>` filename lookup in the caller, so a same-branch
 * cross-patch substitution is still caught even though the identity alone cannot
 * distinguish patch versions on the same branch).
 *
 * cosign matches `--certificate-identity-regexp` unanchored (Go
 * `regexp.MatchString`), so the pattern is anchored with `^`/`$` and its dots are
 * escaped. Anchoring alone prevents a look-alike certificate whose SAN merely
 * *contains* the OpenTofu identity (or sits on a different host/org/repo, an
 * unrelated branch, or http) from satisfying the match. Binding to the requested
 * version (tag) / its major.minor (branch) means a validly-signed SHA256SUMS from
 * a DIFFERENT OpenTofu release line can no longer satisfy the identity — closing
 * the cross-version replay gap that the original `@refs/tags/v[0-9].*` (any tag)
 * pattern left to URL-path binding alone. The workflow-file segment is pinned to
 * the literal, escaped `release.yml` (the actual, currently-stable signing
 * workflow at github.com/opentofu/opentofu/.github/workflows/release.yml,
 * confirmed against the upstream repo) rather than a permissive `.+`, so a Fulcio
 * certificate for any OTHER workflow file in the repo — even one on an otherwise
 * matching ref — no longer satisfies the identity (#697). If OpenTofu ever
 * renames or splits its signing workflow, or changes its branching scheme again,
 * this constant needs updating alongside it.
 */
export function buildOpenTofuCertIdentityRegexp(version: string): string {
    const workflowPrefix = 'https://github\\.com/opentofu/opentofu/\\.github/workflows/release\\.yml@refs/';
    const tagAlternative = `tags/v${escapeRegExp(version)}`;
    const majorMinorMatch = version.match(/^(\d+\.\d+)/);
    if (!majorMinorMatch) {
        // Version string doesn't look like <major>.<minor>[.<patch>...] (e.g. an
        // unusual operator-supplied 'version' input) — fall back to the
        // tag-only pattern rather than emitting a malformed/absent branch
        // alternative.
        return `^${workflowPrefix}${tagAlternative}$`;
    }
    const branchAlternative = `heads/v${escapeRegExp(majorMinorMatch[1])}`;
    return `^${workflowPrefix}(${tagAlternative}|${branchAlternative})$`;
}

/**
 * Verifies the cosign signature of a SHA256SUMS file against OpenTofu's Sigstore identity.
 *
 * - Obtains the `cosign` binary. With the default `cosignSource: managed` the task
 *   downloads the pinned sigstore/cosign release and verifies it against the
 *   digest in cosign-pins.ts before running it; with `ambient` it falls back to
 *   the historical `tasks.which('cosign')` PATH lookup (#1027/#1118).
 * - Downloads the `.sig` (signature) and `.pem` (certificate) files.
 * - Shells out to the `cosign` binary to run `verify-blob`, pinning both the OIDC
 *   issuer (exact) and the certificate identity (anchored, version-bound regexp,
 *   built from `version` — see buildOpenTofuCertIdentityRegexp above).
 * - If cosign cannot be obtained and `required` is false, warns and returns (unverified).
 * - If cosign cannot be obtained and `required` is true, throws (hard fail).
 * - If the signature/certificate material is genuinely absent (404) and `required`
 *   is true, throws a typed VerificationFailure so the cache-hit re-verification
 *   path fails closed (a reachable release withholding required signing material is
 *   a policy failure, not a transient outage).
 * - If signature verification fails, throws (hard fail).
 *
 * `required` is a MANDATORY parameter, deliberately with no default (#1030):
 * every current call site already passes an explicit value, so this changes
 * nothing live -- it exists so a FUTURE call site that forgets the argument
 * fails to compile instead of compiling clean and silently downgrading a
 * missing signature to a warning.
 *
 * `cosignSource` is the opposite case and takes the OPPOSITE treatment: its
 * default (`managed`) is the FAIL-CLOSED value, so a future call site that
 * forgets it gets the hash-verified verifier rather than the ambient one. Making
 * it mandatory would buy nothing and would only push callers toward passing
 * something.
 */
export async function verifyCosignSignature(
    sha256SumsContent: string,
    signatureUrl: string,
    certificateUrl: string,
    version: string,
    required: boolean,
    expectedCosignSha256?: string,
    cosignSource: CosignSource = 'managed'
): Promise<void> {
    // The whole point of #1027/#1118: on the shipped default this resolves a
    // binary the task downloaded and hashed against a shipped pin, and the ambient
    // PATH is never consulted at all. `ambient` is an explicit operator opt-out.
    const cosignPath = cosignSource === 'ambient'
        ? resolveAmbientCosign(required)
        : await resolveManagedCosign(required);
    if (cosignPath === null) {
        return;
    }

    // Log the resolved binary's actual SHA256 unconditionally -- not only when an
    // operator has opted into pinning it -- so the exact binary that was trusted is
    // auditable from the build log in either mode (#1027/18: "found cosign on PATH"
    // alone is not provenance). Hashing failure itself (e.g. a resolved path that
    // vanished between resolution and here) is not a reason to fail the run when a
    // pin was never requested -- log it and move on.
    let resolvedCosignSha256 = 'unavailable';
    try {
        resolvedCosignSha256 = await computeSha256Streaming(cosignPath);
    } catch (hashErr) {
        tasks.debug(`Could not compute SHA256 of the resolved cosign binary at ${cosignPath}: ${hashErr instanceof Error ? hashErr.message : hashErr}`);
    }
    console.log(`Using cosign at ${cosignPath} (SHA256 ${resolvedCosignSha256}, source ${cosignSource}) for OpenTofu signature verification.`);

    // The ambient path is the one #1027 described: a bare PATH lookup with no pin
    // means a concurrent/prior job on a persistent self-hosted agent that can write
    // a PATH directory can silently shadow cosign with a stub that always exits 0,
    // converting a default-on check into a no-op. That is now an explicit opt-out
    // rather than the shipped default, and on it a green run must still carry a real
    // ##[warning] annotation -- not a console.log -- so nothing in the build log
    // reads the same as a verified install. Deliberately NOT emitted on the managed
    // path: there the binary IS integrity-checked (against cosign-pins.ts), so the
    // warning would be false, and a warning that fires on every green run is how an
    // operator learns to ignore it.
    if (required && !expectedCosignSha256 && cosignSource === 'ambient') {
        tasks.warning(`cosignSource is set to 'ambient' and cosignSha256 is not set, so this binary is trusted without an integrity check of its own. On a shared or persistent agent, a prior or concurrent job with PATH write access could substitute a different binary there. Set cosignSha256 to pin the expected hash, or leave cosignSource at its default (managed) to let the task install a pinned, hash-verified cosign.`);
    }

    if (expectedCosignSha256) {
        // Optional, opt-in pin (#550): an operator who has provisioned cosign from a
        // known-good, integrity-verified source (e.g. sigstore/cosign-installer
        // pinned to a commit SHA) can pin its exact binary hash here, closing the
        // ambient-PATH trust gap -- a PATH-write attacker who shadows `cosign` with a
        // stub is caught instead of silently trusted. Still honoured on the managed
        // path (#1118), where it is a second, operator-owned expectation layered on
        // top of the shipped pin rather than the only one. Fails closed on a
        // mismatch; left unset (default), behavior is completely unchanged.
        if (resolvedCosignSha256.toLowerCase() !== expectedCosignSha256.toLowerCase()) {
            throw new VerificationFailure(`cosign binary at ${cosignPath} has SHA256 ${resolvedCosignSha256}, which does not match the pinned cosignSha256 (${expectedCosignSha256}). Refusing to trust it for OpenTofu signature verification.`);
        }
        tasks.debug('cosign binary SHA256 matches the pinned cosignSha256.');
    }

    // Fetch the signature + certificate, distinguishing a genuine 404 (the files
    // are not published) from a transient 5xx / network / TLS failure. Only a real
    // absence downgrades to skip-when-not-required; any other fetch failure is
    // fatal even when `required` is false, so a transient outage can never silently
    // turn OpenTofu signature verification off.
    let signatureBytes: Uint8Array | null;
    let certificateBytes: Uint8Array | null;
    try {
        signatureBytes = await fetchBufferAllow404(signatureUrl);
        certificateBytes = await fetchBufferAllow404(certificateUrl);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Cosign signature/certificate fetch failed for OpenTofu verification (not a 404): ${message}`);
    }

    if (signatureBytes === null || certificateBytes === null) {
        if (required) {
            // Genuine 404 of REQUIRED signing material from a reachable release:
            // deterministic policy failure, typed so the cache-hit re-verification
            // path fails closed instead of degrading to the cached binary.
            throw new VerificationFailure(`Cosign signature or certificate file unavailable and verification is required. Signature: ${signatureUrl}, Certificate: ${certificateUrl}`);
        }
        tasks.warning('Cosign signature/certificate files unavailable (404). Skipping verification.');
        return;
    }

    // #887: prefer Agent.TempDirectory (auto-purged by the ADO agent at job end)
    // over a bare os.tmpdir(), matching terraform-installer.ts's own
    // tasks.getVariable("Agent.TempDirectory") convention in this same task, so
    // these files don't outlive the job on a persistent self-hosted agent.
    // mkdtempSync creates the directory atomically with 0700, so the three
    // verification inputs cannot be pre-planted or read by another local user
    // (CWE-377/CWE-59) -- the same idiom used elsewhere in this repo.
    const scratchDir = fs.mkdtempSync(path.join(tasks.getVariable("Agent.TempDirectory") || os.tmpdir(), 'tsm-cosign-'));
    const sha256SumsPath = path.join(scratchDir, 'sha256sums');
    const signaturePath = path.join(scratchDir, 'sha256sums.sig');
    const certificatePath = path.join(scratchDir, 'sha256sums.pem');

    // Deliberately outside the verify try/catch below: a local write failure is
    // transport-like, not a signature failure, and must never be reclassified as
    // a VerificationFailure.
    fs.writeFileSync(sha256SumsPath, sha256SumsContent);
    fs.writeFileSync(signaturePath, signatureBytes);
    fs.writeFileSync(certificatePath, certificateBytes);

    try {
        tasks.debug(`Verifying cosign signature: ${signatureUrl}`);
        const toolRunner = tasks.tool(cosignPath);
        toolRunner.arg('verify-blob');
        toolRunner.arg(['--certificate', certificatePath]);
        toolRunner.arg(['--signature', signaturePath]);
        toolRunner.arg(['--certificate-identity-regexp', buildOpenTofuCertIdentityRegexp(version)]);
        toolRunner.arg(['--certificate-oidc-issuer', 'https://token.actions.githubusercontent.com']);
        toolRunner.arg(sha256SumsPath);

        const result = await toolRunner.exec();
        if (result !== 0) {
            throw new Error('Cosign verification failed with non-zero exit code');
        }
        tasks.debug('Cosign signature verification passed');
    } catch (error) {
        // The signature/certificate material was obtained and cosign ran against
        // it — a failure here is a verification failure (typed so the cache-hit
        // re-verification path fails closed), not an availability problem.
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new VerificationFailure(`Cosign signature verification failed for SHA256SUMS: ${errorMessage}`);
    } finally {
        try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
    }
}
