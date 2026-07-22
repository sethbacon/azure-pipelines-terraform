import tasks = require('azure-pipelines-task-lib/task');
import fs = require('fs');
import os = require('os');
import path = require('path');

import { randomUUID as uuidV4, createHash } from 'crypto';
import { pipeline } from 'stream/promises';
import { fetchBufferAllow404 } from './http-client';
import { VerificationFailure } from './verification-failure';

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
 * - Downloads the `.sig` (signature) and `.pem` (certificate) files.
 * - Shells out to the `cosign` binary to run `verify-blob`, pinning both the OIDC
 *   issuer (exact) and the certificate identity (anchored, version-bound regexp,
 *   built from `version` — see buildOpenTofuCertIdentityRegexp above).
 * - If cosign is not installed and `required` is false, warns and returns (unverified).
 * - If cosign is not installed and `required` is true, throws (hard fail).
 * - If the signature/certificate material is genuinely absent (404) and `required`
 *   is true, throws a typed VerificationFailure so the cache-hit re-verification
 *   path fails closed (a reachable release withholding required signing material is
 *   a policy failure, not a transient outage).
 * - If signature verification fails, throws (hard fail).
 */
export async function verifyCosignSignature(
    sha256SumsContent: string,
    signatureUrl: string,
    certificateUrl: string,
    version: string,
    required: boolean = false,
    expectedCosignSha256?: string
): Promise<void> {
    let cosignPath: string;
    try {
        cosignPath = tasks.which('cosign', true);
    } catch {
        if (required) {
            throw new Error('cosign is required for OpenTofu signature verification but was not found on the agent. Install cosign or set requireCosignVerification to false.');
        }
        tasks.warning('cosign not found on agent. SHA256SUMS will be trusted without signature verification.');
        return;
    }

    // cosign is discovered via a PATH lookup and is itself never integrity-verified,
    // so log where it resolved from — a shadowed/unexpected binary is then auditable
    // from the build log.
    console.log(`Using cosign at ${cosignPath} for OpenTofu signature verification.`);

    if (expectedCosignSha256) {
        // Optional, opt-in pin (#550): an operator who has provisioned cosign from a
        // known-good, integrity-verified source (e.g. sigstore/cosign-installer
        // pinned to a commit SHA) can pin its exact binary hash here, closing the
        // ambient-PATH trust gap -- a PATH-write attacker who shadows `cosign` with a
        // stub is caught instead of silently trusted. Fails closed on a mismatch;
        // left unset (default), behavior is completely unchanged.
        const actualCosignSha256 = await computeSha256Streaming(cosignPath);
        if (actualCosignSha256.toLowerCase() !== expectedCosignSha256.toLowerCase()) {
            throw new VerificationFailure(`cosign binary at ${cosignPath} has SHA256 ${actualCosignSha256}, which does not match the pinned cosignSha256 (${expectedCosignSha256}). Refusing to trust it for OpenTofu signature verification.`);
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

    const tempDir = os.tmpdir();
    const sha256SumsPath = path.join(tempDir, `sha256sums-${uuidV4()}`);
    const signaturePath = path.join(tempDir, `sha256sums-${uuidV4()}.sig`);
    const certificatePath = path.join(tempDir, `sha256sums-${uuidV4()}.pem`);

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
        try { fs.unlinkSync(sha256SumsPath); } catch { /* ignore cleanup errors */ }
        try { fs.unlinkSync(signaturePath); } catch { /* ignore cleanup errors */ }
        try { fs.unlinkSync(certificatePath); } catch { /* ignore cleanup errors */ }
    }
}
