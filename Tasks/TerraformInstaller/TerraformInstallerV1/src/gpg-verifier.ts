// SHARED MODULE — intentionally duplicated across TerraformInstallerV1/src and
// PolicyAgentInstallerV1/src. CI (scripts/check-shared-modules.js) enforces that
// the copies stay byte-identical, failing the build on any divergence, so a fix or
// key rotation here MUST be applied to BOTH copies. This duplication is deliberate
// (each task bundles independently) — not drift to be flagged.
import tasks = require('azure-pipelines-task-lib/task');
import * as openpgp from 'openpgp';

import { fetchBufferAllow404 } from './http-client';
import { HASHICORP_GPG_PUBLIC_KEY } from './hashicorp-gpg-key';

/**
 * Verifies the GPG signature of a SHA256SUMS file against HashiCorp's public key.
 * Fetches the `.sig` file from the same base URL as the SHA256SUMS file.
 *
 * - If verification succeeds, returns the SHA256SUMS content (already fetched).
 * - If the `.sig` file is genuinely absent (HTTP 404) and `required` is false, warns
 *   and returns unverified. Any OTHER fetch error (5xx / network / timeout) is
 *   transient and propagates fatally even when `required` is false -- only a
 *   confirmed absence should downgrade to a warning.
 * - If the `.sig` file is unavailable and `required` is true, throws (hard fail).
 * - If the signature is invalid, throws (hard fail).
 */
export async function verifyGpgSignature(sha256SumsContent: string, signatureUrl: string, required: boolean = false): Promise<void> {
    const signatureBytes = await fetchBufferAllow404(signatureUrl);
    if (signatureBytes === null) {
        if (required) {
            throw new Error(`GPG signature file unavailable (${signatureUrl}) and signature verification is required. Set 'requireGpgSignature' to false to skip.`);
        }
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

    if (!result.signatures || result.signatures.length === 0) {
        throw new Error(`GPG signature verification failed: no signatures found in ${signatureUrl}`);
    }
    const { verified } = result.signatures[0];
    try {
        await verified;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`GPG signature verification failed for SHA256SUMS: ${errorMessage}`);
    }

    tasks.debug('GPG signature verification passed');
}
