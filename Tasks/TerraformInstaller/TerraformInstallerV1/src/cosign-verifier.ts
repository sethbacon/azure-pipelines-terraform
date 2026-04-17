import tasks = require('azure-pipelines-task-lib/task');
import fs = require('fs');
import os = require('os');
import path = require('path');

import { v4 as uuidV4 } from 'uuid';
import { fetchBuffer } from './http-client';

/**
 * Verifies the cosign signature of a SHA256SUMS file against OpenTofu's Sigstore identity.
 *
 * - Downloads the `.sig` (signature) and `.pem` (certificate) files.
 * - Shells out to the `cosign` binary to run `verify-blob`.
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

    let signatureBytes: Uint8Array;
    let certificateBytes: Uint8Array;
    try {
        signatureBytes = await fetchBuffer(signatureUrl);
        certificateBytes = await fetchBuffer(certificateUrl);
    } catch {
        if (required) {
            throw new Error(`Cosign signature or certificate file unavailable and verification is required. Signature: ${signatureUrl}, Certificate: ${certificateUrl}`);
        }
        tasks.warning('Cosign signature/certificate files unavailable. Skipping verification.');
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
        toolRunner.arg(['--certificate-identity-regexp', 'https://github.com/opentofu/opentofu']);
        toolRunner.arg(['--certificate-oidc-issuer', 'https://token.actions.githubusercontent.com']);
        toolRunner.arg(sha256SumsPath);

        const result = await toolRunner.exec();
        if (result !== 0) {
            throw new Error('Cosign verification failed with non-zero exit code');
        }
        tasks.debug('Cosign signature verification passed');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Cosign signature verification failed for SHA256SUMS: ${errorMessage}`);
    } finally {
        try { fs.unlinkSync(sha256SumsPath); } catch { /* ignore cleanup errors */ }
        try { fs.unlinkSync(signaturePath); } catch { /* ignore cleanup errors */ }
        try { fs.unlinkSync(certificatePath); } catch { /* ignore cleanup errors */ }
    }
}
