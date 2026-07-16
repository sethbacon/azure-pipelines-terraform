// SHARED MODULE — intentionally duplicated, BYTE-IDENTICAL, between
//   Tasks/TerraformTask/TerraformTaskV5/src/results/caps.ts  (task-side, ENFORCES the caps while building the digest)
//   src/tab/caps.ts                                          (tab-side,  ENFORCES the same caps defensively)
// scripts/check-shared-modules.js enforces the two copies stay byte-identical and
// fails CI on any divergence, so a change here MUST be applied to BOTH copies in
// the same commit (design decision D4).
//
// SINGLE SOURCE OF TRUTH for every size / DoS limit in the digest pipeline. These
// are the numbers from docs/initiatives/structured-plan-apply-tabs.md §6 (also
// restated in docs/design/plan-apply-digest-spec.md). They live here — not inline
// in the redaction/builder/renderer code — so the task-side producer and the
// tab-side consumer cannot drift on a limit. Change these ONLY as a design change.
//
// Byte thresholds use BINARY units (KiB = 1024, MiB = 1024*1024); the §6 table's
// "KB"/"MB" labels are those binary sizes.

/** Max resources kept in a digest. Excess dropped by action priority (destroy/replace first). */
export const MAX_RESOURCES = 2000;

/** Max attribute changes kept per resource. Excess dropped alphabetically by path. */
export const MAX_ATTR_CHANGES_PER_RESOURCE = 200;

/** Max serialized bytes for a single RedactedValue.json; larger -> {kind:"omitted",reason:"too-large"}. */
export const MAX_REDACTED_VALUE_BYTES = 4 * 1024; // 4 KB

/** Max diagnostics kept (errors first, then warnings). */
export const MAX_DIAGNOSTICS = 500;

/** Soft total-digest ceiling: on exceed, drop attributeChanges arrays (keep rows + summary), set truncated. */
export const SOFT_MAX_DIGEST_BYTES = 5 * 1024 * 1024; // 5 MB

/** Hard total-digest ceiling: on exceed, attach a summary-only digest. */
export const HARD_MAX_DIGEST_BYTES = 12 * 1024 * 1024; // 12 MB

/** Tab-side parse ceiling: refuse structured render above this, offer raw/download. */
export const TAB_PARSE_CEILING_BYTES = 16 * 1024 * 1024; // 16 MB

/** Tab-side rendered-row cap before virtualize/hard-cap with a "list truncated" banner. */
export const TAB_MAX_RENDERED_ROWS = 2000;
