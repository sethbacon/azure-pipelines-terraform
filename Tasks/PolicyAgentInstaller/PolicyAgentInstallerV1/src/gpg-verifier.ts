// SHARED MODULE — intentionally duplicated across TerraformInstallerV1/src and
// PolicyAgentInstallerV1/src. CI (scripts/check-shared-modules.js) enforces that
// the copies stay byte-identical, failing the build on any divergence, so a fix or
// key rotation here MUST be applied to BOTH copies. This duplication is deliberate
// (each task bundles independently) — not drift to be flagged.
//
// The CRYPTOGRAPHIC decision now comes from @4cloudguru/pipeline-task-core/gpg
// (verifyDetached), so the openpgp API surface lives in one place instead of two
// copies. What stays here is what the package deliberately refuses to own:
//   - the trust root (HASHICORP_GPG_PUBLIC_KEY), because vendoring a signing key
//     through a package means a compromise of that package silently replaces it;
//   - the 404-vs-transient distinction, because only the caller knows a missing
//     signature MAY be downgraded on operator opt-out while a 5xx never may;
//   - the VerificationFailure typing, which is what lets the cache-hit
//     re-verification path fail closed on a bad signature but degrade on an outage.
import tasks = require('azure-pipelines-task-lib/task');

import { verifyDetached } from '@4cloudguru/pipeline-task-core/gpg';

import { fetchBufferAllow404 } from './http-client';
import { HASHICORP_GPG_PUBLIC_KEY } from './hashicorp-gpg-key';
import { VerificationFailure } from '@4cloudguru/pipeline-task-core';

/**
 * Verifies the GPG signature of a SHA256SUMS file against HashiCorp's public key.
 * Fetches the `.sig` file from the same base URL as the SHA256SUMS file.
 *
 * - If verification succeeds, returns the SHA256SUMS content (already fetched).
 * - If the `.sig` file is genuinely absent (HTTP 404) and `required` is false, warns
 *   and returns unverified. Any OTHER fetch error (5xx / network / timeout) is
 *   transient and propagates fatally even when `required` is false -- only a
 *   confirmed absence should downgrade to a warning.
 * - If the `.sig` file is genuinely absent (HTTP 404) and `required` is true, throws
 *   a typed VerificationFailure (hard fail): a reachable source withholding the
 *   required signature is a deterministic policy failure, so the cache-hit
 *   re-verification path re-throws it (fail closed) instead of degrading to the
 *   cached tool the way it does for a genuine transport outage.
 * - If the signature is invalid, throws a VerificationFailure (hard fail).
 *
 * `required` is a MANDATORY parameter, deliberately with no default (#1030):
 * every current call site already passes an explicit value, so this changes
 * nothing live -- it exists so a FUTURE call site that forgets the argument
 * fails to compile instead of compiling clean and silently downgrading a
 * missing signature to a warning.
 */
export async function verifyGpgSignature(sha256SumsContent: string, signatureUrl: string, required: boolean): Promise<void> {
    const signatureBytes = await fetchBufferAllow404(signatureUrl);
    if (signatureBytes === null) {
        if (required) {
            throw new VerificationFailure(`GPG signature file unavailable (${signatureUrl}) and signature verification is required. Set 'requireGpgSignature' to false to skip.`);
        }
        tasks.warning(`GPG signature file unavailable (${signatureUrl}). SHA256SUMS will be trusted without signature verification.`);
        return;
    }

    tasks.debug(`Verifying GPG signature from ${signatureUrl}`);

    const result = await verifyDetached({
        message: new TextEncoder().encode(sha256SumsContent),
        signature: signatureBytes,
        armoredPublicKeys: [HASHICORP_GPG_PUBLIC_KEY],
    });

    // From here on the signature material was OBTAINED but does not verify —
    // throw the typed VerificationFailure so the cache-hit re-verification path
    // fails closed instead of degrading to "material unavailable".
    if (!result.verified) {
        // The reasons are how an operator tells a key-rotation miss from a tampered
        // file; without them this failure reads the same either way. The URL is kept
        // because the deleted "no signatures found in <url>" branch was the only place
        // a zero-signature .sig named which file was empty.
        const detail = result.reasons?.join('; ') || 'no signature verified';
        throw new VerificationFailure(`GPG signature verification failed for SHA256SUMS (${signatureUrl}): ${detail}`);
    }

    tasks.debug('GPG signature verification passed');
}
