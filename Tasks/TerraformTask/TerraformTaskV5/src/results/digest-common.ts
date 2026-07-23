// SHARED DIGEST-BUILDER COMMON — the identity/provenance and byte-budget types
// and the truncation-notes cap helper shared by all three digest builders
// (plan-digest.ts, apply-digest.ts, state-digest.ts). Extracted from
// plan-digest.ts (#789) so the two sibling builders no longer reach "backwards"
// into plan-digest.ts for these shared pieces — every builder now depends on this
// neutral module instead, and plan-digest.ts is no longer the de-facto common
// ancestor of its siblings.
//
// Producer-side ONLY: the build-results tab consumes an already-built digest via
// the parity-gated digest-schema.ts / caps.ts contract, so — unlike those two —
// this file is intentionally NOT part of the src/results <-> src/tab
// byte-identical parity family (scripts/check-shared-modules.js).

import { MAX_NOTES } from './caps';

/** Identity/provenance a caller supplies; kept out of the raw Terraform JSON. */
export interface DigestBuildMeta {
  taskVersion: string;
  toolName: 'terraform' | 'opentofu';
  name: string;
  workingDirectory?: string;
  stage?: string;
  job?: string;
  /** Injected/agent-provided timestamp — never Date.now() (§2.6). */
  createdIso: string;
}

/** Optional test seam for the digest-level byte ceilings; production omits it. */
export interface DigestByteLimits {
  softMaxBytes?: number;
  hardMaxBytes?: number;
}

// truncationNotes cap (§3): a pathological plan can generate one note per capped
// resource, so bound the array itself. Keep the first MAX_NOTES and collapse the
// remainder into a single count note so the truncation stays observable.
export function capNotes(notes: string[]): string[] {
  if (notes.length <= MAX_NOTES) return [...notes];
  const dropped = notes.length - MAX_NOTES;
  return [...notes.slice(0, MAX_NOTES), `truncation notes capped at ${MAX_NOTES} (${dropped} more not shown)`];
}
