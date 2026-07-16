// PLAN DIGEST BUILDER — turns a parsed `terraform show -json <planfile>` object
// into a redacted `PlanDigest` (schemaVersion 1). Every attribute value flows
// through the redaction core (redact.ts) BEFORE it enters the digest, so no raw
// sensitive value is ever assembled. Pure and deterministic (§2.6): identical
// input -> byte-identical digest.
//
// Spec: docs/design/plan-apply-digest-spec.md §1.2 (shape), §2.1 (sensitivity
// sources), §2.7 (before/after asymmetry), §3 (caps). Source mapping (spec §1.2 /
// design §4.2): resource_changes[] (.change.actions/.before/.after/.after_unknown/
// .before_sensitive/.after_sensitive/.replace_paths, .action_reason),
// output_changes, resource_drift, terraform_version.

import {
  PlanDigest,
  PlanResource,
  DriftResource,
  AttrChange,
  OutputChange,
  RedactedValue,
} from './digest-schema';
import {
  MAX_RESOURCES,
  MAX_ATTR_CHANGES_PER_RESOURCE,
  MAX_OUTPUTS,
  MAX_DRIFT,
  MAX_NOTES,
  SOFT_MAX_DIGEST_BYTES,
  HARD_MAX_DIGEST_BYTES,
} from './caps';
import { redactValue, newRedactContext, deepEqual, capDigestBytes, RedactContext } from './redact';
import { sanitizeAttachmentName } from './secret-scrub';

/** Identity/provenance a caller supplies; kept out of the raw Terraform JSON. */
export interface DigestMeta {
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

// A Terraform "Change" object (shared by resource_changes[].change and
// output_changes[name]). All fields optional/defensive — a malformed plan must
// degrade, not throw.
interface TfChange {
  actions?: unknown;
  before?: unknown;
  after?: unknown;
  after_unknown?: unknown;
  before_sensitive?: unknown;
  after_sensitive?: unknown;
  replace_paths?: unknown;
}

const KNOWN_ACTIONS = new Set(['no-op', 'create', 'read', 'update', 'delete', 'replace', 'forget']);

/**
 * Build a redacted PlanDigest from a parsed `terraform show -json` object.
 * @param plan   parsed show -json (untrusted; validated defensively)
 * @param meta   provenance/identity supplied by the caller
 * @param limits optional test seam for the soft/hard byte ceilings
 */
export function buildPlanDigest(plan: unknown, meta: DigestMeta, limits?: DigestByteLimits): PlanDigest {
  const ctx = newRedactContext();
  const p = (plan && typeof plan === 'object' ? (plan as Record<string, unknown>) : {}) as Record<string, unknown>;

  const rawChanges = Array.isArray(p.resource_changes) ? (p.resource_changes as unknown[]) : [];
  let resources: PlanResource[] = [];
  for (const rc of rawChanges) {
    const res = buildPlanResource(rc, ctx);
    if (res) resources.push(res);
  }

  const summary = summarize(resources);

  // resources cap (§3): keep first MAX_RESOURCES by action priority (destroy/
  // replace first). Only reorder when truncating so the un-truncated common
  // case preserves Terraform's natural address order.
  const droppedResources = resources.length - MAX_RESOURCES;
  if (droppedResources > 0) {
    resources = [...resources]
      .sort((a, b) => actionPriority(a.actions) - actionPriority(b.actions) || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))
      .slice(0, MAX_RESOURCES);
    ctx.notes.push(`resource list capped at ${MAX_RESOURCES} (${droppedResources} more not shown)`);
  }

  const rawOutputs = p.output_changes && typeof p.output_changes === 'object' ? (p.output_changes as Record<string, unknown>) : {};
  let outputChanges: OutputChange[] = Object.keys(rawOutputs)
    .sort()
    .map((name) => buildOutputChange(name, rawOutputs[name], ctx))
    .filter((o): o is OutputChange => o !== null);
  // output cap (§3): keep the first MAX_OUTPUTS by name, note the remainder.
  const droppedOutputs = outputChanges.length - MAX_OUTPUTS;
  if (droppedOutputs > 0) {
    outputChanges = outputChanges.slice(0, MAX_OUTPUTS);
    ctx.notes.push(`output list capped at ${MAX_OUTPUTS} (${droppedOutputs} more not shown)`);
  }

  const rawDrift = Array.isArray(p.resource_drift) ? (p.resource_drift as unknown[]) : [];
  let drift: DriftResource[] = [];
  for (const rd of rawDrift) {
    const d = buildDriftResource(rd, ctx);
    if (d) drift.push(d);
  }
  summary.driftDetected = drift.length > 0;
  // drift cap (§3): keep the first MAX_DRIFT in address order, note the remainder.
  const droppedDrift = drift.length - MAX_DRIFT;
  if (droppedDrift > 0) {
    drift = drift.slice(0, MAX_DRIFT);
    ctx.notes.push(`drift list capped at ${MAX_DRIFT} (${droppedDrift} more not shown)`);
  }

  const toolVersion = typeof p.terraform_version === 'string' ? p.terraform_version : 'unknown';
  const safeName = sanitizeAttachmentName(meta.name);
  if (safeName.note) ctx.notes.push(safeName.note);

  const digest: PlanDigest = {
    schemaVersion: 1,
    kind: 'plan',
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
    summary,
    resources,
    outputChanges,
    ...(drift.length > 0 ? { drift } : {}),
  };
  finalizeTruncation(digest, ctx);

  return capDigestBytes(digest, limits?.softMaxBytes ?? SOFT_MAX_DIGEST_BYTES, limits?.hardMaxBytes ?? HARD_MAX_DIGEST_BYTES);
}

function buildPlanResource(rc: unknown, ctx: RedactContext): PlanResource | null {
  if (!rc || typeof rc !== 'object') return null;
  const r = rc as Record<string, unknown>;
  const address = typeof r.address === 'string' ? r.address : '';
  if (!address) return null;
  const change = (r.change && typeof r.change === 'object' ? r.change : {}) as TfChange;
  const actions = normalizeActions(change.actions);

  const resource: PlanResource = {
    address,
    type: typeof r.type === 'string' ? r.type : '',
    name: typeof r.name === 'string' ? r.name : '',
    providerName: typeof r.provider_name === 'string' ? r.provider_name : '',
    actions,
    attributeChanges: buildAttributeChanges(change, `${address}`, ctx),
  };
  if (typeof r.action_reason === 'string' && r.action_reason && r.action_reason !== 'none') {
    resource.actionReason = r.action_reason;
  }
  const replacePaths = normalizeReplacePaths(change.replace_paths);
  if (replacePaths.length > 0) resource.replacePaths = replacePaths;
  return resource;
}

function buildDriftResource(rd: unknown, ctx: RedactContext): DriftResource | null {
  if (!rd || typeof rd !== 'object') return null;
  const r = rd as Record<string, unknown>;
  const address = typeof r.address === 'string' ? r.address : '';
  if (!address) return null;
  const change = (r.change && typeof r.change === 'object' ? r.change : {}) as TfChange;
  return {
    address,
    type: typeof r.type === 'string' ? r.type : '',
    name: typeof r.name === 'string' ? r.name : '',
    providerName: typeof r.provider_name === 'string' ? r.provider_name : '',
    attributeChanges: buildAttributeChanges(change, `${address}`, ctx),
  };
}

/**
 * Diff a Change's top-level attributes and emit only the CHANGED ones as masked
 * AttrChange[]. `before` is redacted with `before_sensitive` and NO unknown mask;
 * `after` with `after_sensitive` AND `after_unknown` (spec §2.7). A missing side
 * (create -> before=null; delete -> after=null) yields a JSON null for that side.
 */
function buildAttributeChanges(change: TfChange, addressPath: string, ctx: RedactContext): AttrChange[] {
  const before = change.before;
  const after = change.after;
  const beforeObj = before && typeof before === 'object' && !Array.isArray(before) ? (before as Record<string, unknown>) : null;
  const afterObj = after && typeof after === 'object' && !Array.isArray(after) ? (after as Record<string, unknown>) : null;

  const keys = new Set<string>();
  if (beforeObj) for (const k of Object.keys(beforeObj)) keys.add(k);
  if (afterObj) for (const k of Object.keys(afterObj)) keys.add(k);

  const changes: AttrChange[] = [];
  for (const key of [...keys].sort()) {
    if (UNSAFE_ATTR_KEYS.has(key)) {
      ctx.notes.push(`dropped unsafe attribute key '${key}' at ${addressPath}`);
      continue;
    }
    const rawBefore = beforeObj ? beforeObj[key] : null;
    const rawAfter = afterObj ? afterObj[key] : null;
    const uMask = prop(change.after_unknown, key);
    const changed = !deepEqual(rawBefore, rawAfter) || anyTrue(uMask);
    if (!changed) continue;

    ctx.path = `${addressPath}.${key}`;
    const beforeRV: RedactedValue = redactValue(rawBefore, prop(change.before_sensitive, key), false, ctx);
    const afterRV: RedactedValue = redactValue(rawAfter, prop(change.after_sensitive, key), uMask, ctx);
    ctx.path = '';
    changes.push({ path: key, before: beforeRV, after: afterRV });
  }

  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const dropped = changes.length - MAX_ATTR_CHANGES_PER_RESOURCE;
  if (dropped > 0) {
    ctx.notes.push(`attribute changes for ${addressPath} capped at ${MAX_ATTR_CHANGES_PER_RESOURCE} (${dropped} more not shown)`);
    return changes.slice(0, MAX_ATTR_CHANGES_PER_RESOURCE);
  }
  return changes;
}

function buildOutputChange(name: string, oc: unknown, ctx: RedactContext): OutputChange | null {
  if (!oc || typeof oc !== 'object') return null;
  const change = oc as TfChange;
  ctx.path = `output.${name}`;
  const value = redactValue(change.after, change.after_sensitive, change.after_unknown, ctx);
  ctx.path = '';
  return { name, action: classifyOutputAction(change.actions), value };
}

// ---- classification / normalization helpers ----

function normalizeActions(actions: unknown): PlanResource['actions'] {
  if (!Array.isArray(actions)) return ['no-op'];
  const out = actions.filter((a): a is PlanResource['actions'][number] => typeof a === 'string' && KNOWN_ACTIONS.has(a));
  return out.length > 0 ? out : ['no-op'];
}

// A replace is the two-element ["delete","create"] / ["create","delete"] array
// Terraform emits (there is no single "replace" token in show -json).
function isReplace(actions: string[]): boolean {
  return actions.length === 2 && actions.includes('create') && actions.includes('delete');
}

function summarize(resources: PlanResource[]): PlanDigest['summary'] {
  let add = 0;
  let change = 0;
  let destroy = 0;
  let replace = 0;
  let read = 0;
  let allNoOp = true;
  for (const r of resources) {
    const a = r.actions;
    if (!(a.length === 1 && a[0] === 'no-op')) allNoOp = false;
    if (isReplace(a)) {
      replace++;
      add++;
      destroy++;
    } else if (a.length === 1) {
      switch (a[0]) {
        case 'create':
          add++;
          break;
        case 'update':
          change++;
          break;
        case 'delete':
          destroy++;
          break;
        case 'read':
          read++;
          break;
        default:
          break; // no-op / forget contribute to no bucket
      }
    }
  }
  return { add, change, destroy, replace, read, noChanges: allNoOp, driftDetected: false };
}

function classifyOutputAction(actions: unknown): OutputChange['action'] {
  if (!Array.isArray(actions)) return 'no-op';
  const a = actions.filter((x): x is string => typeof x === 'string');
  if (a.length === 2 && a.includes('create') && a.includes('delete')) return 'update';
  if (a.includes('create')) return 'create';
  if (a.includes('delete')) return 'delete';
  if (a.includes('update')) return 'update';
  return 'no-op';
}

// Action priority for the MAX_RESOURCES cap (spec §3): delete/replace first,
// then update, create, read, no-op — most consequential changes survive.
function actionPriority(actions: string[]): number {
  if (isReplace(actions)) return 0;
  if (actions.includes('delete')) return 0;
  if (actions.includes('update')) return 1;
  if (actions.includes('create')) return 2;
  if (actions.includes('read')) return 3;
  return 4;
}

function normalizeReplacePaths(replacePaths: unknown): string[] {
  if (!Array.isArray(replacePaths)) return [];
  const out: string[] = [];
  for (const path of replacePaths) {
    if (!Array.isArray(path)) continue;
    let s = '';
    for (const seg of path) {
      if (typeof seg === 'number') s += `[${seg}]`;
      else if (typeof seg === 'string') s += s === '' ? seg : `.${seg}`;
    }
    if (s) out.push(s);
  }
  return out;
}

// Local copies of the small helpers redact.ts uses internally, kept private here
// so plan-digest does not depend on redact.ts internals it should not import.
const UNSAFE_ATTR_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function prop(mask: unknown, key: string): unknown {
  return mask !== null && typeof mask === 'object' && !Array.isArray(mask) ? (mask as Record<string, unknown>)[key] : false;
}
function anyTrue(mask: unknown): boolean {
  if (mask === true) return true;
  if (Array.isArray(mask)) return mask.some(anyTrue);
  if (mask !== null && typeof mask === 'object') return Object.values(mask as Record<string, unknown>).some(anyTrue);
  return false;
}

function finalizeTruncation(digest: PlanDigest, ctx: RedactContext): void {
  if (ctx.notes.length > 0) {
    digest.truncated = true;
    digest.truncationNotes = capNotes(ctx.notes);
  }
}

// truncationNotes cap (§3): a pathological plan can generate one note per capped
// resource, so bound the array itself. Keep the first MAX_NOTES and collapse the
// remainder into a single count note so the truncation stays observable.
export function capNotes(notes: string[]): string[] {
  if (notes.length <= MAX_NOTES) return [...notes];
  const dropped = notes.length - MAX_NOTES;
  return [...notes.slice(0, MAX_NOTES), `truncation notes capped at ${MAX_NOTES} (${dropped} more not shown)`];
}
