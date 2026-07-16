// SHARED MODULE — intentionally duplicated, BYTE-IDENTICAL, between
//   Tasks/TerraformTask/TerraformTaskV5/src/results/digest-schema.ts  (task-side, PRODUCES the digest)
//   src/tab/digest-schema.ts                                          (tab-side,  CONSUMES the digest)
// scripts/check-shared-modules.js enforces that the two copies stay byte-identical
// and fails CI on any divergence, so a change here MUST be applied to BOTH copies
// in the same commit. The duplication is deliberate (design decision D4): the task
// compiles with `tsc -b` and the tab bundles from a separate webpack root, so a
// single shared import cannot span both build boundaries without restructuring the
// build — out of proportion to the benefit. The parity gate gives the same
// guarantee at lower blast radius (same pattern as gpg-verifier.ts / https-client.ts
// / uri-scheme-guard.ts).
//
// FROZEN DIGEST CONTRACT — schemaVersion 1. This is the normative TypeScript shape
// of the REDACTED plan/apply digest that the task attaches (terraform-plan-summary /
// terraform-apply-summary) and the tab renders. See:
//   docs/design/plan-apply-digest-spec.md                 (redaction algorithm + schemaVersion history)
//   docs/initiatives/structured-plan-apply-tabs.md §4     (design source of these interfaces)
// Every string in a digest is POST-REDACTION and is rendered by the tab as a React
// TEXT NODE only (never HTML — no dangerouslySetInnerHTML in the structured path).

/** Fields shared by every digest document (both plan and apply). */
export interface DigestEnvelope {
  schemaVersion: 1;
  kind: "plan" | "apply";
  producedBy: { task: "TerraformTaskV5"; taskVersion: string };
  tool: { name: "terraform" | "opentofu"; version: string };
  meta: {
    name: string;               // publish name (attachment name), also echoed here (validated)
    workingDirectory?: string;  // relative path only; never absolute host paths
    stage?: string; job?: string;
    createdIso: string;         // from agent-provided timestamp, not Date.now() in workflow context
  };
  truncated: boolean;           // true if any size cap (see spec §6) was hit
  truncationNotes?: string[];   // human-readable ("resource list capped at 2000", etc.)
}

/** Plan digest — built from `terraform show -json <planfile>`. */
export interface PlanDigest extends DigestEnvelope {
  kind: "plan";
  summary: {
    add: number; change: number; destroy: number; replace: number; read: number;
    noChanges: boolean;
    driftDetected: boolean;
  };
  resources: PlanResource[];       // capped; see spec §6
  outputChanges: OutputChange[];   // masked
  drift?: DriftResource[];         // from resource_drift, masked
}

export interface PlanResource {
  address: string;                 // e.g. module.db.aws_db_instance.this[0]
  type: string; name: string; providerName: string;
  actions: ("no-op" | "create" | "read" | "update" | "delete" | "replace" | "forget")[];
  actionReason?: string;           // e.g. "replace_because_cannot_update"
  replacePaths?: string[];         // attribute paths forcing replacement (from replace_paths)
  attributeChanges: AttrChange[];  // ONLY changed attrs; capped per resource
}

export interface AttrChange {
  path: string;                    // dotted/indexed attribute path
  before: RedactedValue;
  after: RedactedValue;
}

// A resource whose real-world state has drifted from Terraform state
// (`resource_drift` in `show -json`). Identity fields mirror PlanResource; the
// drifted attributes are surfaced as masked AttrChange[] (before = state,
// after = observed reality). Shape fixed by WP-0: the design (§4.2) references
// DriftResource but leaves it to the frozen contract to spell out.
export interface DriftResource {
  address: string;
  type: string; name: string; providerName: string;
  attributeChanges: AttrChange[];  // masked; capped per resource
}

// A value that has been through redaction. Exactly one variant is set. The
// underlying raw value is NEVER present for the sensitive/unknown/omitted
// variants; for "value" the json is the JSON-encoding of the already-redacted
// (sensitive leaves already replaced) subtree, bounded by the size cap (spec §6).
export type RedactedValue =
  | { kind: "value"; json: string }        // JSON-encoded non-sensitive primitive/collection (bounded)
  | { kind: "sensitive" }                  // masked; renders as "(sensitive)"
  | { kind: "unknown" }                    // known-after-apply; renders as "(known after apply)"
  | { kind: "omitted"; reason: "too-large" };

/** Apply digest — built from the `terraform apply -json` NDJSON event stream. */
export interface ApplyDigest extends DigestEnvelope {
  kind: "apply";
  outcome: "succeeded" | "failed";
  summary: { add: number; change: number; destroy: number; durationMs?: number };
  resources: ApplyResource[];      // capped
  diagnostics: Diagnostic[];       // masked; see spec §5.4 for the freeform-text caveat
  outputs: OutputChange[];         // masked, final outputs
  appliedBeforeFailure?: string[]; // addresses completed before an errored apply (partial-apply picture)
}

export interface ApplyResource {
  address: string; action: "create" | "update" | "delete" | "replace" | "read";
  status: "started" | "complete" | "errored";
  durationMs?: number;
}

export interface Diagnostic {
  severity: "error" | "warning";
  summary: string;                 // redacted freeform (see spec §5.4)
  detail?: string;                 // redacted freeform
  address?: string;                // resource address if attributable
}

export interface OutputChange {
  name: string;
  action: "create" | "update" | "delete" | "no-op";
  value: RedactedValue;
}

// Discriminated union over `kind` for consumers (the tab's digest-model) that
// parse an attachment of unknown type. Narrow on `.kind` before use.
export type Digest = PlanDigest | ApplyDigest;
