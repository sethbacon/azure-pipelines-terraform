import tasks = require('azure-pipelines-task-lib/task');
import fs = require('fs');
import os = require('os');
import path = require('path');

import { randomUUID as uuidV4 } from 'crypto';
import { fetchBufferAllow404 } from './http-client';
import { VerificationFailure } from './verification-failure';

/**
 * Anchored, escaped regular expression for the Fulcio certificate identity (SAN)
 * that OpenTofu's keyless release signing produces. OpenTofu signs each release's
 * SHA256SUMS from its `release.yml` workflow on a tag ref, yielding a SAN of the
 * form `https://github.com/opentofu/opentofu/.github/workflows/<wf>@refs/tags/v<n>`.
 *
 * cosign matches `--certificate-identity-regexp` unanchored (Go `regexp.MatchString`),
 * so the pattern is anchored with `^`/`$` and its dots are escaped. This prevents a
 * look-alike certificate whose SAN merely *contains* the OpenTofu identity (or sits
 * on a different host/org/repo, a branch ref, or http) from satisfying the match.
 */
export const OPENTOFU_CERT_IDENTITY_REGEXP =
    '^https://github\\.com/opentofu/opentofu/\\.github/workflows/.+@refs/tags/v[0-9].*$';

/**
 * Verifies the cosign signature of a SHA256SUMS file against OpenTofu's Sigstore identity.
 *
 * - Downloads the `.sig` (signature) and `.pem` (certificate) files.
 * - Shells out to the `cosign` binary to run `verify-blob`, pinning both the OIDC
 *   issuer (exact) and the certificate identity (anchored regexp, see above).
 * - If cosign is not installed and `required` is false, warns and returns (unverified).
 * - If cosign is not installed and `required` is true, throws (hard fail).
 * - If signature verification fails, throws (hard fail).
 */
export async function verifyCosignSignature(
    sha256SumsContent: string,
    signatureUrl: string,
    certificateUrl: string,
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
            throw new Error(`Cosign signature or certificate file unavailable and verification is required. Signature: ${signatureUrl}, Certificate: ${certificateUrl}`);
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
        toolRunner.arg(['--certificate-identity-regexp', OPENTOFU_CERT_IDENTITY_REGEXP]);
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
