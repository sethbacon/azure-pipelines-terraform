import tasks = require('azure-pipelines-task-lib/task');
import fs = require('fs');
import os = require('os');
import path = require('path');

import { randomUUID as uuidV4 } from 'crypto';
import { fetchBufferAllow404 } from './http-client';
import { VerificationFailure } from './verification-failure';

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
 * SPECIFIC requested version. OpenTofu signs each release's SHA256SUMS from its
 * `release.yml` workflow on that release's tag ref, yielding a SAN of the form
 * `https://github.com/opentofu/opentofu/.github/workflows/<wf>@refs/tags/v<version>`.
 *
 * cosign matches `--certificate-identity-regexp` unanchored (Go
 * `regexp.MatchString`), so the pattern is anchored with `^`/`$` and its dots are
 * escaped. Anchoring alone prevents a look-alike certificate whose SAN merely
 * *contains* the OpenTofu identity (or sits on a different host/org/repo, a branch
 * ref, or http) from satisfying the match. Interpolating the exact version
 * (regex-escaped) additionally binds the signed SHA256SUMS to the version being
 * installed, so a validly-signed SHA256SUMS from a DIFFERENT OpenTofu release can
 * no longer satisfy the identity — closing the cross-version replay gap that the
 * previous `@refs/tags/v[0-9].*` (any tag) pattern left to URL-path binding alone.
 */
export function buildOpenTofuCertIdentityRegexp(version: string): string {
    return `^https://github\\.com/opentofu/opentofu/\\.github/workflows/.+@refs/tags/v${escapeRegExp(version)}$`;
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
    required: boolean = false
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
