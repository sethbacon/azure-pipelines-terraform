// SHARED MODULE — intentionally duplicated across TerraformInstallerV1/src,
// PolicyAgentInstallerV1/src, and TerraformDocsInstallerV1/src. CI
// (scripts/check-shared-modules.js) enforces that the copies stay byte-identical,
// failing the build on any divergence, so a change here MUST be applied to ALL
// THREE copies. This duplication is deliberate (each task bundles independently)
// — not drift to be flagged.
//
// Also carried, with a provenance header instead of this one, by
// azure-pipelines-packer's PackerInstallerV1/src. The same defect class covers
// both extensions.

import fs = require('fs');
import tasks = require('azure-pipelines-task-lib/task');

/**
 * Runs `verify` over a freshly downloaded artifact and, if any check inside it
 * throws, DELETES the artifact before rethrowing.
 *
 * http-client.ts's downloadToFile already unlinks its destination when the
 * TRANSFER fails, but verification is a separate, later step: an archive whose
 * SHA256 does not match — i.e. one that may have been tampered with — was
 * otherwise left in Agent.TempDirectory/os.tmpdir() indefinitely on a persistent
 * self-hosted agent. EVERY verification of a freshly downloaded artifact goes
 * through this wrapper, so a rejected artifact never outlives the check that
 * rejected it. The unlink is best-effort and never masks the verification error
 * that triggered it.
 *
 * Deliberately NOT used for the agent's CACHED executable: that file belongs to
 * the tool cache and other jobs may be using it, so a failed cache re-verification
 * fails the task without evicting it.
 *
 * Also deliberately NOT used for a checksum that is merely UNAVAILABLE (a source
 * that published no checksum file, or a checksum file that does not list the
 * requested asset) when the operator has opted out of requiring one: that install
 * legitimately proceeds, so the artifact must survive. Wrap the comparison, not
 * the lookup.
 */
export async function discardArtifactOnFailure<T>(artifactPath: string, verify: () => Promise<T>): Promise<T> {
    try {
        return await verify();
    } catch (error) {
        try {
            fs.unlinkSync(artifactPath);
            tasks.debug(`Discarded ${artifactPath}: it failed integrity verification.`);
        } catch { /* best effort — the verification error is what matters */ }
        throw error;
    }
}
