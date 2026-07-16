// SHARED MODULE — intentionally duplicated across TerraformInstallerV1/src,
// PolicyAgentInstallerV1/src, and TerraformDocsInstallerV1/src. CI
// (scripts/check-shared-modules.js) enforces that the copies stay
// byte-identical, failing the build on any divergence, so a change here MUST
// be applied to ALL THREE copies. This duplication is deliberate (each task
// bundles independently) — not drift to be flagged.

/**
 * Error thrown when release verification material (a SHA256SUMS/.sha256 file, a
 * GPG/cosign signature, or a registry-provided sha256) was successfully OBTAINED
 * but the artifact FAILED verification against it: a bad or wrong-key signature,
 * a checksum mismatch, or a checksum file that does not list the requested asset.
 *
 * Deliberately NOT used when material is merely unavailable (network/DNS/TLS
 * failure, non-2xx response, genuine 404, cosign binary absent). The cache-hit
 * re-verification path keys on this distinction: "the source is serving material
 * that does not verify" fails closed, while "the material cannot be fetched"
 * degrades gracefully to the cached tool (preserving offline/air-gapped cache
 * reuse) with a warning.
 */
export class VerificationFailure extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'VerificationFailure';
        Object.setPrototypeOf(this, VerificationFailure.prototype);
    }
}

/**
 * instanceof with a name-based fallback: mockery-based tests (and any duplicated
 * module instance) can surface a structurally identical error whose class
 * identity differs, so classification also keys on the stable `name` marker.
 */
export function isVerificationFailure(err: unknown): boolean {
    return err instanceof VerificationFailure || (err instanceof Error && err.name === 'VerificationFailure');
}
