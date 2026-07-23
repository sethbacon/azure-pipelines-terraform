// STATE INVENTORY DIGEST BUILDER — turns a parsed `terraform show -json` of the
// CURRENT state (no plan file) into a redacted `StateDigest` (schemaVersion 1).
// Unlike plan/apply this is a point-in-time INVENTORY: each resource carries its
// CURRENT attribute values only — NO change actions, NO before/after, NO
// known-after-apply. Every attribute value flows through the SAME redaction core
// (redact.ts `redactValue`) BEFORE it enters the digest, redacted against that
// resource's `sensitive_values` mask, so no raw sensitive value is ever
// assembled. Pure and deterministic (§2.6): identical input -> byte-identical
// digest.
//
// Spec: docs/design/plan-apply-digest-spec.md §1.4 (shape), §7.2 (the walk +
// redaction algorithm), §7.3 (state outputs), §7.4 (caps). Design source:
// docs/initiatives/structured-plan-apply-tabs.md §5.5. Source mapping (spec §1.4
// / §7.2): values.root_module.resources[] (.address/.type/.name/.provider_name/
// .mode/.values/.sensitive_values) recursing values.root_module.child_modules[],
// values.outputs (.value/.sensitive), terraform_version.

import {
  StateDigest,
  StateResource,
  OutputValue,
  RedactedValue,
} from './digest-schema';
import {
  MAX_STATE_RESOURCES,
  MAX_STATE_ATTRS_PER_RESOURCE,
  MAX_OUTPUTS,
  SOFT_MAX_DIGEST_BYTES,
  HARD_MAX_DIGEST_BYTES,
} from './caps';
import { redactValue, newRedactContext, capDigestBytes, RedactContext } from './redact';
import { DigestBuildMeta, DigestByteLimits, capNotes } from './digest-common';
import { sanitizeAttachmentName } from './secret-scrub';

// State has no unknown/after-apply values — everything is materialized (spec
// §7.2 "No unknown for state"). A single shared `false` mask is fed as the
// unknown argument to every redactValue call so {kind:"unknown"} can never occur
// in a StateDigest.
const NO_UNKNOWN_MASK = false;

// Prototype-pollution guard (§2.5): attribute names come straight from the state
// JSON, so a hostile key must never be walked into Object.prototype nor used as a
// mask-lookup key. Mirrors redact.ts / plan-digest.ts.
const UNSAFE_ATTR_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Build a redacted StateDigest from a parsed `terraform show -json` STATE object.
 * @param state   parsed show -json of the current state (untrusted; validated defensively)
 * @param meta    provenance/identity supplied by the caller
 * @param options optional test seam for the soft/hard byte ceilings
 */
export function buildStateDigest(state: unknown, meta: DigestBuildMeta, options?: DigestByteLimits): StateDigest {
  const ctx = newRedactContext();
  const s = obj(state);
  const values = obj(s.values);
  const rootModule = obj(values.root_module);

  // Walk root + child_modules in array order, flattening the module path into
  // each resource's address (spec §7.2).
  const resources: StateResource[] = [];
  walkModule(rootModule, '', resources, ctx);

  // resources cap (§7.4): state has no natural action priority, so keep the first
  // MAX_STATE_RESOURCES in WALK ORDER and note the remainder.
  let kept = resources;
  const droppedResources = resources.length - MAX_STATE_RESOURCES;
  if (droppedResources > 0) {
    kept = resources.slice(0, MAX_STATE_RESOURCES);
    ctx.notes.push(`state resource list capped at ${MAX_STATE_RESOURCES} (${droppedResources} more not shown)`);
  }

  const outputs = buildStateOutputs(values.outputs, ctx);

  // Counts are over the KEPT resources (spec §7.2); managed / data are disjoint.
  let resourceCount = 0;
  let dataSourceCount = 0;
  for (const r of kept) {
    if (r.mode === 'data') dataSourceCount++;
    else resourceCount++;
  }

  const toolVersion = typeof s.terraform_version === 'string' ? s.terraform_version : 'unknown';
  const safeName = sanitizeAttachmentName(meta.name);
  if (safeName.note) ctx.notes.push(safeName.note);

  const digest: StateDigest = {
    schemaVersion: 1,
    kind: 'state',
    producedBy: { task: 'TerraformTaskV5', taskVersion: meta.taskVersion },
    tool: { name: meta.toolName, version: toolVersion },
    meta: {
      name: safeName.name,
      ...(meta.workingDirectory !== undefined ? { workingDirectory: meta.workingDirectory } : {}),
      ...(meta.stage !== undefined ? { stage: meta.stage } : {}),
      ...(meta.job !== undefined ? { job: meta.job } : {}),
      createdIso: meta.createdIso,
    },
    truncated: false,
    summary: { resourceCount, dataSourceCount },
    resources: kept,
    outputs,
  };
  finalizeTruncation(digest, ctx);

  return capDigestBytes(digest, options?.softMaxBytes ?? SOFT_MAX_DIGEST_BYTES, options?.hardMaxBytes ?? HARD_MAX_DIGEST_BYTES);
}

/**
 * Recurse a module node (root or child): emit each `resources[]` entry in array
 * order, then descend into every `child_modules[]` (spec §7.2). `moduleAddress`
 * is the full module path of the CURRENT module ("" at the root, "module.db" one
 * level down, "module.db.module.inner" deeper) and is flattened into each child
 * resource via the resource's own already-qualified `address`.
 */
function walkModule(module: Record<string, unknown>, moduleAddress: string, out: StateResource[], ctx: RedactContext): void {
  const rawResources = Array.isArray(module.resources) ? (module.resources as unknown[]) : [];
  for (const r of rawResources) {
    const built = buildStateResource(r, moduleAddress, ctx);
    if (built) out.push(built);
  }
  const children = Array.isArray(module.child_modules) ? (module.child_modules as unknown[]) : [];
  for (const child of children) {
    const c = obj(child);
    // child.address is the full module path (e.g. "module.db"); fall back to the
    // parent path if a malformed node omits it, so a missing address never
    // silently reparents the subtree to the root.
    const childAddress = typeof c.address === 'string' && c.address ? c.address : moduleAddress;
    walkModule(c, childAddress, out, ctx);
  }
}

/**
 * Redact one state resource into a StateResource. Each entry of `values` is
 * redacted against the shape-parallel `sensitive_values` mask via the SHARED
 * `redactValue` (no unknown mask — state is materialized). Attribute names are
 * sorted lexicographically (determinism + the §7.4 alpha cap) and prototype-
 * pollution keys are dropped. Returns null for an entry without a string address
 * (mirrors the plan builder's tolerance for malformed input).
 */
function buildStateResource(raw: unknown, moduleAddress: string, ctx: RedactContext): StateResource | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const address = typeof r.address === 'string' ? r.address : '';
  if (!address) return null;

  const values = r.values && typeof r.values === 'object' && !Array.isArray(r.values) ? (r.values as Record<string, unknown>) : {};
  const sensitiveValues = r.sensitive_values;

  let attributes: { name: string; value: RedactedValue }[] = [];
  for (const name of Object.keys(values).sort()) {
    if (UNSAFE_ATTR_KEYS.has(name)) {
      ctx.notes.push(`dropped unsafe attribute key '${name}' at ${address}`);
      continue;
    }
    ctx.path = `${address}.${name}`;
    const value = redactValue(values[name], prop(sensitiveValues, name), NO_UNKNOWN_MASK, ctx);
    ctx.path = '';
    attributes.push({ name, value });
  }

  // per-resource attribute cap (§7.4): keep the first MAX_STATE_ATTRS_PER_RESOURCE
  // alphabetically (already sorted) and note the remainder.
  const droppedAttrs = attributes.length - MAX_STATE_ATTRS_PER_RESOURCE;
  if (droppedAttrs > 0) {
    ctx.notes.push(`attributes for ${address} capped at ${MAX_STATE_ATTRS_PER_RESOURCE} (${droppedAttrs} more not shown)`);
    attributes = attributes.slice(0, MAX_STATE_ATTRS_PER_RESOURCE);
  }

  const resource: StateResource = {
    address,
    type: typeof r.type === 'string' ? r.type : '',
    name: typeof r.name === 'string' ? r.name : '',
    providerName: typeof r.provider_name === 'string' ? r.provider_name : '',
    // Terraform always emits "managed" or "data"; a malformed/absent mode is
    // treated as "managed" so the union stays sound (and is counted as a managed
    // resource, never silently as a data source).
    mode: r.mode === 'data' ? 'data' : 'managed',
    ...(moduleAddress ? { moduleAddress } : {}),
    attributes,
  };
  return resource;
}

/**
 * Redact `values.outputs` (a map name -> { value, type, sensitive }) into
 * OutputValue[] (spec §7.3 — NO action, state is not a change set). The whole-
 * output `sensitive` flag is fed straight into `redactValue` as the sensitivity
 * mask (no unknown mask), so `sensitive === true` yields `{kind:"sensitive"}` and
 * the raw value never enters the digest. Sorted by name and bounded by
 * MAX_OUTPUTS (§3).
 */
function buildStateOutputs(rawOutputs: unknown, ctx: RedactContext): OutputValue[] {
  const outputsMap = rawOutputs && typeof rawOutputs === 'object' && !Array.isArray(rawOutputs) ? (rawOutputs as Record<string, unknown>) : {};
  let outputs: OutputValue[] = [];
  for (const name of Object.keys(outputsMap).sort()) {
    if (UNSAFE_ATTR_KEYS.has(name)) {
      ctx.notes.push(`dropped unsafe output key '${name}'`);
      continue;
    }
    const o = obj(outputsMap[name]);
    ctx.path = `output.${name}`;
    const value = redactValue(o.value, o.sensitive, NO_UNKNOWN_MASK, ctx);
    ctx.path = '';
    outputs.push({ name, value });
  }
  const droppedOutputs = outputs.length - MAX_OUTPUTS;
  if (droppedOutputs > 0) {
    outputs = outputs.slice(0, MAX_OUTPUTS);
    ctx.notes.push(`output list capped at ${MAX_OUTPUTS} (${droppedOutputs} more not shown)`);
  }
  return outputs;
}

// ---- small local helpers ----

/** Coerce an unknown to a plain (non-array) record; non-objects become {}. */
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

// Shape-parallel mask lookup: an absent key means "not sensitive" (false),
// matching Terraform's sparse sensitive_values maps. Private copy kept out of
// redact.ts internals, mirroring plan-digest.ts.
function prop(mask: unknown, key: string): unknown {
  return mask !== null && typeof mask === 'object' && !Array.isArray(mask) ? (mask as Record<string, unknown>)[key] : false;
}

function finalizeTruncation(digest: StateDigest, ctx: RedactContext): void {
  if (ctx.notes.length > 0) {
    digest.truncated = true;
    digest.truncationNotes = capNotes(ctx.notes);
  }
}
