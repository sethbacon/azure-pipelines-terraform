/**
 * Safe parsing & validation of a plan/apply digest fetched from a pipeline
 * attachment (§5.3.4 of docs/initiatives/structured-plan-apply-tabs.md).
 *
 * The digest is UNTRUSTED INPUT: it was produced by a task run inside a
 * customer pipeline, but the tab (running in the ADO web UI) must not assume
 * it is well-formed or safe to spread into component state. This module is
 * the single choke point between `JSON.parse` and every structured component
 * — nothing downstream should ever see a raw `unknown` value.
 *
 * Rules enforced here (see design §5.3.4 / §12.2):
 *  - JSON.parse only (never eval/Function).
 *  - Reject digests over the tab parse ceiling BEFORE parsing (avoid a
 *    browser OOM from a malicious/huge attachment).
 *  - Reject prototype-pollution keys (`__proto__`/`constructor`/`prototype`)
 *    anywhere in the parsed tree — the whole digest is rejected rather than
 *    silently stripping the key, since a document that carries one is
 *    already suspect.
 *  - Field-by-field coercion into the typed `Digest` shapes from
 *    digest-schema.ts — never `{...parsed}` spread an untrusted object into
 *    typed state.
 *  - A required top-level field that is missing/mistyped on a *known*
 *    schemaVersion (1) fails the whole parse (§12.2: "rejected safely, not
 *    rendered as undefined"). An *unknown* schemaVersion instead degrades:
 *    every field softens to a safe default and the caller is told via
 *    `unknownVersion`/`notes` so it can offer the raw fallback.
 *  - `RedactedValue` is the one place a redaction/shape bug becomes a
 *    disclosure, so it ALWAYS fails closed to `{kind:"sensitive"}` on any
 *    unrecognized shape, in both strict and lenient mode — this is a
 *    defense-in-depth mirror of the task-side fail-closed rule (spec §5.2.4),
 *    not merely a "best-effort" default like every other field.
 *  - Container arrays (resources/diagnostics/outputs/...) are defensively
 *    re-capped tab-side to the §6 limits regardless of the digest's own
 *    `truncated` claim (§5.5: "don't trust `truncated`"); a malformed array
 *    element is skipped (with a note) rather than failing the whole digest.
 */

import {
  Digest,
  PlanDigest,
  ApplyDigest,
  PlanResource,
  DriftResource,
  AttrChange,
  RedactedValue,
  OutputChange,
  ApplyResource,
  Diagnostic,
} from "./digest-schema";
import {
  MAX_RESOURCES,
  MAX_ATTR_CHANGES_PER_RESOURCE,
  MAX_REDACTED_VALUE_BYTES,
  MAX_DIAGNOSTICS,
  TAB_PARSE_CEILING_BYTES,
} from "./caps";

/** The only schemaVersion this tab fully understands. */
const KNOWN_SCHEMA_VERSION = 1;

/** Keys that must never be read/walked into — the prototype-pollution surface. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type DigestParseFailureReason =
  | "oversize"
  | "malformed-json"
  | "unsafe-keys"
  | "invalid-envelope"
  | "unsupported-kind";

export interface DigestParseFailure {
  ok: false;
  reason: DigestParseFailureReason;
  message: string;
}

export interface DigestParseSuccess {
  ok: true;
  /** Typed per the frozen v1 contract. See `unknownVersion`/`detectedSchemaVersion` below. */
  digest: Digest;
  /** True when the source `schemaVersion` is newer than KNOWN_SCHEMA_VERSION; `digest` is a best-effort, partial reconstruction. */
  unknownVersion: boolean;
  /** The raw `schemaVersion` value found on the wire (may differ from `digest.schemaVersion`, which is normalized to the known literal). */
  detectedSchemaVersion: number;
  /** Human-readable notes: degraded/defaulted fields, defensive caps applied, fail-closed masks. */
  notes: string[];
}

export type DigestParseResult = DigestParseSuccess | DigestParseFailure;

/**
 * Parse and validate a digest attachment's raw text body.
 * @param raw the attachment body, already decoded to a string
 * @param byteLength optional known byte length (e.g. from a `Content-Length`
 *   header) so the caller can refuse an oversize body before even reading it
 *   into `raw`; when omitted, the UTF-8 byte length of `raw` itself is used.
 */
export function parseDigestText(raw: string, byteLength?: number): DigestParseResult {
  const size = byteLength ?? utf8ByteLength(raw);
  if (size > TAB_PARSE_CEILING_BYTES) {
    return {
      ok: false,
      reason: "oversize",
      message: `Digest is ${size} bytes, over the ${TAB_PARSE_CEILING_BYTES}-byte tab parse ceiling.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: "malformed-json", message: err instanceof Error ? err.message : "Invalid JSON." };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, reason: "invalid-envelope", message: "Digest root is not a JSON object." };
  }

  if (containsForbiddenKey(parsed)) {
    return {
      ok: false,
      reason: "unsafe-keys",
      message: "Digest contains a disallowed key (__proto__ / constructor / prototype).",
    };
  }

  const kind = parsed["kind"];
  if (kind !== "plan" && kind !== "apply") {
    return { ok: false, reason: "unsupported-kind", message: `Unrecognized digest kind: ${JSON.stringify(kind)}` };
  }

  const rawSchemaVersion = parsed["schemaVersion"];
  const detectedSchemaVersion = typeof rawSchemaVersion === "number" ? rawSchemaVersion : NaN;
  const unknownVersion = detectedSchemaVersion !== KNOWN_SCHEMA_VERSION;

  const notes: string[] = [];
  if (unknownVersion) {
    notes.push(
      `This digest was produced with schemaVersion ${JSON.stringify(
        rawSchemaVersion
      )}, which this tab does not fully understand (known: ${KNOWN_SCHEMA_VERSION}). Rendering best-effort from recognized fields only; use the raw view for the full content.`
    );
  }

  const envelope = coerceEnvelope(parsed, unknownVersion, notes);
  if (!envelope.ok) {
    return { ok: false, reason: "invalid-envelope", message: envelope.message };
  }

  const built =
    kind === "plan"
      ? coercePlanDigest(parsed, envelope.value, unknownVersion, notes)
      : coerceApplyDigest(parsed, envelope.value, unknownVersion, notes);

  if (!built.ok) {
    return { ok: false, reason: "invalid-envelope", message: built.message };
  }

  return { ok: true, digest: built.value, unknownVersion, detectedSchemaVersion, notes };
}

// ---------------------------------------------------------------------------
// Generic safety primitives
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Recursively checks whether any object in the tree carries an OWN property
 * literally named `__proto__`, `constructor`, or `prototype`. `Object.keys`
 * only enumerates own properties and is not affected by the prototype chain,
 * so this is safe to run on untrusted `JSON.parse` output — reading
 * `obj["__proto__"]` on such an object returns the JSON value (an own
 * property shadows the inherited accessor), never `Object.prototype` itself.
 * The danger this guards against is downstream: if some other code later
 * copied keys via generic bracket-assignment (`target[key] = value`), that
 * assignment path (unlike simple reads) *does* invoke the inherited
 * `__proto__` setter. Rejecting the whole digest here removes the need for
 * every downstream coercer to reason about that possibility.
 */
function containsForbiddenKey(value: unknown, seen: Set<unknown> = new Set()): boolean {
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((v) => containsForbiddenKey(v, seen));
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) return true;
    if (containsForbiddenKey((value as Record<string, unknown>)[key], seen)) return true;
  }
  return false;
}

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

type FieldResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** A required top-level object field. Hard-fails in strict mode; empty-object-defaults in lenient mode. */
function requireObject(
  obj: Record<string, unknown>,
  key: string,
  lenient: boolean,
  notes: string[],
  path: string
): FieldResult<Record<string, unknown>> {
  const v = obj[key];
  if (isPlainObject(v)) return { ok: true, value: v };
  if (lenient) {
    notes.push(`${path}.${key} missing or invalid; defaulted to an empty object.`);
    return { ok: true, value: {} };
  }
  return { ok: false, message: `${path}.${key} is required and must be an object.` };
}

/** A required top-level array field. Hard-fails in strict mode; empty-array-defaults in lenient mode. */
function requireArray(
  obj: Record<string, unknown>,
  key: string,
  lenient: boolean,
  notes: string[],
  path: string
): FieldResult<unknown[]> {
  const v = obj[key];
  if (Array.isArray(v)) return { ok: true, value: v };
  if (lenient) {
    notes.push(`${path}.${key} missing or invalid; defaulted to an empty list.`);
    return { ok: true, value: [] };
  }
  return { ok: false, message: `${path}.${key} is required and must be an array.` };
}

function softString(obj: Record<string, unknown>, key: string, fallback: string, notes: string[], path: string): string {
  const v = obj[key];
  if (typeof v === "string") return v;
  notes.push(`${path}.${key} missing or not a string; defaulted.`);
  return fallback;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function optionalStringArray(obj: Record<string, unknown>, key: string): string[] | undefined {
  const v = obj[key];
  if (!Array.isArray(v)) return undefined;
  const strings = v.filter((x): x is string => typeof x === "string");
  return strings.length > 0 ? strings : undefined;
}

function softNumber(obj: Record<string, unknown>, key: string, fallback: number, notes: string[], path: string): number {
  const v = obj[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  notes.push(`${path}.${key} missing or not a number; defaulted to ${fallback}.`);
  return fallback;
}

function optionalNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function softBoolean(obj: Record<string, unknown>, key: string, fallback: boolean, notes: string[], path: string): boolean {
  const v = obj[key];
  if (typeof v === "boolean") return v;
  notes.push(`${path}.${key} missing or not a boolean; defaulted to ${fallback}.`);
  return fallback;
}

function softEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
  notes: string[],
  path: string
): T {
  const v = obj[key];
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  notes.push(`${path}.${key} missing or not one of ${allowed.join("/")}; defaulted to "${fallback}".`);
  return fallback;
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

interface EnvelopeFields {
  producedByTask: string;
  producedByTaskVersion: string;
  toolName: string;
  toolVersion: string;
  metaName: string;
  metaWorkingDirectory?: string;
  metaStage?: string;
  metaJob?: string;
  metaCreatedIso: string;
  truncated: boolean;
  truncationNotes?: string[];
}

function coerceEnvelope(
  obj: Record<string, unknown>,
  lenient: boolean,
  notes: string[]
): FieldResult<EnvelopeFields> {
  const producedBy = requireObject(obj, "producedBy", lenient, notes, "digest");
  if (!producedBy.ok) return producedBy;
  const tool = requireObject(obj, "tool", lenient, notes, "digest");
  if (!tool.ok) return tool;
  const meta = requireObject(obj, "meta", lenient, notes, "digest");
  if (!meta.ok) return meta;

  return {
    ok: true,
    value: {
      producedByTask: softString(producedBy.value, "task", "unknown", notes, "digest.producedBy"),
      producedByTaskVersion: softString(producedBy.value, "taskVersion", "unknown", notes, "digest.producedBy"),
      toolName: softString(tool.value, "name", "terraform", notes, "digest.tool"),
      toolVersion: softString(tool.value, "version", "unknown", notes, "digest.tool"),
      metaName: softString(meta.value, "name", "", notes, "digest.meta"),
      metaWorkingDirectory: optionalString(meta.value, "workingDirectory"),
      metaStage: optionalString(meta.value, "stage"),
      metaJob: optionalString(meta.value, "job"),
      metaCreatedIso: softString(meta.value, "createdIso", "", notes, "digest.meta"),
      truncated: softBoolean(obj, "truncated", false, notes, "digest"),
      truncationNotes: optionalStringArray(obj, "truncationNotes"),
    },
  };
}

function envelopeBase(
  env: EnvelopeFields
): Pick<PlanDigest, "schemaVersion" | "producedBy" | "tool" | "meta" | "truncated" | "truncationNotes"> {
  return {
    // The wire schemaVersion may legitimately differ (see `unknownVersion` /
    // `detectedSchemaVersion` on the parse result) — the frozen contract
    // types this literally as `1`, so any value is normalized to it here;
    // callers must consult `unknownVersion` before trusting this field.
    schemaVersion: 1,
    producedBy: { task: "TerraformTaskV5", taskVersion: env.producedByTaskVersion },
    tool: { name: env.toolName === "opentofu" ? "opentofu" : "terraform", version: env.toolVersion },
    meta: {
      name: env.metaName,
      workingDirectory: env.metaWorkingDirectory,
      stage: env.metaStage,
      job: env.metaJob,
      createdIso: env.metaCreatedIso,
    },
    truncated: env.truncated,
    truncationNotes: env.truncationNotes,
  };
}

// ---------------------------------------------------------------------------
// RedactedValue — always fails closed, never aborts the parse
// ---------------------------------------------------------------------------

function coerceRedactedValue(v: unknown, notes: string[], path: string): RedactedValue {
  if (!isPlainObject(v)) {
    notes.push(`${path} is not a valid RedactedValue; masked (fail-closed).`);
    return { kind: "sensitive" };
  }
  const kind = v["kind"];
  switch (kind) {
    case "value": {
      const raw = v["json"];
      if (typeof raw !== "string") {
        notes.push(`${path} claimed kind "value" but had no json string; masked (fail-closed).`);
        return { kind: "sensitive" };
      }
      if (raw.length > MAX_REDACTED_VALUE_BYTES) {
        notes.push(`${path}.json exceeded the tab's defensive size cap and was truncated.`);
        return { kind: "value", json: raw.slice(0, MAX_REDACTED_VALUE_BYTES) + "…(truncated)" };
      }
      return { kind: "value", json: raw };
    }
    case "sensitive":
      return { kind: "sensitive" };
    case "unknown":
      return { kind: "unknown" };
    case "omitted":
      return { kind: "omitted", reason: "too-large" };
    default:
      notes.push(`${path} has an unrecognized RedactedValue kind (${JSON.stringify(kind)}); masked (fail-closed).`);
      return { kind: "sensitive" };
  }
}

// ---------------------------------------------------------------------------
// Plan digest
// ---------------------------------------------------------------------------

const PLAN_ACTIONS = ["no-op", "create", "read", "update", "delete", "replace", "forget"] as const;

function coercePlanDigest(
  obj: Record<string, unknown>,
  env: EnvelopeFields,
  lenient: boolean,
  notes: string[]
): FieldResult<PlanDigest> {
  const summaryObj = requireObject(obj, "summary", lenient, notes, "digest");
  if (!summaryObj.ok) return summaryObj;
  const resourcesArr = requireArray(obj, "resources", lenient, notes, "digest");
  if (!resourcesArr.ok) return resourcesArr;
  const outputChangesArr = requireArray(obj, "outputChanges", lenient, notes, "digest");
  if (!outputChangesArr.ok) return outputChangesArr;

  const summary = {
    add: softNumber(summaryObj.value, "add", 0, notes, "digest.summary"),
    change: softNumber(summaryObj.value, "change", 0, notes, "digest.summary"),
    destroy: softNumber(summaryObj.value, "destroy", 0, notes, "digest.summary"),
    replace: softNumber(summaryObj.value, "replace", 0, notes, "digest.summary"),
    read: softNumber(summaryObj.value, "read", 0, notes, "digest.summary"),
    noChanges: softBoolean(summaryObj.value, "noChanges", false, notes, "digest.summary"),
    driftDetected: softBoolean(summaryObj.value, "driftDetected", false, notes, "digest.summary"),
  };

  let truncated = env.truncated;
  const truncationNotes = env.truncationNotes ? [...env.truncationNotes] : [];

  let resources = resourcesArr.value
    .map((r, i) => coercePlanResource(r, notes, `digest.resources[${i}]`))
    .filter((r): r is PlanResource => r !== null);
  if (resources.length > MAX_RESOURCES) {
    resources = resources.slice(0, MAX_RESOURCES);
    truncated = true;
    truncationNotes.push(`resource list capped at ${MAX_RESOURCES} (tab-side defensive cap)`);
  }

  const outputChanges = outputChangesArr.value
    .map((o, i) => coerceOutputChange(o, notes, `digest.outputChanges[${i}]`))
    .filter((o): o is OutputChange => o !== null);

  const driftArr = obj["drift"];
  let drift: DriftResource[] | undefined;
  if (Array.isArray(driftArr)) {
    drift = driftArr
      .map((d, i) => coerceDriftResource(d, notes, `digest.drift[${i}]`))
      .filter((d): d is DriftResource => d !== null);
  }

  return {
    ok: true,
    value: {
      ...envelopeBase(env),
      truncated,
      truncationNotes: truncationNotes.length > 0 ? truncationNotes : undefined,
      kind: "plan",
      summary,
      resources,
      outputChanges,
      drift,
    },
  };
}

function coercePlanResource(v: unknown, notes: string[], path: string): PlanResource | null {
  if (!isPlainObject(v)) {
    notes.push(`${path} skipped: not an object.`);
    return null;
  }
  const address = optionalString(v, "address");
  if (!address) {
    notes.push(`${path} skipped: missing "address".`);
    return null;
  }
  const rawActions = Array.isArray(v["actions"]) ? (v["actions"] as unknown[]) : [];
  const actions = rawActions.filter((a): a is (typeof PLAN_ACTIONS)[number] =>
    typeof a === "string" && (PLAN_ACTIONS as readonly string[]).includes(a)
  );
  if (rawActions.length > 0 && actions.length === 0) {
    notes.push(`${path}.actions contained no recognized action; treated as empty.`);
  }

  let attributeChanges = (Array.isArray(v["attributeChanges"]) ? (v["attributeChanges"] as unknown[]) : [])
    .map((a, i) => coerceAttrChange(a, notes, `${path}.attributeChanges[${i}]`))
    .filter((a): a is AttrChange => a !== null);
  if (attributeChanges.length > MAX_ATTR_CHANGES_PER_RESOURCE) {
    attributeChanges = attributeChanges.slice(0, MAX_ATTR_CHANGES_PER_RESOURCE);
    notes.push(`${path}.attributeChanges capped at ${MAX_ATTR_CHANGES_PER_RESOURCE} (tab-side defensive cap)`);
  }

  return {
    address,
    type: softString(v, "type", "", notes, path),
    name: softString(v, "name", "", notes, path),
    providerName: softString(v, "providerName", "", notes, path),
    actions,
    actionReason: optionalString(v, "actionReason"),
    replacePaths: optionalStringArray(v, "replacePaths"),
    attributeChanges,
  };
}

function coerceDriftResource(v: unknown, notes: string[], path: string): DriftResource | null {
  if (!isPlainObject(v)) {
    notes.push(`${path} skipped: not an object.`);
    return null;
  }
  const address = optionalString(v, "address");
  if (!address) {
    notes.push(`${path} skipped: missing "address".`);
    return null;
  }
  let attributeChanges = (Array.isArray(v["attributeChanges"]) ? (v["attributeChanges"] as unknown[]) : [])
    .map((a, i) => coerceAttrChange(a, notes, `${path}.attributeChanges[${i}]`))
    .filter((a): a is AttrChange => a !== null);
  if (attributeChanges.length > MAX_ATTR_CHANGES_PER_RESOURCE) {
    attributeChanges = attributeChanges.slice(0, MAX_ATTR_CHANGES_PER_RESOURCE);
    notes.push(`${path}.attributeChanges capped at ${MAX_ATTR_CHANGES_PER_RESOURCE} (tab-side defensive cap)`);
  }
  return {
    address,
    type: softString(v, "type", "", notes, path),
    name: softString(v, "name", "", notes, path),
    providerName: softString(v, "providerName", "", notes, path),
    attributeChanges,
  };
}

function coerceAttrChange(v: unknown, notes: string[], path: string): AttrChange | null {
  if (!isPlainObject(v)) {
    notes.push(`${path} skipped: not an object.`);
    return null;
  }
  const attrPath = optionalString(v, "path");
  if (attrPath === undefined) {
    notes.push(`${path} skipped: missing "path".`);
    return null;
  }
  return {
    path: attrPath,
    before: coerceRedactedValue(v["before"], notes, `${path}.before`),
    after: coerceRedactedValue(v["after"], notes, `${path}.after`),
  };
}

const OUTPUT_ACTIONS = ["create", "update", "delete", "no-op"] as const;

function coerceOutputChange(v: unknown, notes: string[], path: string): OutputChange | null {
  if (!isPlainObject(v)) {
    notes.push(`${path} skipped: not an object.`);
    return null;
  }
  const name = optionalString(v, "name");
  if (!name) {
    notes.push(`${path} skipped: missing "name".`);
    return null;
  }
  const action = v["action"];
  if (typeof action !== "string" || !(OUTPUT_ACTIONS as readonly string[]).includes(action)) {
    notes.push(`${path} skipped: missing/unrecognized "action".`);
    return null;
  }
  return {
    name,
    action: action as (typeof OUTPUT_ACTIONS)[number],
    value: coerceRedactedValue(v["value"], notes, `${path}.value`),
  };
}

// ---------------------------------------------------------------------------
// Apply digest
// ---------------------------------------------------------------------------

const APPLY_ACTIONS = ["create", "update", "delete", "replace", "read"] as const;
const APPLY_STATUSES = ["started", "complete", "errored"] as const;
const APPLY_OUTCOMES = ["succeeded", "failed"] as const;
const DIAGNOSTIC_SEVERITIES = ["error", "warning"] as const;

function coerceApplyDigest(
  obj: Record<string, unknown>,
  env: EnvelopeFields,
  lenient: boolean,
  notes: string[]
): FieldResult<ApplyDigest> {
  const summaryObj = requireObject(obj, "summary", lenient, notes, "digest");
  if (!summaryObj.ok) return summaryObj;
  const resourcesArr = requireArray(obj, "resources", lenient, notes, "digest");
  if (!resourcesArr.ok) return resourcesArr;
  const diagnosticsArr = requireArray(obj, "diagnostics", lenient, notes, "digest");
  if (!diagnosticsArr.ok) return diagnosticsArr;
  const outputsArr = requireArray(obj, "outputs", lenient, notes, "digest");
  if (!outputsArr.ok) return outputsArr;

  const outcome = softEnum(obj, "outcome", APPLY_OUTCOMES, "failed", notes, "digest");

  const summary = {
    add: softNumber(summaryObj.value, "add", 0, notes, "digest.summary"),
    change: softNumber(summaryObj.value, "change", 0, notes, "digest.summary"),
    destroy: softNumber(summaryObj.value, "destroy", 0, notes, "digest.summary"),
    durationMs: optionalNumber(summaryObj.value, "durationMs"),
  };

  let resources = resourcesArr.value
    .map((r, i) => coerceApplyResource(r, notes, `digest.resources[${i}]`))
    .filter((r): r is ApplyResource => r !== null);
  let truncated = env.truncated;
  const truncationNotes = env.truncationNotes ? [...env.truncationNotes] : [];
  if (resources.length > MAX_RESOURCES) {
    resources = resources.slice(0, MAX_RESOURCES);
    truncated = true;
    truncationNotes.push(`resource list capped at ${MAX_RESOURCES} (tab-side defensive cap)`);
  }

  let diagnostics = diagnosticsArr.value
    .map((d, i) => coerceDiagnostic(d, notes, `digest.diagnostics[${i}]`))
    .filter((d): d is Diagnostic => d !== null);
  if (diagnostics.length > MAX_DIAGNOSTICS) {
    diagnostics = diagnostics.slice(0, MAX_DIAGNOSTICS);
    truncated = true;
    truncationNotes.push(`diagnostics capped at ${MAX_DIAGNOSTICS} (tab-side defensive cap)`);
  }

  const outputs = outputsArr.value
    .map((o, i) => coerceOutputChange(o, notes, `digest.outputs[${i}]`))
    .filter((o): o is OutputChange => o !== null);

  const appliedBeforeFailure = optionalStringArray(obj, "appliedBeforeFailure");

  return {
    ok: true,
    value: {
      ...envelopeBase(env),
      truncated,
      truncationNotes: truncationNotes.length > 0 ? truncationNotes : undefined,
      kind: "apply",
      outcome,
      summary,
      resources,
      diagnostics,
      outputs,
      appliedBeforeFailure,
    },
  };
}

function coerceApplyResource(v: unknown, notes: string[], path: string): ApplyResource | null {
  if (!isPlainObject(v)) {
    notes.push(`${path} skipped: not an object.`);
    return null;
  }
  const address = optionalString(v, "address");
  if (!address) {
    notes.push(`${path} skipped: missing "address".`);
    return null;
  }
  const action = v["action"];
  if (typeof action !== "string" || !(APPLY_ACTIONS as readonly string[]).includes(action)) {
    notes.push(`${path} skipped: missing/unrecognized "action".`);
    return null;
  }
  const status = v["status"];
  const resolvedStatus =
    typeof status === "string" && (APPLY_STATUSES as readonly string[]).includes(status)
      ? (status as (typeof APPLY_STATUSES)[number])
      : ((notes.push(`${path}.status missing/unrecognized; defaulted to "started".`), "started" as const));
  return {
    address,
    action: action as (typeof APPLY_ACTIONS)[number],
    status: resolvedStatus,
    durationMs: optionalNumber(v, "durationMs"),
  };
}

function coerceDiagnostic(v: unknown, notes: string[], path: string): Diagnostic | null {
  if (!isPlainObject(v)) {
    notes.push(`${path} skipped: not an object.`);
    return null;
  }
  const severity = v["severity"];
  if (typeof severity !== "string" || !(DIAGNOSTIC_SEVERITIES as readonly string[]).includes(severity)) {
    notes.push(`${path} skipped: missing/unrecognized "severity".`);
    return null;
  }
  const summary = optionalString(v, "summary");
  if (summary === undefined) {
    notes.push(`${path} skipped: missing "summary".`);
    return null;
  }
  return {
    severity: severity as (typeof DIAGNOSTIC_SEVERITIES)[number],
    summary,
    detail: optionalString(v, "detail"),
    address: optionalString(v, "address"),
  };
}
