// APPLY DIGEST BUILDER — turns a `terraform apply -json` NDJSON event stream into
// a redacted `ApplyDigest` (schemaVersion 1). Structured (secret-bearing) event
// fields are only ever consumed here and pass through redaction / secret-scrub
// before entering the digest; the live console log is preserved separately by the
// task echoing each event's `@message` (decision D2 — not this module's job).
//
// Spec: docs/design/plan-apply-digest-spec.md §1.3 (shape), §4.9 (diagnostic
// scrub), §3 (caps). Source events (spec §1.3 / design §4.3): apply_start /
// apply_progress / apply_complete / apply_errored, diagnostic, change_summary,
// outputs, version. A malformed / partial NDJSON line is skipped + noted, never
// thrown (§12.2).

import { ApplyDigest, ApplyResource, Diagnostic, OutputChange } from './digest-schema';
import { MAX_RESOURCES, MAX_DIAGNOSTICS, MAX_OUTPUTS, SOFT_MAX_DIGEST_BYTES, HARD_MAX_DIGEST_BYTES } from './caps';
import { redactValue, newRedactContext, capDigestBytes, RedactContext } from './redact';
import { scrubSecrets, sanitizeAttachmentName } from './secret-scrub';
import { DigestBuildMeta, DigestByteLimits, capNotes } from './plan-digest';

/** Apply-specific build options (diagnostic handling + the byte-cap test seam). */
export interface ApplyDigestOptions extends DigestByteLimits {
  /**
   * Emit diagnostic freeform text at all? Default true (safe-default mode
   * includes `summary` + `address`). Setting false is the operator opt-OUT for
   * the provider-echoed-secret residual (§5.4/§5.10): the whole `diagnostics`
   * array is omitted so no freeform provider text (`summary`/`detail`) reaches
   * the attachment — the failure is still detectable via `outcome` and the
   * agent-secret-masked live console log. `includeDiagnosticDetail` is the
   * narrower opt-in that only adds the longer `detail`; this is the broader
   * opt-out that removes both.
   */
  includeDiagnostics?: boolean;
  /** Include scrubbed diagnostic `detail`? Safe default false (§5.4). */
  includeDiagnosticDetail?: boolean;
  /**
   * Secrets to string-replace out of freeform diagnostics. NOTE: the production
   * call site passes `[]` — the task has no general readback of every value it
   * registered via setSecret() across the provider handlers, so in production
   * the freeform scrub relies on secret-scrub.ts's PEM/high-entropy heuristic
   * alone (documented residual — SECURITY.md / §5.10). This parameter remains a
   * supported input for callers/tests that DO know specific secrets.
   */
  knownSecrets?: string[];
}

const RES_ACTIONS = new Set(['create', 'update', 'delete', 'replace', 'read']);

interface ResAcc {
  address: string;
  action: ApplyResource['action'];
  status: ApplyResource['status'];
  startTs?: number;
  endTs?: number;
  elapsedSeconds?: number;
  order: number;
}

/**
 * Build a redacted ApplyDigest from the raw `terraform apply -json` NDJSON stream.
 * @param ndjson  the raw multi-line stdout of `apply -json`
 * @param meta    provenance/identity supplied by the caller
 * @param options diagnostic-detail toggle, known secrets, byte-cap test seam
 */
export function buildApplyDigest(ndjson: string, meta: DigestBuildMeta, options?: ApplyDigestOptions): ApplyDigest {
  const ctx = newRedactContext();
  const includeDiagnostics = options?.includeDiagnostics !== false;
  const includeDetail = options?.includeDiagnosticDetail === true;
  const knownSecrets = options?.knownSecrets ?? [];

  const events = parseNdjson(ndjson, ctx);

  const resAcc = new Map<string, ResAcc>();
  const diagnostics: Diagnostic[] = [];
  const appliedOrder: string[] = [];
  let sawErroredEvent = false;
  let sawErrorDiag = false;
  let changeSummary: { add: number; change: number; destroy: number } | undefined;
  let latestOutputs: Record<string, unknown> | undefined;
  let toolVersion = 'unknown';
  let minTs: number | undefined;
  let maxTs: number | undefined;
  let order = 0;

  for (const ev of events) {
    const ts = parseTs((ev as Record<string, unknown>)['@timestamp']);
    if (ts !== undefined) {
      if (minTs === undefined || ts < minTs) minTs = ts;
      if (maxTs === undefined || ts > maxTs) maxTs = ts;
    }
    const type = typeof (ev as Record<string, unknown>).type === 'string' ? ((ev as Record<string, unknown>).type as string) : '';
    const e = ev as Record<string, unknown>;

    switch (type) {
      case 'version': {
        if (typeof e.terraform === 'string') toolVersion = e.terraform;
        break;
      }
      case 'apply_start': {
        const { addr, action } = hookInfo(e);
        if (addr) {
          const acc = ensureAcc(resAcc, addr, action, order++);
          acc.status = 'started';
          if (ts !== undefined) acc.startTs = ts;
        }
        break;
      }
      case 'apply_complete': {
        const { addr, action, elapsed } = hookInfo(e);
        if (addr) {
          const acc = ensureAcc(resAcc, addr, action, order++);
          acc.status = 'complete';
          if (ts !== undefined) acc.endTs = ts;
          if (elapsed !== undefined) acc.elapsedSeconds = elapsed;
          appliedOrder.push(addr);
        }
        break;
      }
      case 'apply_errored': {
        sawErroredEvent = true;
        const { addr, action } = hookInfo(e);
        if (addr) {
          const acc = ensureAcc(resAcc, addr, action, order++);
          acc.status = 'errored';
          if (ts !== undefined) acc.endTs = ts;
        }
        break;
      }
      case 'diagnostic': {
        // Always build so an error-severity diagnostic still flips the outcome
        // to 'failed' even when emission is disabled; only push (emit the
        // freeform text) when diagnostics are included (§5.10 opt-out).
        const diag = buildDiagnostic(e, includeDetail, knownSecrets);
        if (diag) {
          if (diag.severity === 'error') sawErrorDiag = true;
          if (includeDiagnostics) diagnostics.push(diag);
        }
        break;
      }
      case 'change_summary': {
        const cs = e.changes && typeof e.changes === 'object' ? (e.changes as Record<string, unknown>) : undefined;
        if (cs) {
          changeSummary = {
            add: num(cs.add),
            change: num(cs.change),
            destroy: num(cs.remove),
          };
        }
        break;
      }
      case 'outputs': {
        if (e.outputs && typeof e.outputs === 'object') latestOutputs = e.outputs as Record<string, unknown>;
        break;
      }
      default:
        break;
    }
  }

  // resources in first-seen order
  let resources: ApplyResource[] = [...resAcc.values()]
    .sort((a, b) => a.order - b.order)
    .map((acc) => {
      const r: ApplyResource = { address: acc.address, action: acc.action, status: acc.status };
      const dur = durationMs(acc);
      if (dur !== undefined) r.durationMs = dur;
      return r;
    });

  const droppedResources = resources.length - MAX_RESOURCES;
  if (droppedResources > 0) {
    resources = [...resources]
      .sort((a, b) => actionPriority(a.action) - actionPriority(b.action) || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))
      .slice(0, MAX_RESOURCES);
    ctx.notes.push(`resource list capped at ${MAX_RESOURCES} (${droppedResources} more not shown)`);
  }

  const cappedDiags = capDiagnostics(diagnostics, ctx);

  const outputs = buildOutputs(latestOutputs, ctx);

  const outcome: ApplyDigest['outcome'] = sawErroredEvent || sawErrorDiag ? 'failed' : 'succeeded';
  const summary = buildSummary(changeSummary, resources, minTs, maxTs);

  // appliedBeforeFailure cap (§3): an adversarial NDJSON can emit unbounded
  // apply_complete lines (this list, unlike `resources`, is not de-duplicated by
  // address), so bound it to MAX_RESOURCES and note the remainder.
  let appliedBeforeFailure = appliedOrder;
  const droppedApplied = appliedBeforeFailure.length - MAX_RESOURCES;
  if (outcome === 'failed' && droppedApplied > 0) {
    appliedBeforeFailure = appliedBeforeFailure.slice(0, MAX_RESOURCES);
    ctx.notes.push(`applied-before-failure list capped at ${MAX_RESOURCES} (${droppedApplied} more not shown)`);
  }

  const safeName = sanitizeAttachmentName(meta.name);
  if (safeName.note) ctx.notes.push(safeName.note);

  const digest: ApplyDigest = {
    schemaVersion: 1,
    kind: 'apply',
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
    outcome,
    summary,
    resources,
    diagnostics: cappedDiags,
    outputs,
    ...(outcome === 'failed' ? { appliedBeforeFailure } : {}),
  };
  finalizeTruncation(digest, ctx);

  return capDigestBytes(digest, options?.softMaxBytes ?? SOFT_MAX_DIGEST_BYTES, options?.hardMaxBytes ?? HARD_MAX_DIGEST_BYTES);
}

// ---- parsing / accumulation helpers ----

/**
 * Tolerantly parses an NDJSON stream into its object events: splits on newlines,
 * strips a trailing CR, skips blank lines, JSON.parses each, and silently drops
 * any line that fails to parse or is not a JSON object (counting them). This is
 * the single shared implementation of the "split NDJSON, skip malformed lines"
 * loop that apply's digest builder here and base-terraform-command-handler.ts's
 * lighter-weight error-extraction / console-echo passes all need to agree on
 * (#781); callers that don't care about the malformed count simply ignore it.
 */
export function parseNdjsonLines(ndjson: string): { events: unknown[]; malformed: number } {
  const events: unknown[] = [];
  let malformed = 0;
  if (typeof ndjson !== 'string') return { events, malformed };
  for (const rawLine of ndjson.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (line === '') continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') events.push(parsed);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { events, malformed };
}

function parseNdjson(ndjson: string, ctx: RedactContext): unknown[] {
  const { events, malformed } = parseNdjsonLines(ndjson);
  if (malformed > 0) ctx.notes.push(`skipped ${malformed} malformed apply event line(s)`);
  return events;
}

function ensureAcc(map: Map<string, ResAcc>, address: string, action: ApplyResource['action'], order: number): ResAcc {
  let acc = map.get(address);
  if (!acc) {
    acc = { address, action, status: 'started', order };
    map.set(address, acc);
  } else if (acc.action === 'update' && action !== 'update') {
    // Upgrade a defaulted-'update' action if a later event carries a concrete
    // one (deterministic — apply_start usually carries the real action).
    acc.action = action;
  }
  return acc;
}

function hookInfo(e: Record<string, unknown>): { addr: string; action: ApplyResource['action']; elapsed?: number } {
  const hook = e.hook && typeof e.hook === 'object' ? (e.hook as Record<string, unknown>) : {};
  const resource = hook.resource && typeof hook.resource === 'object' ? (hook.resource as Record<string, unknown>) : {};
  const addr = typeof resource.addr === 'string' ? resource.addr : '';
  const action = normalizeApplyAction(hook.action);
  const elapsed = typeof hook.elapsed_seconds === 'number' && isFinite(hook.elapsed_seconds) ? hook.elapsed_seconds : undefined;
  return { addr, action, elapsed };
}

function normalizeApplyAction(action: unknown): ApplyResource['action'] {
  if (typeof action === 'string' && RES_ACTIONS.has(action)) return action as ApplyResource['action'];
  return 'update';
}

function buildDiagnostic(e: Record<string, unknown>, includeDetail: boolean, knownSecrets: string[]): Diagnostic | null {
  const d = e.diagnostic && typeof e.diagnostic === 'object' ? (e.diagnostic as Record<string, unknown>) : null;
  if (!d) return null;
  const severity: Diagnostic['severity'] = d.severity === 'error' ? 'error' : 'warning';
  const summary = scrubSecrets(typeof d.summary === 'string' ? d.summary : '', knownSecrets);
  const diag: Diagnostic = { severity, summary };
  if (includeDetail && typeof d.detail === 'string' && d.detail.length > 0) {
    diag.detail = scrubSecrets(d.detail, knownSecrets);
  }
  if (typeof d.address === 'string' && d.address.length > 0) diag.address = d.address;
  return diag;
}

function capDiagnostics(diagnostics: Diagnostic[], ctx: RedactContext): Diagnostic[] {
  if (diagnostics.length <= MAX_DIAGNOSTICS) return diagnostics;
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');
  const ordered = [...errors, ...warnings];
  const dropped = ordered.length - MAX_DIAGNOSTICS;
  ctx.notes.push(`diagnostics capped at ${MAX_DIAGNOSTICS} (${dropped} more not shown)`);
  return ordered.slice(0, MAX_DIAGNOSTICS);
}

function buildOutputs(latestOutputs: Record<string, unknown> | undefined, ctx: RedactContext): OutputChange[] {
  if (!latestOutputs) return [];
  let names = Object.keys(latestOutputs).sort();
  // output cap (§3): keep the first MAX_OUTPUTS by name, note the remainder.
  const droppedOutputs = names.length - MAX_OUTPUTS;
  if (droppedOutputs > 0) {
    names = names.slice(0, MAX_OUTPUTS);
    ctx.notes.push(`output list capped at ${MAX_OUTPUTS} (${droppedOutputs} more not shown)`);
  }
  return names.map((name) => {
    const raw = latestOutputs[name];
    const entry = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const sensitive = entry.sensitive === true;
    ctx.path = `output.${name}`;
    const value = redactValue(entry.value, sensitive, false, ctx);
    ctx.path = '';
    const action: OutputChange['action'] =
      entry.action === 'create' || entry.action === 'update' || entry.action === 'delete' || entry.action === 'no-op'
        ? (entry.action as OutputChange['action'])
        : 'no-op';
    return { name, action, value };
  });
}

function buildSummary(
  changeSummary: { add: number; change: number; destroy: number } | undefined,
  resources: ApplyResource[],
  minTs: number | undefined,
  maxTs: number | undefined,
): ApplyDigest['summary'] {
  let add: number;
  let change: number;
  let destroy: number;
  if (changeSummary) {
    add = changeSummary.add;
    change = changeSummary.change;
    destroy = changeSummary.destroy;
  } else {
    add = 0;
    change = 0;
    destroy = 0;
    for (const r of resources) {
      if (r.action === 'replace') {
        add++;
        destroy++;
      } else if (r.action === 'create') add++;
      else if (r.action === 'update') change++;
      else if (r.action === 'delete') destroy++;
    }
  }
  const summary: ApplyDigest['summary'] = { add, change, destroy };
  if (minTs !== undefined && maxTs !== undefined && maxTs >= minTs) summary.durationMs = maxTs - minTs;
  return summary;
}

function durationMs(acc: ResAcc): number | undefined {
  if (acc.startTs !== undefined && acc.endTs !== undefined && acc.endTs >= acc.startTs) return acc.endTs - acc.startTs;
  if (acc.elapsedSeconds !== undefined) return Math.round(acc.elapsedSeconds * 1000);
  return undefined;
}

function actionPriority(action: ApplyResource['action']): number {
  switch (action) {
    case 'delete':
    case 'replace':
      return 0;
    case 'update':
      return 1;
    case 'create':
      return 2;
    case 'read':
      return 3;
    default:
      return 4;
  }
}

function parseTs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return isNaN(t) ? undefined : t;
}

function num(v: unknown): number {
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

function finalizeTruncation(digest: ApplyDigest, ctx: RedactContext): void {
  if (ctx.notes.length > 0) {
    digest.truncated = true;
    digest.truncationNotes = capNotes(ctx.notes);
  }
}
