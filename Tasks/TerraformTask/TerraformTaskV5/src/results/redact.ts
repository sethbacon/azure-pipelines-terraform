// REDACTION CORE — the single most security-critical module of the structured
// plan/apply digest pipeline. It converts a raw Terraform value plus its
// sensitivity / unknown *mask maps* into a `RedactedValue` that NEVER contains a
// raw sensitive value.
//
// Normative spec: docs/design/plan-apply-digest-spec.md §2 (redaction algorithm),
// §2.5 (prototype-pollution guard), §2.6 (determinism), §2.8 (fail-closed rule),
// §3 (size caps). Design source: docs/initiatives/structured-plan-apply-tabs.md
// §5.2 / §6.
//
// INVARIANTS (each has a unit test in Tests/results/):
//  1. A leaf the mask marks sensitive is emitted as {kind:"sensitive"} and the
//     underlying value appears NOWHERE in the digest (build the redacted tree
//     FIRST, then serialize — never serialize raw then scrub, §2 / §5.2.5).
//  2. FAIL CLOSED: whenever a mask's shape disagrees with the value's shape, the
//     value is treated as sensitive (masked), never leaked, and a note is
//     recorded so the event is observable (§2.8 — the single most important rule).
//  3. `__proto__` / `constructor` / `prototype` keys are dropped, never walked
//     into Object.prototype (§2.5).
//  4. Deterministic: identical input -> byte-identical output (lexicographic key
//     order in the serialized value, §2.6) so golden-fixture regression is real.
//
// This file also houses the shared serialization / size utilities the two digest
// builders (plan-digest.ts, apply-digest.ts) both need — `stableStringify`,
// `utf8ByteLength`, `deepEqual`, and the digest-level byte-cap enforcement
// (`capDigestBytes`) — so those helpers have exactly one implementation and the
// producer cannot drift from itself.

import { RedactedValue, Digest, PlanDigest, ApplyDigest, StateDigest } from './digest-schema';
import { MAX_REDACTED_VALUE_BYTES } from './caps';

/**
 * Context threaded through a redaction walk. Carries the caps (§3) and the sink
 * for observability notes (a fail-closed mask mismatch, a dropped unsafe key, or
 * an over-cap omission records a human-readable note here; the builder surfaces
 * these as the digest's `truncationNotes`).
 */
export interface RedactContext {
  /** Sink for observability notes (fail-closed events, dropped keys, omissions). */
  notes: string[];
  /** Per-value serialized-byte cap; defaults to caps.MAX_REDACTED_VALUE_BYTES. */
  maxValueBytes: number;
  /** Path label used only in note messages (e.g. the attribute address). */
  path: string;
}

/** Build a RedactContext with the production caps as defaults. */
export function newRedactContext(overrides?: Partial<RedactContext>): RedactContext {
  return {
    notes: overrides?.notes ?? [],
    maxValueBytes: overrides?.maxValueBytes ?? MAX_REDACTED_VALUE_BYTES,
    path: overrides?.path ?? '',
  };
}

// Internal tagged node produced by the recursive walk. `plain.v` is a fully
// known, non-sensitive JSON value with any nested sensitive/unknown leaves
// already replaced by their sentinel strings.
type RedactNode =
  | { t: 'sensitive' }
  | { t: 'unknown' }
  | { t: 'plain'; v: unknown };

const SENTINEL_SENSITIVE = '(sensitive)';
const SENTINEL_UNKNOWN = '(known after apply)';
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isContainer(m: unknown): boolean {
  return m !== null && typeof m === 'object';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Mask lookups: an ABSENT index/key means "not sensitive/unknown" (false),
// matching Terraform's sparse mask maps (§2.4 helpers).
function elem(mask: unknown, i: number): unknown {
  return Array.isArray(mask) ? mask[i] : false;
}
function prop(mask: unknown, key: string): unknown {
  return isPlainObject(mask) ? mask[key] : false;
}

function note(ctx: RedactContext, msg: string): void {
  const at = ctx.path ? ` at ${ctx.path}` : '';
  ctx.notes.push(`${msg}${at}`);
}

function materialize(child: RedactNode): unknown {
  if (child.t === 'sensitive') return SENTINEL_SENSITIVE;
  if (child.t === 'unknown') return SENTINEL_UNKNOWN;
  return child.v;
}

/**
 * The recursive walk (spec §2.4). Returns a tagged node; sensitivity wins over
 * unknown, and any mask/value SHAPE MISMATCH fails closed to `{t:"sensitive"}`.
 */
function redactNode(value: unknown, sMask: unknown, uMask: unknown, ctx: RedactContext): RedactNode {
  // (1) whole-subtree sensitivity wins over everything
  if (sMask === true) return { t: 'sensitive' };
  // (2) whole-subtree unknown (only if not sensitive)
  if (uMask === true) return { t: 'unknown' };

  // (3) scalar / null value
  if (value === null || typeof value !== 'object') {
    // a container mask over a scalar value is a shape mismatch -> FAIL CLOSED
    if (isContainer(sMask) || isContainer(uMask)) {
      note(ctx, 'sensitivity mask shape mismatch (container mask over scalar); masked fail-closed');
      return { t: 'sensitive' };
    }
    // Coerce `undefined` (an attribute present on only one side of a before/after
    // diff) to JSON null so serialization stays well-formed — JSON has no undefined.
    return { t: 'plain', v: value === undefined ? null : value };
  }

  // (4) array value — a container mask MUST be an array of the same shape
  if (Array.isArray(value)) {
    if ((isContainer(sMask) && !Array.isArray(sMask)) || (isContainer(uMask) && !Array.isArray(uMask))) {
      note(ctx, 'sensitivity mask shape mismatch (object mask over array); masked fail-closed');
      return { t: 'sensitive' };
    }
    // "Same shape" for an array mask INCLUDES the same length. Terraform emits a
    // per-element parallel mask array (or a whole-value boolean), never a short
    // one; a mask array whose length disagrees with the value cannot be trusted
    // to mark every element, and the trailing (unmasked) elements would leak in
    // cleartext. Treat any length disagreement as a shape mismatch -> FAIL CLOSED
    // (§2.8), mirroring the object/scalar mismatch handling above.
    if ((Array.isArray(sMask) && sMask.length !== value.length) || (Array.isArray(uMask) && uMask.length !== value.length)) {
      note(ctx, 'sensitivity mask shape mismatch (array length mismatch); masked fail-closed');
      return { t: 'sensitive' };
    }
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      out.push(materialize(redactNode(value[i], elem(sMask, i), elem(uMask, i), ctx)));
    }
    return { t: 'plain', v: out };
  }

  // (5) object value — a container mask MUST be a (non-array) object
  if ((isContainer(sMask) && Array.isArray(sMask)) || (isContainer(uMask) && Array.isArray(uMask))) {
    note(ctx, 'sensitivity mask shape mismatch (array mask over object); masked fail-closed');
    return { t: 'sensitive' };
  }
  // Null-prototype target so an attacker-supplied key can never reach
  // Object.prototype even before the explicit UNSAFE_KEYS guard below.
  const out: Record<string, unknown> = Object.create(null);
  const keys = Object.keys(value as Record<string, unknown>).sort();
  for (const key of keys) {
    if (UNSAFE_KEYS.has(key)) {
      note(ctx, `dropped unsafe key '${key}'`);
      continue;
    }
    out[key] = materialize(redactNode((value as Record<string, unknown>)[key], prop(sMask, key), prop(uMask, key), ctx));
  }
  return { t: 'plain', v: out };
}

/**
 * Redact a single value against its sensitivity mask and (for `after` values)
 * its unknown mask, returning a `RedactedValue` (spec §2.4 top-level wrapper).
 * The raw value is never present in the output for the sensitive/unknown/omitted
 * variants; for `{kind:"value"}` the JSON is the already-redacted subtree,
 * bounded by `ctx.maxValueBytes`.
 */
export function redactValue(value: unknown, sensitiveMask: unknown, unknownMask: unknown, ctx: RedactContext): RedactedValue {
  const node = redactNode(value, sensitiveMask, unknownMask, ctx);
  if (node.t === 'sensitive') return { kind: 'sensitive' };
  if (node.t === 'unknown') return { kind: 'unknown' };
  const json = stableStringify(node.v);
  if (utf8ByteLength(json) > ctx.maxValueBytes) {
    note(ctx, 'value omitted (over per-value size cap)');
    return { kind: 'omitted', reason: 'too-large' };
  }
  return { kind: 'value', json };
}

/**
 * Does a Terraform sensitivity/unknown MASK mark ANY leaf `true` (at any depth)?
 *
 * This is the exact "a mask of `true` means sensitive" rule `redactNode` applies
 * at every node (a whole-subtree `true`, or a `true` nested inside an array/object
 * mask). It is exposed here as a standalone predicate so a caller that has ONLY a
 * mask and no value — the task's pre-flight `warnIfSensitiveOutputs` detection —
 * shares ONE implementation with the redaction core and cannot silently drift
 * from what the structured digest actually redacts (design §5.2.7; the #446
 * detection-vs-redaction drift class). Living in the security-critical module,
 * beside `redactNode`, is deliberate: the predicate and the redactor are read and
 * changed together.
 */
export function maskHasSensitiveLeaf(mask: unknown): boolean {
  if (mask === true) return true;
  if (Array.isArray(mask)) return mask.some(maskHasSensitiveLeaf);
  if (mask !== null && typeof mask === 'object') return Object.values(mask as Record<string, unknown>).some(maskHasSensitiveLeaf);
  return false;
}

// ---------------------------------------------------------------------------
// Shared serialization / size / equality utilities (used by both builders)
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serialization with lexicographically-sorted object keys
 * (§2.6). Relying on property insertion order is unsafe because JS reorders
 * integer-like keys, so keys are sorted explicitly at every level. Input is
 * always JSON-safe (it came from JSON.parse of Terraform output), so there are
 * no undefined/NaN/function values to handle.
 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) as string;
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** UTF-8 byte length of a string (what the §3 byte caps measure). */
export function utf8ByteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Structural deep-equality over JSON values (used to detect changed attributes). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/**
 * Serialize a finished digest the way the attachment is written and the no-leak
 * tripwire greps it (pretty-printed, stable field order — the builder constructs
 * every object in a fixed key order so JSON.stringify is already deterministic).
 */
export function serializeDigest(digest: Digest): string {
  return JSON.stringify(digest, null, 2);
}

/**
 * Enforce the digest-level total-byte caps (§3, spec table rows "soft"/"hard").
 * Returns the digest unchanged when it is within the soft ceiling; on the soft
 * ceiling it drops the heavy per-attribute arrays (keeps resource rows +
 * summary); on the hard ceiling it collapses to a summary-only digest. Every
 * reduction sets `truncated` and appends a note — never a silent drop.
 *
 * `softMax` / `hardMax` are passed explicitly (defaulted by the builders to the
 * caps.ts constants) so the boundary behavior can be unit-tested with small
 * ceilings without configuring the production single-source caps.
 */
export function capDigestBytes<T extends Digest>(digest: T, softMax: number, hardMax: number): T {
  const size = () => utf8ByteLength(serializeDigest(digest));
  if (size() <= softMax) return digest;

  if (digest.kind === 'plan') {
    dropPlanAttributeArrays(digest as PlanDigest);
  } else {
    dropApplyDiagnosticDetail(digest as ApplyDigest);
  }
  digest.truncated = true;
  addNote(digest, 'digest exceeded soft size ceiling; dropped detailed change arrays');

  if (size() <= hardMax) return digest;

  const summaryOnly = toSummaryOnly(digest);
  return summaryOnly as T;
}

function dropPlanAttributeArrays(d: PlanDigest): void {
  for (const r of d.resources) r.attributeChanges = [];
  if (d.drift) for (const r of d.drift) r.attributeChanges = [];
}

function dropApplyDiagnosticDetail(d: ApplyDigest): void {
  for (const diag of d.diagnostics) delete diag.detail;
}

function addNote(d: Digest, msg: string): void {
  if (!d.truncationNotes) d.truncationNotes = [];
  d.truncationNotes.push(msg);
}

// Collapse to counts + envelope only (hard ceiling). Kept in fixed field order
// so serialization stays deterministic.
function toSummaryOnly(d: Digest): Digest {
  const base = {
    schemaVersion: d.schemaVersion,
    kind: d.kind,
    producedBy: d.producedBy,
    tool: d.tool,
    meta: d.meta,
    truncated: true,
    truncationNotes: [...(d.truncationNotes ?? []), 'digest exceeded hard size ceiling; summary-only digest attached'],
  };
  if (d.kind === 'plan') {
    const p: PlanDigest = { ...base, kind: 'plan', summary: d.summary, resources: [], outputChanges: [] };
    return p;
  }
  if (d.kind === 'state') {
    const s: StateDigest = { ...base, kind: 'state', summary: d.summary, resources: [], outputs: [] };
    return s;
  }
  const a: ApplyDigest = {
    ...base,
    kind: 'apply',
    outcome: d.outcome,
    summary: d.summary,
    resources: [],
    diagnostics: [],
    outputs: [],
  };
  return a;
}
