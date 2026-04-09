import tasks = require('azure-pipelines-task-lib/task');
import * as openpgp from 'openpgp';

import { fetchBuffer } from './http-client';
import { HASHICORP_GPG_PUBLIC_KEY } from './hashicorp-gpg-key';

/**
 * Verifies the GPG signature of a SHA256SUMS file against HashiCorp's public key.
 * Fetches the `.sig` file from the same base URL as the SHA256SUMS file.
 *
 * - If verification succeeds, returns the SHA256SUMS content (already fetched).
 * - If the `.sig` file is unavailable (e.g., air-gapped mirror), warns and returns the content unverified.
 * - If the signature is invalid, throws (hard fail).
 */
export async function verifyGpgSignature(sha256SumsContent: string, signatureUrl: string): Promise<void> {
    let signatureBytes: Uint8Array;
    try {
        signatureBytes = await fetchBuffer(signatureUrl);
    } catch {
        tasks.warning(`GPG signature file unavailable (${signatureUrl}). SHA256SUMS will be trusted without signature verification.`);
        return;
    }

    tasks.debug(`Verifying GPG signature from ${signatureUrl}`);

    const publicKey = await openpgp.readKey({ armoredKey: HASHICORP_GPG_PUBLIC_KEY });
    const signature = await openpgp.readSignature({ binarySignature: signatureBytes });
    const message = await openpgp.createMessage({ text: sha256SumsContent });

    const result = await openpgp.verify({
        message,
        signature,
        verificationKeys: publicKey,
    });

    const { verified } = result.signatures[0];
    try {
        await verified;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`GPG signature verification failed for SHA256SUMS: ${errorMessage}`);
    }

    tasks.debug('GPG signature verification passed');
}
