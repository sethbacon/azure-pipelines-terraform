# Structured Plan & Apply Tabs — Design & Implementation Plan

**Repo:** `sethbacon/azure-pipelines-terraform` · **Task:** `TerraformTask/TerraformTaskV5` (`PipelineTerraformTask@5`) + build-results tab under `src/tab/`
**Status:** design proposal (not yet approved for build) · **Audience:** implementer agents (Sonnet 5 + Opus 4.8) and human reviewers

---

## 1. Goal & scope

Replace the current "colorized text dump" plan tab with a **structured, safe, multi-plan Terraform results viewer**, and add **apply** results alongside it under one tab with **Plan / Apply pivots**.

**In scope**
- Task-side: produce a compact, **redacted** JSON *digest* of `plan` and `apply` and publish it as a build attachment.
- Tab-side: render digests as a summary header, a filterable grouped resource list, per-resource attribute diffs, an apply timeline, an outputs panel, and a multi-plan overview list. Keep a raw-text fallback view.
- One combined "Terraform" tab (Plan/Apply pivots) replacing the single "Terraform Plan" tab; keep the existing `terraform-plan-results` raw attachment for backward compatibility.

**In scope, late phase (§11 Phase 5)**
- Structured rendering of `destroy`, `state`, and (where meaningful) `import`. `destroy` largely reuses the plan digest (a destroy plan is a plan whose `resource_changes` are all deletes); `state` needs a small **state-inventory** digest variant (`terraform show -json` of current state → `values.root_module` resources, no change actions); `import` value is marginal (standalone `terraform import` emits little JSON; Terraform 1.5+ `import` blocks already surface in the plan digest). Until Phase 5 lands, these commands fall back to the raw ANSI view.

**Out of scope (initial)**
- Cross-run plan↔apply correlation (only same-run pairing is supported initially — see §11).
- Any new pipeline permission/scope.

**Non-negotiables**
1. **No unredacted sensitive value ever leaves the task** (attachments are readable by anyone with build-read).
2. **No new XSS surface**; the structured renderer must not use `dangerouslySetInnerHTML`.
3. **Backward compatible**: existing `publishPlanResults` behavior and the `terraform-plan-results` attachment type keep working unchanged; new behavior is opt-in / additive.
4. **Non-breaking defaults**: current pipelines behave identically unless a new input is set.

---

## 2. Current state (grounded in code)

- `Tasks/TerraformTask/TerraformTaskV5/src/base-terraform-command-handler.ts`
  - `plan()` (~L435): builds the plan command; **when `publishPlanResults` is set**, captures stdout via `execWithStdoutCapture`, writes it to `Agent.TempDirectory/terraform-plan-<uuid>.txt`, and calls `tasks.addAttachment("terraform-plan-results", <name>, path)` (~L472). The agent uploads the file asynchronously after reading the `##vso[task.addattachment]` line.
  - `apply()` (~L514): plain `execAsync` — **no capture, no attachment** today.
  - `show()` (~L359) / `output()` (~L399): already write `-json` files and call `warnIfSensitiveOutputs()` / `warnIfSensitiveOutputFile()`.
  - **Sensitive detection already exists**: `warnIfSensitiveOutputs(jsonOutput, filePath)` (~L815) parses `show -json`, inspects `planned_values.outputs[].sensitive` and `resource_changes[].change.after_sensitive`, and (with opt-in `failOnSensitiveOutputs`, #488) can fail. **This is the seed of the redaction module** — but it only *detects*; it does not *redact*.
- `src/tab/tabContent.tsx`: React class component. `ATTACHMENT_TYPE = "terraform-plan-results"`. `loadPlans()` calls `BuildRestClient.getAttachments(project, buildId, type)`, fetches each via `attachment._links.self.href` with `Basic ":"+accessToken`, stores `{name, content}`, sorts by name, dropdown when `>1`. Renders `MAX_RENDER_SIZE = 2MB`; larger → download link; else `<pre dangerouslySetInnerHTML={{__html: ansiToHtml(content)}} />` (**the one XSS-adjacent sink** the 2026-07 audit flagged).
- `src/tab/ansi-to-html.ts`: SGR→span converter, `escapeHtml()` present.
- Manifest `azure-devops-extension.json`: contribution `terraform-plan-tab` → `ms.vss-build-web.build-results-tab`, `tab/index.html`, `supportsTasks: ["981E87CD-B686-4A9E-B09E-B4AFDEDF126B"]`, `dynamic: true`.
- Build/CI: per-task mocha `L0.ts`; tab uses **jest** (`npm run test:tab`), coverage thresholds statements 80 / branches 78 / functions 60 / lines 80. CI matrix ubuntu-latest + windows-2025; `Build and Test Tab (os)` + a `build-and-test-tab-gate` job named `Build and Test Tab` (required context). Shared-module byte-identity gate: `scripts/check-shared-modules.js`. Minor-bump gate: `scripts/check-minor-bumps.js` vs the latest release tag. Version consistency: `scripts/check-versions.js`.
- Root `package.json` `dependencies` is `{}`; tab libs (`azure-devops-extension-sdk`, `azure-devops-ui`, `azure-devops-extension-api`) are dev deps bundled by webpack.

---

## 3. Target architecture

```
 terraform plan/apply (in customer pipeline)
        │
        ▼
 ┌──────────────────────────────────────────────────────────┐
 │ TerraformTaskV5 (task-side, Node)                         │
 │  1. run command, capture output                           │
 │  2. obtain machine-readable form:                         │
 │       plan  → `terraform show -json <planfile>`           │
 │       apply → `terraform apply -json` event stream        │
 │  3. REDACT (shared plan-digest/redact module) ───────────┐│
 │  4. build compact DIGEST (versioned schema)              ││
 │  5. attach:                                              ││
 │       terraform-plan-summary   / terraform-apply-summary ││
 │       (+ existing raw terraform-plan-results unchanged)  ││
 └──────────────────────────────────────────────────────────┘
        │  build attachments (build-read scoped)
        ▼
 ┌──────────────────────────────────────────────────────────┐
 │ Build-results tab (React, src/tab/)                       │
 │  Terraform tab → [ Plan | Apply ] pivots                  │
 │   • multi-item overview list (name + counts + badges)     │
 │   • summary header (add/change/destroy, drift, versions)  │
 │   • grouped resource list (create/update/replace/…)       │
 │   • per-resource attribute diff (before→after, masked)    │
 │   • apply timeline (per-resource status + duration)       │
 │   • outputs panel (masked) · diagnostics panel            │
 │   • raw-text fallback (ansi-to-html) for legacy/other     │
 └──────────────────────────────────────────────────────────┘
```

**Key architectural decisions**
- **Redaction happens task-side, before attach.** The tab renders only already-safe data. The tab treats the digest as untrusted input regardless (defense in depth).
- **New attachment types, not a changed one.** `terraform-plan-summary` / `terraform-apply-summary` are additive; `terraform-plan-results` stays byte-for-byte what it is today (preserves the jason-johnson migration convention and any external consumer).
- **Digest is versioned** (`schemaVersion`). The tab must handle unknown/newer versions gracefully (render what it understands, show a "produced by a newer task version" note, offer raw).
- **The redaction + digest-builder is a shared, CI-parity-gated module** (used by both plan and apply). It is the single most security-critical new code.

---

## 4. Digest schema (v1)

Two document types share a common envelope. All strings in the digest are **post-redaction** and are rendered by React as **text nodes only**.

### 4.1 Envelope (both)
```ts
interface DigestEnvelope {
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
  truncated: boolean;           // true if any cap in §6 was hit
  truncationNotes?: string[];   // human-readable ("resource list capped at 2000", etc.)
}
```

### 4.2 Plan digest
```ts
interface PlanDigest extends DigestEnvelope {
  kind: "plan";
  summary: {
    add: number; change: number; destroy: number; replace: number; read: number;
    noChanges: boolean;
    driftDetected: boolean;
  };
  resources: PlanResource[];       // capped; see §6
  outputChanges: OutputChange[];   // masked
  drift?: DriftResource[];         // from resource_drift, masked
}

interface PlanResource {
  address: string;                 // e.g. module.db.aws_db_instance.this[0]
  type: string; name: string; providerName: string;
  actions: ("no-op"|"create"|"read"|"update"|"delete"|"replace"|"forget")[];
  actionReason?: string;           // e.g. "replace_because_cannot_update"
  replacePaths?: string[];         // attribute paths forcing replacement (from replace_paths)
  attributeChanges: AttrChange[];  // ONLY changed attrs; capped per resource
}

interface AttrChange {
  path: string;                    // dotted/indexed attribute path
  before: RedactedValue;
  after: RedactedValue;
}

// A value that has been through redaction. Exactly one of these is set.
type RedactedValue =
  | { kind: "value"; json: string }        // JSON-encoded non-sensitive primitive/collection (bounded)
  | { kind: "sensitive" }                  // masked; renders as "(sensitive)"
  | { kind: "unknown" }                    // known-after-apply; renders as "(known after apply)"
  | { kind: "omitted"; reason: "too-large" };
```

### 4.3 Apply digest
```ts
interface ApplyDigest extends DigestEnvelope {
  kind: "apply";
  outcome: "succeeded" | "failed";
  summary: { add: number; change: number; destroy: number; durationMs?: number };
  resources: ApplyResource[];      // capped
  diagnostics: Diagnostic[];       // masked; see §5.4 for the freeform-text caveat
  outputs: OutputChange[];         // masked, final outputs
  appliedBeforeFailure?: string[]; // addresses completed before an errored apply (partial-apply picture)
}

interface ApplyResource {
  address: string; action: "create"|"update"|"delete"|"replace"|"read";
  status: "started"|"complete"|"errored";
  durationMs?: number;
}

interface Diagnostic {
  severity: "error"|"warning";
  summary: string;                 // redacted freeform (see §5.4)
  detail?: string;                 // redacted freeform
  address?: string;                // resource address if attributable
}

interface OutputChange { name: string; action: "create"|"update"|"delete"|"no-op"; value: RedactedValue; }
```

**Source mapping**
- Plan digest ← `terraform show -json <planfile>` → `resource_changes[]` (`.change.actions`, `.change.before`, `.after`, `.after_unknown`, `.before_sensitive`, `.after_sensitive`, `.action_reason`, `.change.replace_paths`), `output_changes`, `resource_drift`, `terraform_version`.
- Apply digest ← `terraform apply -json` NDJSON event stream: `apply_start`/`apply_progress`/`apply_complete`/`apply_errored`, `diagnostic`, `change_summary`, `outputs`.

---

## 5. SECURITY MODEL (primary section)

The tab and its attachments are the highest-risk surface this feature touches. Two of the 2026-07 audit's own findings (#488/#492 sensitive-output handling; the tab as the sole `dangerouslySetInnerHTML` sink) live exactly here. Treat every item below as a hard requirement with a test.

### 5.1 Threat model
- **Assets:** Terraform sensitive values (passwords, keys, tokens, connection strings) present in plan/apply output; the pipeline job's OAuth token used by the tab to fetch attachments.
- **Trust boundary:** the task runs inside the customer's own pipeline (trusted to *produce* the digest); the tab runs in the ADO web UI iframe and must treat the fetched digest as **untrusted input**. Attachment *readers* are anyone with build-read on the pipeline — a **wider** audience than whoever can see the live job log (which the agent secret-masks).
- **Primary adversaries:**
  1. A curious/malicious user with build-read who should not see secret values → **attachment content-exposure**.
  2. An attacker who can influence Terraform config/content (PR to IaC, a malicious module, a provider that returns attacker-chosen strings) → **stored XSS in the ADO UI** and **DoS via huge/deep JSON**.
- **Explicitly out of scope:** ADO's own RBAC/attachment-scoping (relied upon), and the agent's log secret-masking (which does *not* cover attachment files — hence task-side redaction).

### 5.2 Redaction (the core control)
The redaction module converts raw `show -json` / `apply -json` structures into `RedactedValue`s. Requirements:

1. **Sensitivity sources — union of ALL of these marks a value sensitive:**
   - `after_sensitive` / `before_sensitive` mark maps in `resource_changes[].change` (may be `true`, or a nested object/array mirroring the value's shape with `true` at sensitive leaves).
   - `sensitive_values` in `planned_values` / `prior_state` resources.
   - `outputs[].sensitive` (plan `output_changes` and state outputs).
   - Provider-marked sensitivity conveyed via the same mask maps (no separate handling needed, but do not assume only config-level `sensitive`).
2. **Recursive masking.** The mask map is shape-parallel to the value. Walk both together: at any leaf where the mask is `true`, emit `{kind:"sensitive"}` and **do not** include the underlying value anywhere in the digest. For a partially-sensitive collection, mask only the sensitive leaves but treat the *whole* collection as containing sensitive data for size/summary purposes.
3. **Unknown values.** `after_unknown` (shape-parallel, `true` at known-after-apply leaves) → `{kind:"unknown"}`. Never emit the pre-refresh `before` value as the "after."
4. **Fail-closed on ambiguity.** If the mask map and value shapes disagree (can happen across TF versions), **treat the value as sensitive** (mask it) rather than risk leaking. Emit a `truncationNotes`/diagnostic entry so it's observable. A unit test must cover shape-mismatch → masked.
5. **Never round-trip raw values through the digest.** The `RedactedValue.json` for a non-sensitive value is the JSON-encoding of the *redacted* subtree (sensitive leaves already replaced), bounded by size caps (§6). Do not serialize the original object then try to scrub — build the redacted tree first, then serialize.
6. **Redaction is shared code.** One module, used by plan and apply, added to `scripts/check-shared-modules.js` parity families if it is duplicated into the task bundle (it lives in the task, so likely single-copy — but if any copy is bundled separately, gate it).
7. **Reuse, don't fork, existing detection.** The new module should *supersede* `warnIfSensitiveOutputs`'s detection logic path or share a common core, so detection and redaction can't drift apart (a drift here is exactly the #446-class bug the repo already fought).

### 5.3 XSS prevention (tab)
1. **Structured renderer uses zero `dangerouslySetInnerHTML`.** Every digest string — resource address, attribute path, JSON value, output name, diagnostic text, attachment name — renders as a React **text node** (`{value}`), which HTML-escapes by construction.
2. **No untrusted value in an attribute sink.** Never place a digest string into `href`, `src`, `style`, `dangerouslySetInnerHTML`, `data-*` used by scripts, or `ref` callbacks that touch the DOM. The only download link uses a `Blob`/`data:` URL built from content the tab itself holds, with a **static** `download` filename derived from a sanitized name (allowlist `[A-Za-z0-9._-]`, cap length).
3. **Raw fallback keeps the sanitizer.** The legacy raw-text view still uses `ansi-to-html`; that path's escaping is already covered by the audit fixes. The structured path must not depend on it.
4. **JSON parse safety.** Parse the digest with `JSON.parse` (never `eval`/`Function`). After parsing, **validate the schema field-by-field** into typed objects; never spread untrusted parsed objects into component state or via `{...parsed}` into props. Guard against **prototype pollution**: reject or ignore `__proto__` / `constructor` / `prototype` keys when walking objects; do not use unsafe deep-merge.
5. **Bounded rendering.** Cap the number of DOM nodes (see §6) — a digest that claims 1e6 resources must not be rendered element-per-row; virtualize or hard-cap with a "list truncated" banner.

### 5.4 Diagnostics & freeform text (hard case)
Apply/plan **diagnostics are freeform strings** that Terraform/providers may build from user input — e.g. `Error: invalid value "hunter2" for password`. There is **no structured mask** for these.
- **Do not assume diagnostics are safe.** Apply the same **explicit secret-masking** the task already knows: collect the values the task registered via `setSecret` (WIF tokens, provider creds, `TF_OUT_*` secret values, var-file secrets where known) and string-replace them out of diagnostic `summary`/`detail` before adding them to the digest.
- Additionally run a conservative **high-entropy/format heuristic scrub** (e.g. long base64/hex runs, `-----BEGIN … KEY-----` blocks) — documented as best-effort, not a guarantee.
- **Residual risk (must be documented in SECURITY.md):** a provider can echo a secret that the task never registered and that doesn't match a heuristic; such a value could appear in a diagnostic. Mitigations: (a) a task input `publishApplyResults`/`includeDiagnostics` defaulting to a **safe** mode that includes only diagnostic `summary` + `address`, not full `detail`, unless explicitly opted in; (b) the same `failOnSensitiveOutputs`-style guardrail so operators can choose fail-over-publish.

### 5.5 Size / DoS
- **Task-side caps** (see §6 for numbers): max resources in digest, max attribute changes per resource, max bytes per `RedactedValue.json`, max total digest bytes, max diagnostics. On any cap, set `truncated=true` + a note; never silently drop without signaling.
- **Attachment size ceiling:** if the digest would still exceed a hard ceiling after caps, attach a **summary-only** digest (counts + truncation note) and skip the heavy arrays. Never attach an unbounded file (protects the agent upload and the browser).
- **Tab-side:** enforce the same caps defensively (don't trust `truncated`); cap DOM nodes; stream/lazy-render large lists.
- **Parse guard:** reject digests over a tab-side byte ceiling before `JSON.parse` (fetch `Content-Length`, or cap the read) to avoid a browser OOM from a malicious attachment.

### 5.6 Attachment-name & logging-command injection
- `publishPlanResults` / `publishApplyResults` values become attachment names **and** are interpolated into `##vso[task.addattachment …]` logging commands. Validate task-side: reject/scrub CR/LF and `]`/`;`/`%` control sequences that could break the logging command; cap length. (This is the same class as the ADO logging-command injection guards elsewhere in the repo.)
- In the tab, the name is untrusted text → React text node only; the `download` filename is sanitized to `[A-Za-z0-9._-]`.

### 5.7 Token & network hygiene (tab)
- The tab already fetches attachments with `SDK.getAccessToken()` via `Authorization: Basic`. Keep the token **out of URLs and logs**; never log the auth header. Only fetch from the ADO-provided `attachment._links.self.href` (same-origin ADO); make **no third-party requests** (the extension iframe CSP should forbid it — verify no CDN/font/telemetry fetch is introduced).
- Request only the **build-read** scope already in use; introduce **no new scopes**.

### 5.8 Integrity / provenance
- The digest is produced by the task inside the customer pipeline; the tab trusts ADO's attachment association (same build, correct type). No signing is required within that boundary. **Do not** add a feature that fetches a *different* build's/project's attachments based on an untrusted URL/query param (would broaden the trust boundary); same-run correlation only (§11).

### 5.9 Supply chain
- Any new tab dependency (e.g. a virtualized-list helper) must be **SHA/lockfile-pinned**, pass the repo's `Dependency Review` required check (moderate severity gate), and be justified in `THIRD_PARTY_NOTICES.md`. Prefer using `azure-devops-ui` primitives already bundled over adding a new dep.
- The redaction/digest module, being security-critical and potentially bundled into the task, is added to the `check-shared-modules.js` parity gate if any duplicate copy exists.

### 5.10 Residual-risk register (to land in SECURITY.md)
1. Provider-echoed secrets in diagnostics not covered by mask/heuristic (§5.4) — mitigated by safe-default diagnostic mode + opt-in + documentation.
2. Redaction depends on Terraform correctly emitting `*_sensitive` marks; a provider that fails to mark a value sensitive leaks it (same limitation the existing `warnIfSensitiveOutputs` and `TF_OUT_*` masking already carry — cross-reference #491).
3. Attachments remain readable by anyone with build-read; redaction is the only control, so a redaction bug is a disclosure. Hence the exhaustive redaction test matrix (§8) and Opus adversarial review (§10, WP-6).

---

## 6. Concrete limits (single source of truth)
| Cap | Value | Behavior on exceed |
|---|---|---|
| resources in digest | 2000 | keep first 2000 by action priority (destroy/replace first), set `truncated`, note count |
| attribute changes / resource | 200 | keep changed attrs alphabetically, note remainder |
| bytes / `RedactedValue.json` | 4 KB | emit `{kind:"omitted",reason:"too-large"}` |
| diagnostics | 500 | keep all errors first, then warnings, note remainder |
| output changes (plan `outputChanges` / apply `outputs`) | 1000 | keep first 1000 by name, set `truncated`, note remainder |
| drift resources | 2000 | keep first 2000 in address order, set `truncated`, note remainder |
| applied-before-failure addresses | 2000 (reuses resources) | keep first 2000, set `truncated`, note remainder |
| truncationNotes | 1000 | keep first 1000, collapse remainder into one count note |
| total digest bytes (soft) | 5 MB | drop the heavy per-resource arrays (plan `attributeChanges` / state `attributes` **and** `outputs`; apply drops diagnostic `detail`), keep resource rows + summary, set `truncated` |
| total digest bytes (hard) | 12 MB | attach summary-only digest |
| tab parse ceiling | 16 MB | refuse structured render, offer raw/download |
| tab rendered rows (before virtualize/cap) | 2000 | banner "list truncated" |

These constants live in **one shared module** consumed by task and tab so they cannot drift.

---

## 7. Task-side changes (files & behavior)

> All under `Tasks/TerraformTask/TerraformTaskV5/`. Bump `task.json` **Minor once** vs the latest release tag. New inputs are `required:false` with defaults preserving today's behavior.

**New modules**
- `src/results/redact.ts` — the recursive redaction core (§5.2). Pure, heavily unit-tested. Exposes `redactValue(value, sensitiveMask, unknownMask, caps)` → `RedactedValue` and helpers.
- `src/results/plan-digest.ts` — build `PlanDigest` from `show -json` JSON (calls `redact`).
- `src/results/apply-digest.ts` — build `ApplyDigest` from the `apply -json` NDJSON event stream (calls `redact`).
- `src/results/caps.ts` — the §6 constants (shared with the tab via a copy gated by `check-shared-modules.js`, or a generated file; see §9).
- `src/results/secret-scrub.ts` — freeform-text scrub for diagnostics (§5.4): explicit known-secret replacement + entropy/format heuristic.
- `src/results/digest-schema.ts` — the TypeScript interfaces (§4); the **same** types are mirrored (byte-identical, parity-gated) into `src/tab/`.

**`base-terraform-command-handler.ts`**
- `plan()`: when a new input `publishPlanSummary` (or reuse `publishPlanResults` + a boolean `structuredResults`, see Decision D1) is enabled, after the plan runs with `-out=<planfile>` (ensure a plan file exists — today's flow may not always `-out`; add `-out` to a temp planfile under `Agent.TempDirectory` when structured results are requested), run `terraform show -json <planfile>`, build+redact the `PlanDigest`, write it to `Agent.TempDirectory`, and `addAttachment("terraform-plan-summary", name, path)`. Keep emitting the existing `terraform-plan-results` raw attachment unchanged.
- `apply()`: when `publishApplyResults` is set, run apply with `-json` (capture NDJSON), **echo human-readable `@message` lines to the console** so the live log is preserved (see §5.4/D2), build+redact the `ApplyDigest`, attach as `terraform-apply-summary`. Preserve exit-code semantics exactly (apply must still fail the task on error).
- Reuse/reroute `warnIfSensitiveOutputs` to share the redaction core (§5.2.7).

**`task.json`**
- New inputs (all `required:false`, safe defaults): `publishApplyResults` (string, name; visibleRule `command = apply`), plus the plan-summary toggle per D1, and an `includeDiagnosticDetail` (boolean, default false) per §5.4.
- New `messages` entries + `Strings/resources.resjson/en-US/resources.resjson` for all new user-facing strings (loc convention).
- Minor bump.

---

## 8. Tab-side changes (files & behavior)

> All under `src/tab/`. Jest tests; keep coverage ≥ thresholds.

- `tabContent.tsx`: convert to Plan/Apply **pivots** (azure-devops-ui `Tabs`/`TabBar` or `Pivot`). Load **both** attachment types (`terraform-plan-summary`, `terraform-apply-summary`) plus the legacy `terraform-plan-results` for raw fallback. Multi-item **overview list** (name + count chips + drift/replace/no-op badges); selecting opens detail. Roll-up header across items (§ multiple-plans).
- `digest-model.ts`: **schema validation & safe parsing** (§5.3.4) — parse, validate `schemaVersion`/`kind`, coerce into typed objects, reject prototype-pollution keys, enforce §6 tab caps, handle unknown newer versions gracefully.
- `digest-schema.ts`: mirror of the task's types (parity-gated).
- `caps.ts`: mirror of §6 constants (parity-gated).
- Presentational components (pure, easily unit-tested): `SummaryHeader`, `ResourceList` (grouped + filter/search), `ResourceDiff` (before→after table, renders `RedactedValue` as `(sensitive)`/`(known after apply)`/value), `ApplyTimeline`, `OutputsPanel`, `DiagnosticsPanel`, `RawView` (existing ansi path), `OverviewList`.
- **No `dangerouslySetInnerHTML`** anywhere in the structured components (lint rule / test asserts this — see §8.1).

### 8.1 Anti-regression guard
Add a jest test (or eslint rule) asserting `dangerouslySetInnerHTML` appears **only** in `RawView`/`ansi-to-html` and nowhere in the structured renderer. This is a security regression tripwire analogous to the repo's other parity gates.

### 8.2 Manifest
- Replace the `terraform-plan-tab` contribution's display name with "Terraform" (keep the same contribution id to preserve existing deep links, or add a new id and deprecate — Decision D3). Pivots are internal to the tab; no manifest change needed for them. `supportsTasks` unchanged.

---

## 9. CI, versioning, parity, manifest
- **Version:** bump `TerraformTaskV5` `task.json` Minor once vs the latest release tag; run `check-minor-bumps.js`, `check-versions.js`.
- **Parity gate:** the shared `digest-schema.ts` and `caps.ts` (and `redact.ts`/`secret-scrub.ts` if any copy is bundled separately) go into `scripts/check-shared-modules.js` families so the task copy and tab copy cannot drift. If the tab and task import from a single shared path instead of duplicating, no gate is needed — **prefer a single shared source** and only fall back to parity-gated copies if the build boundaries (separate tsconfig/webpack roots) force duplication (they likely do — task compiles with `tsc -b`, tab bundles with webpack from `src/tab`, so a copied+gated file is the realistic path).
- **Tests:** task L0 (mocha) for digest builders + redaction; tab jest for components + `digest-model` parsing/validation; both OS legs.
- **Required checks:** `Analyze TypeScript` (CodeQL), `Dependency Review`, `Build and Test Tab (…)` already required; new tab deps must pass Dependency Review.
- **Docs:** README (new inputs + tab description), CLAUDE.md (task structure), SECURITY.md (residual-risk register §5.10), `docs/` walkthrough + screenshots.

---

## 10. Work breakdown (each unit is an orchestrator task; model pre-assigned)

Legend: **[O]** = Opus 4.8 (security-critical / design judgment), **[S]** = Sonnet 5 (well-specified mechanical), **[O-review]** = Opus adversarial security review.

- **WP-0 [O] — Design lock.** Produce the frozen `digest-schema.ts` types, `caps.ts` constants, and the redaction algorithm spec (pseudocode + the sensitivity-source union + fail-closed rule) as committed spec files on a base branch. *Output consumed by every downstream unit so plan/task/tab agree.* Gate: types compile; no behavior yet.
- **WP-1 [O] — Redaction + digest core (task-side, security-critical).** `redact.ts`, `plan-digest.ts`, `apply-digest.ts`, `secret-scrub.ts` + the **full unit matrix (§12.2)**, the **golden-fixture corpus + `.expected.json` goldens (§12.3)**, and the **no-leak tripwire (§12.4.1)**. Owns creating the scrubbed fixture set. Depends on WP-0. **Highest test bar** — a gap here is a disclosure.
- **WP-2 [S] — Task wiring.** `plan()`/`apply()` integration, `-out` planfile + `show -json`, `apply -json` + console echo, new `task.json` inputs + loc strings, Minor bump, L0 integration tests, and the **backward-compat regression test (§12.3)** (raw attachment byte-identical, no `-summary` when opted out). Depends on WP-1.
- **WP-3 [S] — Tab UI.** Pivots, overview list, summary header, resource list/diff, apply timeline, outputs/diagnostics panels, raw fallback; `digest-model.ts` safe parsing/validation; jest unit + **snapshot/regression tests from the WP-1 goldens (§12.3)**; the **no-`dangerouslySetInnerHTML` (§12.4.2)**, **no-new-network (§12.4.4)**, and **schema-version regression (§12.3)** tripwires. Depends on WP-0 (schema), runs **in parallel** with WP-1/WP-2.
- **WP-4 [S] — Manifest + docs + parity.** Combined tab name; **all §13 documentation artifacts, each fact verified against code with file:line cited in the PR body**; the **parity tripwire self-test (§12.4.3)** and **scope tripwire (§12.4.5)**; `check-shared-modules.js` families for the mirrored files; THIRD_PARTY_NOTICES if a dep added; `docs/release-checklist.md` manual no-leak step. Depends on WP-2 + WP-3 (for accurate input/behavior docs).
- **WP-5 [S] — Integration & CI green.** Assemble branches, run all gates on both OS legs, fix CI, open PR(s). Depends on WP-2/WP-3/WP-4.
- **WP-6 [O-review] — Adversarial security review** of the full diff: redaction completeness (try to construct a plan/apply JSON that leaks), XSS (any value reaching an attribute/HTML sink), prototype pollution, size/DoS, attachment-name injection, token hygiene, schema-version handling. Produces a must-fix list.
- **WP-7 [O] — Security fix.** Apply WP-6 must-fixes (Opus, since these are the security-critical corrections), re-run gates.
- **WP-6b [S-review] — Completeness/mechanical review** (parallel with WP-6): every WP claimed-complete item is actually implemented; loc/version/parity gates pass; docs match behavior.

**Dependency graph**
```
WP-0 ──┬─► WP-1 ─► WP-2 ─┐
       └─► WP-3 ─────────┼─► WP-4 ─► WP-5 ─► (WP-6 ‖ WP-6b) ─► WP-7
                         │
   (WP-2 and WP-3 converge at WP-4/WP-5)
```

**Model-fit rationale**
- Opus for WP-0/1/6/7 because a subtle error = secret disclosure or an XSS sink; these need the strongest reasoning and adversarial framing.
- Sonnet for WP-2/3/4/5 and WP-6b because they are well-specified, mechanical, and cheaper — the schema/redaction contract from WP-0/WP-1 removes the hard judgment from them.

---

## 11. Backward compatibility, phasing, open decisions

**Compat / migration**
- `terraform-plan-results` raw attachment and `publishPlanResults` semantics unchanged. Structured behavior is opt-in/additive. Old task versions mid-migration: the tab shows "raw only" items and falls back to ansi view. Newer digest `schemaVersion` than the tab knows: render-what-you-can + note + raw.

**Phasing** (each phase shippable):
1. Plan digest + tab summary header + grouped list + raw fallback + overview list (WP-0/1/2(plan only)/3(plan)/4/5/6/7).
2. Attribute-level diffs, filter/search.
3. Apply digest + Apply pivot + timeline + diagnostics (adds apply half of WP-1/2/3).
4. Extras: same-run plan↔apply reconcile badge; link drift → TSM; surface TerraformPolicyCheck results.
5. **Structured `destroy`/`state`/`import` (in scope, late).** `destroy` → reuse `PlanDigest` from a destroy plan file (`terraform plan -destroy -out` → `show -json`); `state` → a new lightweight `StateDigest` (resource inventory from `show -json` of state: `values.root_module.resources[]` with `sensitive_values` redacted, no action column) rendered as an inventory pivot; `import` → only if a machine-readable form proves worth it, else it stays on raw. Same redaction, caps, XSS, and testing rules apply; the state inventory adds its own golden fixtures and no-leak tripwire coverage.

**Open decisions — resolved (Q&A).** These were the D1–D4 questions; each is now decided so WP-0 implements rather than re-deliberates. WP-0 records these in `docs/design/plan-apply-digest-spec.md` and any future change to them is a design change, not an implementation choice.

**Q (D1): Should structured output be a new input, or a boolean modifier on the existing `publishPlanResults`?**
**A: New, separately-named inputs — `publishPlanSummary` (plan) and `publishApplyResults` (apply).** Rationale: (a) independent `visibleRule`s (`command = plan` vs `command = apply`) that a single modifier can't express; (b) `publishPlanResults` keeps its exact current meaning (raw attachment), so no existing pipeline changes behavior — the strongest backward-compat guarantee; (c) an operator can publish raw-only, summary-only, or both. Trade-off accepted: one more input on the task. The plan-summary and raw attachments are independent and may both be emitted.

**Q (D2): `apply -json` replaces the human console log. How do we preserve a readable live log without leaking?**
**A: Echo each event's `@message` field verbatim to the console; never echo raw structured fields.** Rationale: `@message` is Terraform's own human-readable, already-redacted line — reusing it preserves the exact live-log experience operators expect while the structured (secret-bearing) fields are only ever consumed by the redaction pipeline, never printed. Reconstructing our own message text was rejected as redundant and a second place a secret could slip through. The digest is built from the structured fields *after* redaction.

**Q (D3): One combined tab or keep a separate plan tab? And reuse the contribution id?**
**A: One combined "Terraform" tab with Plan/Apply (and later State) pivots, reusing the existing `terraform-plan-tab` contribution id** — change only the display name. Rationale: reusing the id preserves any existing deep links and avoids a second manifest contribution / tab clutter; pivots are internal to the tab (no manifest change); a single tab is where the plan↔apply reconcile UI (Phase 4) naturally lives. `supportsTasks` is unchanged. A separate Apply tab was rejected as more manifest surface for no user benefit.

**Q (D4): Single shared source for `digest-schema.ts` / `caps.ts`, or duplicated copies?**
**A: Duplicated copies (task `src/results/` + `src/tab/`), byte-identity-gated by `scripts/check-shared-modules.js` with a self-test.** Rationale: the task compiles via `tsc -b` and the tab bundles via a separate webpack root from `src/tab`, so a single imported source can't span both build boundaries without restructuring the build — out of proportion to the benefit. The parity gate (plus its self-test, §12.4.3) makes drift a CI failure, giving the same guarantee a single source would, at lower blast radius. This is the same pattern the repo already uses for `gpg-verifier.ts`/`https-client.ts`/`uri-scheme-guard.ts`.

---

## 12. Testing strategy (unit + regression)

Testing is a first-class deliverable of every WP, not a follow-up. Because a redaction bug is a secret disclosure and a render bug is an XSS/DoS vector, the test suite is itself a security control. No WP is "done" until its tests exist, pass on **both** CI OS legs (ubuntu-latest + windows-2025), and hold coverage at or above thresholds. TDD is mandatory (§CONVENTIONS): the failing test is written and observed red before the implementation.

### 12.1 Test layers
| Layer | Where | Runner | Scope |
|---|---|---|---|
| Unit (pure logic) | `Tasks/…/TerraformTaskV5/Tests/*.ts` | mocha (L0 idiom) | `redact.ts`, `plan-digest.ts`, `apply-digest.ts`, `secret-scrub.ts`, caps behavior — pure functions, no I/O |
| Unit (tab logic) | `src/tab/**/*.test.ts(x)` | jest | `digest-model.ts` parse/validate, each pure presentational component |
| Integration (task) | `Tasks/…/TerraformTaskV5/Tests/*.ts` | mocha + `MockTestRunner` | `plan()`/`apply()` end-to-end: command built, `show -json`/`apply -json` consumed, attachment emitted, exit code preserved |
| Integration (tab) | `src/tab/*.test.tsx` | jest + RTL | `tabContent` load→parse→render across attachment types, pivots, overview list |
| Regression (golden) | fixtures + snapshot/assertion | both | frozen real-world captures never regress (§12.3) |
| Anti-regression tripwires | both | mocha/jest/eslint | security invariants that must never silently break (§12.4) |

### 12.2 Unit testing — required cases

**Redaction core (`redact.ts`) — the exhaustive matrix (WP-1, security-critical):**
- Non-sensitive primitive / collection → `{kind:"value"}` with correct bounded JSON.
- `after_sensitive: true` at a leaf → `{kind:"sensitive"}`, underlying value absent from the entire digest (assert by serializing the whole digest and grepping for the secret literal — it must not appear).
- Nested/partial-sensitive collection: only sensitive leaves masked; sibling non-sensitive leaves preserved; the collection still counted as sensitive for summary/size.
- `before_sensitive` and `sensitive_values` sources (not just `after_sensitive`).
- Output sensitivity (`outputs[].sensitive` / `output_changes`).
- `after_unknown: true` → `{kind:"unknown"}`; assert the pre-refresh `before` is never emitted as the "after".
- **Mask/value SHAPE MISMATCH → masked (fail-closed)** — mask says object, value is scalar (and vice-versa); mask deeper/shallower than value. Must emit `{kind:"sensitive"}` + a truncation/diagnostic note. This is the single most important test.
- Size caps (§6): value just over 4 KB → `{kind:"omitted","too-large"}`; >200 attr changes → capped + note; >2000 resources → capped by action priority + note; soft/hard total-byte ceilings → drop-arrays / summary-only.
- Prototype-pollution key (`__proto__`, `constructor`, `prototype`) in the input object is ignored/rejected, not walked into `Object.prototype`.
- Determinism: same input → byte-identical digest (stable key ordering) so snapshot regression is meaningful.

**Digest builders (`plan-digest.ts`, `apply-digest.ts`) — WP-1:**
- Plan: action classification (create/update/delete/replace/read/no-op), `action_reason`, `replace_paths` surfaced, `driftDetected` from `resource_drift`, `noChanges` true when empty, summary counts correct.
- Apply: NDJSON stream parsed; malformed/partial line tolerated (skipped + noted, never throws); `appliedBeforeFailure` correct on an `apply_errored` stream; durations computed from event timestamps; `outcome` reflects errored vs complete.
- Both: `truncated`/`truncationNotes` set exactly when a §6 cap fires.

**Diagnostic scrub (`secret-scrub.ts`) — WP-1:**
- Explicitly-registered secret string removed from `summary`/`detail`.
- PEM block / long base64 / hex run scrubbed by heuristic.
- Safe-default mode (`includeDiagnosticDetail=false`) omits `detail` entirely.
- A benign diagnostic is left intact (no over-scrubbing that destroys usefulness).

**Tab model (`digest-model.ts`) — WP-3:**
- Valid v1 plan/apply digest → typed object.
- Unknown newer `schemaVersion` → partial render signal + raw fallback, no throw.
- Malformed JSON → error state, no throw, offers raw/download.
- Oversize (> parse ceiling) → refused before parse.
- Prototype-pollution keys ignored.
- Missing/typo'd required field → rejected safely (not rendered as `undefined`).

**Tab components — WP-3:** each pure component tested for its states (empty, single, many, truncated-banner, sensitive/unknown/omitted value rendering, error). `RedactedValue` renders as `(sensitive)`/`(known after apply)` and never leaks a value type it shouldn't.

### 12.3 Regression testing — golden fixtures
- **Captured real-world corpus.** Commit a set of **sanitized** real `show -json` and `apply -json` captures under `Tasks/…/TerraformTaskV5/Tests/fixtures/` covering: a no-op plan, a create-only plan, a replace-with-`action_reason` plan, a destroy plan, a plan with sensitive outputs + sensitive nested attributes, a multi-provider plan, a drift plan, a successful apply, and a **partial-failure** apply. These fixtures MUST themselves be scrubbed of any real secret before commit (they are test data in a public repo).
- **Golden digests.** For each fixture, commit the expected redacted digest (a `.expected.json`) and assert the builder reproduces it byte-for-byte. This is the core regression guard: a future change to redaction/digest logic that alters output fails loudly, and a reviewer sees exactly what changed in the golden file. Because digests are deterministic (§12.2), snapshots are stable.
- **Tab snapshots.** Jest snapshot (or explicit DOM assertions) for each component rendered from a golden digest, so a UI regression is visible in review.
- **Backward-compat regression.** A test proving a `publishPlanResults`-only run still emits the byte-identical `terraform-plan-results` attachment and no `-summary` attachment; and a tab test proving a legacy raw-only attachment still renders via the ansi fallback. These guard the §11 compat contract against future drift.
- **Schema-version regression.** A fixture digest tagged `schemaVersion: 999` that the current tab must degrade on (not crash) — locks the forward-compat behavior.

### 12.4 Anti-regression tripwires (security invariants)
These are permanent guards, not one-off tests. Each fails CI if the invariant breaks:
1. **No-leak tripwire:** for every golden fixture, assert the known secret literals embedded in the *input* do **not** appear anywhere in the serialized digest. (Catches any redaction regression generically, even for a value shape no one wrote a targeted test for.)
2. **No-`dangerouslySetInnerHTML` tripwire (§8.1):** a jest test (or eslint `react/no-danger` scoped rule) asserting the token appears only in `RawView`/`ansi-to-html.ts` and nowhere else under `src/tab`.
3. **Parity tripwire:** `scripts/check-shared-modules.js` treats `digest-schema.ts` + `caps.ts` (+ any bundled copy of `redact.ts`) as byte-identical families — a drift between task and tab copies fails CI. Add a self-test (per the pattern from issue #511's fix) proving the gate actually rejects a divergent copy.
4. **No-new-network tripwire:** a tab test/CSP assertion that the only fetch host is the ADO-provided attachment origin (no CDN/telemetry/font). 
5. **Scope tripwire:** assert the extension manifest requests no scope beyond the existing build-read.

### 12.5 Coverage & CI
- Tab jest thresholds stay **at least** current (statements 80 / branches 78 / functions 60 / lines 80); the new pure modules should raise, not dilute, the numbers — target ≥ 90% statements on `digest-model.ts` and the redaction/digest modules since they are security-critical and pure (easy to cover fully).
- Task L0 must exercise both the structured and legacy paths; the coverage-gate exclusions (`nyc`) must **not** hide `redact.ts`/`*-digest.ts` (they are logic files — do not exclude).
- Every suite runs on both OS legs; a test that is inherently POSIX- or Windows-specific (e.g. a path-permission assertion) guards with a platform check and documents why, rather than silently skipping.
- No flaky/time-dependent tests: no `Date.now()`-derived assertions; durations tested with injected fixed timestamps.

---

## 13. Documentation deliverables (complete & accurate)

Documentation is a WP-gated deliverable and part of Definition of Done. Every doc claim must be **verified against the actual merged code** (file:line), not written from memory — the 2026-07 audit found multiple stale-doc findings (#513/#514/#515/#519) exactly from docs drifting off code, and this feature must not add more.

**Required artifacts:**
1. **`README.md`** — add the new inputs (`publishApplyResults`, the plan-summary toggle per D1, `includeDiagnosticDetail`) to the `PipelineTerraformTask@5` Inputs reference table with accurate types/defaults/`visibleRule` (sourced from `task.json`); document the structured **Terraform** tab (Plan/Apply pivots), the overview list, the raw fallback, and that attachments are redacted. Note the same-run-only correlation limit.
2. **`SECURITY.md`** — the residual-risk register (§5.10): provider-echoed diagnostics, reliance on Terraform sensitivity marks (cross-reference #491), attachments readable by anyone with build-read, and the diagnostic safe-default/opt-in behavior. Document the operator guardrails (`failOnSensitiveOutputs`, `includeDiagnosticDetail`).
3. **`CLAUDE.md`** — update the repo-structure/task notes for `src/results/` and the new tab components; add the digest-schema/caps parity families to the shared-module list; note the new attachment types.
4. **`docs/design/plan-apply-digest-spec.md`** — the frozen schema + redaction algorithm spec (authored in WP-0), kept in sync as the normative reference for the digest contract and `schemaVersion` history.
5. **`docs/`** user walkthrough — how to enable structured results, what each tab section shows, screenshots of the Plan overview/detail and the Apply timeline (screenshots added once the UI is real, in the docs WP or a follow-up). Add an entry to `docs/yaml-examples.md` showing `publishApplyResults`.
6. **`THIRD_PARTY_NOTICES.md`** — updated only if a new tab dependency is added (prefer none; §5.9).
7. **`docs/release-checklist.md`** — add manual verification steps for the new tab: publish a plan and an apply, confirm the tab renders structured output, confirm a sensitive-output plan shows `(sensitive)` and the attachment contains no cleartext secret (a manual no-leak check complementing the automated tripwire).
8. **In-code documentation** — `helpMarkDown` for every new `task.json` input (accurate, incl. the sensitivity/masking caveat and the same-run limit); doc-comments on `redact.ts`/digest builders stating the fail-closed invariant and why; `resources.resjson` entries for every new user-facing string (loc convention — no hardcoded English in the task).
9. **`CHANGELOG.md`** — release-please-driven; ensure conventional-commit prefixes produce accurate entries (feat for the tab, plus any security note).

**Accuracy gate:** the documentation WP must cite the file:line it drew each fact from in its PR body, and the completeness reviewer (§10 WP-6b) verifies docs match code. A doc statement that contradicts code is a must-fix finding, not a nit.

---

## 14. Definition of done
**Functional**
- All WPs merged onto the integration branch and thence to `main`; both OS CI legs green.
- Backward-compat verified by regression test (§12.3): `publishPlanResults`-only behaves identically and emits the byte-identical raw attachment; the tab renders legacy raw attachments unchanged.
- No new pipeline scope; no new third-party network call from the tab (tripwires §12.4.4/§12.4.5 passing).

**Security**
- Redaction test matrix (§12.2) complete and passing, incl. **shape-mismatch→masked** and every sensitivity source in §5.2.1.
- No-leak tripwire (§12.4.1) passing for every golden fixture.
- No-`dangerouslySetInnerHTML` tripwire (§12.4.2) passing; parity tripwire (§12.4.3) with its self-test passing.
- WP-6 adversarial security review returns **no unaddressed must-fix** (any redaction-leak/XSS/DoS/injection finding fixed by WP-7).
- SECURITY.md residual-risk register (§5.10) landed.

**Testing**
- Unit + integration + regression layers (§12.1) present for every module a WP added.
- Golden-fixture corpus (§12.3) committed (scrubbed), with `.expected.json` goldens; tab snapshots present.
- Coverage ≥ thresholds; security-critical pure modules ≥ 90% statements; no coverage-gate exclusion hides `redact.ts`/`*-digest.ts`.
- No flaky/time-dependent tests; both OS legs.

**Documentation**
- All §13 artifacts delivered and **verified against code** (file:line cited in the docs PR); completeness reviewer confirms docs match behavior.
- Every new input has accurate `helpMarkDown` + loc strings; digest spec doc committed; release-checklist updated with the manual no-leak check.
