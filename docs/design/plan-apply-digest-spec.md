# Plan/Apply Digest — Frozen Contract & Redaction Algorithm (schemaVersion 1)

**Status:** normative (frozen by WP-0). **Owner of the types/constants:** WP-0.
**Authoritative source of the design:** [`docs/initiatives/structured-plan-apply-tabs.md`](../initiatives/structured-plan-apply-tabs.md) (section numbers below, e.g. §5.2, refer to that document).

This document is the normative reference for the **redacted** plan/apply *digest*: the compact JSON the task attaches (`terraform-plan-summary` / `terraform-apply-summary`) and the build-results tab renders. It exists so that every downstream work package (WP-1 builders + redaction, WP-2 task wiring, WP-3 tab) implements against **one frozen contract** and does not re-decide the shape, the redaction rules, or the size limits.

Two files are the machine-readable half of this contract; they are **byte-identical duplicated** between the task and the tab and gated by `scripts/check-shared-modules.js` (decision D4, below):

| File | Copies (both byte-identical) | What it fixes |
|---|---|---|
| `digest-schema.ts` | `Tasks/TerraformTask/TerraformTaskV5/src/results/digest-schema.ts` · `src/tab/digest-schema.ts` | The TypeScript shape of the digest (this doc §1) |
| `caps.ts` | `Tasks/TerraformTask/TerraformTaskV5/src/results/caps.ts` · `src/tab/caps.ts` | The single-source size/DoS limits (this doc §3) |

**Any change to the schema, the caps, or the D1–D4 decisions is a design change, not an implementation choice** — it edits this doc and both copies of the affected file in the same commit.

---

## 0. schemaVersion history

| schemaVersion | Status | Notes |
|---|---|---|
| `1` | current | Initial contract: plan digest + apply digest, `RedactedValue` union, §3 caps. |

Producers stamp `schemaVersion: 1`. Consumers (the tab's `digest-model.ts`) MUST treat a **higher** `schemaVersion` than they know as "produced by a newer task version": render what is understood, show a note, and offer the raw fallback — never throw (§11 compat, §12.4 schema-version tripwire). A missing, non-numeric, or otherwise structurally invalid version is rejected safely to the raw fallback.

---

## 1. Schema (v1)

`digest-schema.ts` is authoritative; this section is the human summary. Every string in a digest is **post-redaction** and is rendered by the tab as a React **text node** only (never HTML — no `dangerouslySetInnerHTML` in the structured path, §5.3).

### 1.1 Envelope (both kinds)

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
    createdIso: string;         // agent-provided timestamp, not Date.now() in workflow context
  };
  truncated: boolean;           // true if any §3 cap was hit
  truncationNotes?: string[];   // human-readable ("resource list capped at 2000", etc.)
}
```

### 1.2 Plan digest — from `terraform show -json <planfile>`

```ts
interface PlanDigest extends DigestEnvelope {
  kind: "plan";
  summary: { add; change; destroy; replace; read: number; noChanges; driftDetected: boolean };
  resources: PlanResource[];       // capped (§3)
  outputChanges: OutputChange[];   // masked
  drift?: DriftResource[];         // from resource_drift, masked
}

interface PlanResource {
  address: string; type; name; providerName: string;
  actions: ("no-op"|"create"|"read"|"update"|"delete"|"replace"|"forget")[];
  actionReason?: string;
  replacePaths?: string[];
  attributeChanges: AttrChange[];  // ONLY changed attrs; capped per resource (§3)
}

interface AttrChange { path: string; before: RedactedValue; after: RedactedValue; }

interface DriftResource {          // WP-0 fixed shape (design §4.2 references but does not spell out)
  address: string; type; name; providerName: string;
  attributeChanges: AttrChange[];  // masked; before = state, after = observed reality
}

type RedactedValue =
  | { kind: "value"; json: string }        // JSON-encoding of the already-redacted subtree (bounded, §3)
  | { kind: "sensitive" }                  // renders "(sensitive)"
  | { kind: "unknown" }                    // renders "(known after apply)"
  | { kind: "omitted"; reason: "too-large" };
```

### 1.3 Apply digest — from the `terraform apply -json` NDJSON stream

```ts
interface ApplyDigest extends DigestEnvelope {
  kind: "apply";
  outcome: "succeeded" | "failed";
  summary: { add; change; destroy: number; durationMs?: number };
  resources: ApplyResource[];      // capped (§3)
  diagnostics: Diagnostic[];       // masked (§4.9)
  outputs: OutputChange[];         // masked, final outputs
  appliedBeforeFailure?: string[]; // addresses completed before an errored apply
}

interface ApplyResource {
  address: string; action: "create"|"update"|"delete"|"replace"|"read";
  status: "started"|"complete"|"errored"; durationMs?: number;
}

interface Diagnostic { severity: "error"|"warning"; summary: string; detail?: string; address?: string; }

interface OutputChange { name: string; action: "create"|"update"|"delete"|"no-op"; value: RedactedValue; }

type Digest = PlanDigest | ApplyDigest; // discriminated on `kind`
```

**Source mapping** (§4):
- Plan ← `resource_changes[]` (`.change.actions`, `.before`, `.after`, `.after_unknown`, `.before_sensitive`, `.after_sensitive`, `.action_reason`, `.change.replace_paths`), `output_changes`, `resource_drift`, `terraform_version`.
- Apply ← `apply_start` / `apply_progress` / `apply_complete` / `apply_errored`, `diagnostic`, `change_summary`, `outputs` events.

---

## 2. Redaction algorithm (the core security control, §5.2)

Redaction converts a raw Terraform value + its sensitivity/unknown *mask maps* into a `RedactedValue`. It is a **single shared function**, used by both the plan and apply builders, so detection and redaction cannot drift (§5.2.6/§5.2.7). **Build the redacted tree first, then serialize — never serialize the raw value and try to scrub it afterwards (§5.2.5).**

Reference signature (§7):

```
redactValue(value, sensitiveMask, unknownMask, ctx) -> RedactedValue
```

`ctx` carries the caps (§3) and a sink for `truncationNotes` (so a fail-closed event is observable).

### 2.1 Sensitivity sources — the UNION that marks a value sensitive (§5.2.1)

A value is sensitive if **any** of these says so. The builders feed the right mask into `redactValue`:

1. **`after_sensitive` / `before_sensitive`** mark maps in `resource_changes[].change`. Each is either `true` (whole value sensitive), `false`/absent (nothing sensitive), or an **object/array mirroring the value's shape** with `true` at sensitive leaves.
2. **`sensitive_values`** on resources in `planned_values` / `prior_state` (same shape-parallel mask form).
3. **`outputs[].sensitive`** — plan `output_changes` and state outputs (a whole-output boolean).
4. **Provider-marked** sensitivity arrives through the **same** mask maps — no separate code path, but do **not** assume only config-level `sensitive` exists.

The mask fed to `redactValue` is the **shape-parallel sensitivity mask** for that value from whichever of the above applies. `before` is redacted with `before_sensitive` and **no** unknown mask; `after` is redacted with `after_sensitive` **and** `after_unknown` (see §2.7).

### 2.2 Unknown source (§5.2.3)

`after_unknown` is shape-parallel to the `after` value, `true` at known-after-apply leaves. It is passed as `unknownMask` **only** for `after`. A masked-sensitive leaf wins over unknown (sensitivity is checked first).

### 2.3 Result vocabulary & in-collection sentinels (WP-0 decision)

`redactValue` returns exactly one `RedactedValue`. For a **whole** value that is sensitive/unknown, that is `{kind:"sensitive"}` / `{kind:"unknown"}`. For a value with **sensitive/unknown leaves nested inside a collection**, the collection is emitted as `{kind:"value"; json}` where each sensitive leaf is replaced by the JSON string `"(sensitive)"` and each unknown leaf by `"(known after apply)"`.

Rationale (WP-0 resolution of an under-specified detail): the tab renders these strings as plain text anyway, and a structured per-leaf sentinel would complicate the value renderer for no security benefit — **no raw secret is ever emitted** either way. A benign literal string equal to `"(sensitive)"` is cosmetically indistinguishable from a masked leaf; this is documented, cosmetic, and not a disclosure. The whole collection is still counted as "contains sensitive data" for summary/size purposes (§5.2.2).

### 2.4 Recursive walk (pseudocode)

`redactNode` returns a tagged node: `{t:"sensitive"}`, `{t:"unknown"}`, or `{t:"plain", v}` where `v` is a fully-known, non-sensitive plain JS value with inner sentinels already substituted.

```
redactNode(value, sMask, uMask, ctx):
    # (1) whole-subtree sensitivity wins over everything
    if sMask === true: return {t:"sensitive"}
    # (2) whole-subtree unknown (only if not sensitive)
    if uMask === true: return {t:"unknown"}

    # (3) scalar / null value
    if value is null or string/number/boolean:
        # a container mask over a scalar value is a shape mismatch -> FAIL CLOSED
        if isContainer(sMask) or isContainer(uMask):
            note(ctx, "sensitivity mask shape mismatch at <path>; masked fail-closed")
            return {t:"sensitive"}
        return {t:"plain", v: value}

    # (4) array value
    if value is array:
        # mask, if a container, MUST be an array of the same shape; else FAIL CLOSED
        if (isContainer(sMask) and not isArray(sMask)) or (isContainer(uMask) and not isArray(uMask)):
            note(...); return {t:"sensitive"}
        out = []
        for i in 0..value.length-1:
            child = redactNode(value[i], elem(sMask,i), elem(uMask,i), ctx)
            out.push(materialize(child))          # sentinel string, or child.v
        return {t:"plain", v: out}

    # (5) object value
    if value is object:
        if (isContainer(sMask) and isArray(sMask)) or (isContainer(uMask) and isArray(uMask)):
            note(...); return {t:"sensitive"}     # array mask over object value -> mismatch
        out = {}
        for key in ownEnumerableKeys(value) sorted lexicographically:     # determinism (§2.6)
            if key is "__proto__" or "constructor" or "prototype":        # prototype-pollution guard (§2.5)
                note(ctx, "dropped unsafe key '<key>' at <path>"); continue
            child = redactNode(value[key], prop(sMask,key), prop(uMask,key), ctx)
            out[key] = materialize(child)
        return {t:"plain", v: out}

# helpers
isContainer(m)      = m is a non-null object or array
elem(mask,i)        = isArray(mask) ? mask[i] : false     # absent index -> not sensitive/unknown
prop(mask,key)      = (mask is a non-array object) ? mask[key] : false   # absent key -> not sensitive/unknown
materialize(child)  = child.t=="sensitive" ? "(sensitive)"
                    : child.t=="unknown"   ? "(known after apply)"
                    : child.v
```

Top-level wrapper:

```
redactValue(value, sMask, uMask, ctx):
    node = redactNode(value, sMask, uMask, ctx)
    if node.t == "sensitive": return {kind:"sensitive"}
    if node.t == "unknown":   return {kind:"unknown"}
    json = stableStringify(node.v)                        # sorted keys (§2.6)
    if byteLength(json) > MAX_REDACTED_VALUE_BYTES: return {kind:"omitted", reason:"too-large"}
    return {kind:"value", json}
```

### 2.5 Prototype-pollution guard (§5.3.4)

When walking object keys, keys exactly equal to `__proto__`, `constructor`, or `prototype` are **skipped entirely** (never emitted into the redacted value, never recursed into) and recorded via a `truncationNote`. Build result objects so an attacker-supplied key cannot reach `Object.prototype` (e.g. assign onto a null-prototype object, or an object whose dangerous keys are pre-excluded). The tab's `digest-model.ts` performs the same guard **independently** on parse — defense in depth, do not rely on the producer.

### 2.6 Determinism (§12.2)

The digest MUST be byte-identical for identical input so golden-fixture/snapshot regression is meaningful:
- Object keys are serialized in **lexicographic** order (in `stableStringify` and while walking).
- Arrays preserve index order.
- `attributeChanges` are sorted by `path` (also the §3 cap tie-break).
- No `Date.now()` in digest content: `meta.createdIso` comes from an injected/agent-provided timestamp.

### 2.7 `before` vs `after` asymmetry (§5.2.3)

`before` is prior state and is always fully known: redact it with `before_sensitive` and **no** unknown mask. `after` may be partially unknown: redact it with `after_sensitive` **and** `after_unknown`. Because `after` is computed independently from the `after` value, an unknown `after` becomes `{kind:"unknown"}` — the pre-refresh `before` is **never** emitted as the "after".

### 2.8 Fail-closed rule (§5.2.4) — the single most important invariant

Whenever the mask map and the value shape **disagree** (mask is a container where the value is a scalar; mask is an array where the value is an object, or vice-versa; mask deeper/shallower than the value), `redactValue` **treats the value as sensitive** — it returns `{kind:"sensitive"}` (or substitutes the sentinel for a nested node) and records a `truncationNote`. Leaking is never the failure mode. WP-1 MUST have a unit test for shape-mismatch → masked (§12.2).

---

## 3. Size / DoS caps (single source: `caps.ts`, §6)

The `caps.ts` constants are the only place these numbers live. On any cap, the producer sets `truncated=true` and appends a `truncationNotes` entry — **never silently drop**.

| Concern | `caps.ts` constant | Value | Behavior on exceed | Applied by |
|---|---|---|---|---|
| resources in digest | `MAX_RESOURCES` | 2000 | keep first 2000 by **action priority** (destroy/replace first), note count | plan/apply builder |
| attribute changes / resource | `MAX_ATTR_CHANGES_PER_RESOURCE` | 200 | keep changed attrs **alphabetically** by path, note remainder | plan builder |
| bytes / `RedactedValue.json` | `MAX_REDACTED_VALUE_BYTES` | 4096 (4 KB) | emit `{kind:"omitted",reason:"too-large"}` | `redactValue` |
| diagnostics | `MAX_DIAGNOSTICS` | 500 | keep all **errors first**, then warnings, note remainder | apply builder |
| total digest bytes (soft) | `SOFT_MAX_DIGEST_BYTES` | 5·1024² (5 MB) | drop `attributeChanges` arrays (keep rows + summary), set `truncated` | builder, post-assembly |
| total digest bytes (hard) | `HARD_MAX_DIGEST_BYTES` | 12·1024² (12 MB) | attach a **summary-only** digest | builder, post-assembly |
| tab parse ceiling | `TAB_PARSE_CEILING_BYTES` | 16·1024² (16 MB) | refuse structured render, offer raw/download | tab (`digest-model`) |
| tab rendered rows | `TAB_MAX_RENDERED_ROWS` | 2000 | banner "list truncated" | tab (list components) |

"KB"/"MB" here are binary (KiB/MiB). The tab enforces the caps **defensively** — it does not trust the producer's `truncated` flag (§5.5).

Action priority order for the `MAX_RESOURCES` cap: `delete`/`replace` first, then `update`, then `create`, then `read`, then `no-op` — so the most consequential changes survive truncation.

---

## 4. Adjacent controls (owned by WP-1/WP-2, specified here for the frozen contract)

### 4.9 Diagnostic freeform scrub (`secret-scrub.ts`, §5.4)

Diagnostic `summary`/`detail` are freeform strings a provider may build from user input and are **not** covered by a structured mask. Before adding them to `diagnostics`:
1. **Explicit known-secret replacement:** string-replace every value the task registered via `setSecret` (WIF tokens, provider creds, known `TF_OUT_*`/var-file secrets) out of `summary`/`detail`.
2. **Heuristic scrub (best-effort):** redact long base64/hex runs and `-----BEGIN … KEY-----` blocks.
3. **Safe default:** the `includeDiagnosticDetail` input defaults to `false` → include only `summary` + `address`, not `detail`, unless explicitly opted in.

Residual risk (a provider-echoed secret the task never registered and no heuristic catches) is documented in `SECURITY.md` (§5.10). Diagnostics are still rendered as text nodes only.

### 4.10 Attachment-name / logging-command injection (§5.6)

`publishPlanSummary` / `publishApplyResults` values become attachment names and are interpolated into `##vso[task.addattachment …]`. The producer MUST reject/scrub CR/LF and `]` / `;` / `%` control sequences and cap the length before use. In the tab the name is untrusted text (React text node); the `download` filename is sanitized to `[A-Za-z0-9._-]` with a length cap.

---

## 5. Decisions D1–D4 (RESOLVED — transcribed verbatim from initiative §11)

These are frozen. A future change to any of them is a **design change**, not an implementation choice.

> **Q (D1): Should structured output be a new input, or a boolean modifier on the existing `publishPlanResults`?**
> **A: New, separately-named inputs — `publishPlanSummary` (plan) and `publishApplyResults` (apply).** Rationale: (a) independent `visibleRule`s (`command = plan` vs `command = apply`) that a single modifier can't express; (b) `publishPlanResults` keeps its exact current meaning (raw attachment), so no existing pipeline changes behavior — the strongest backward-compat guarantee; (c) an operator can publish raw-only, summary-only, or both. Trade-off accepted: one more input on the task. The plan-summary and raw attachments are independent and may both be emitted.

> **Q (D2): `apply -json` replaces the human console log. How do we preserve a readable live log without leaking?**
> **A: Echo each event's `@message` field verbatim to the console; never echo raw structured fields.** Rationale: `@message` is Terraform's own human-readable, already-redacted line — reusing it preserves the exact live-log experience operators expect while the structured (secret-bearing) fields are only ever consumed by the redaction pipeline, never printed. Reconstructing our own message text was rejected as redundant and a second place a secret could slip through. The digest is built from the structured fields *after* redaction.

> **Q (D3): One combined tab or keep a separate plan tab? And reuse the contribution id?**
> **A: One combined "Terraform" tab with Plan/Apply (and later State) pivots, reusing the existing `terraform-plan-tab` contribution id** — change only the display name. Rationale: reusing the id preserves any existing deep links and avoids a second manifest contribution / tab clutter; pivots are internal to the tab (no manifest change); a single tab is where the plan↔apply reconcile UI (Phase 4) naturally lives. `supportsTasks` is unchanged. A separate Apply tab was rejected as more manifest surface for no user benefit.

> **Q (D4): Single shared source for `digest-schema.ts` / `caps.ts`, or duplicated copies?**
> **A: Duplicated copies (task `src/results/` + `src/tab/`), byte-identity-gated by `scripts/check-shared-modules.js` with a self-test.** Rationale: the task compiles via `tsc -b` and the tab bundles via a separate webpack root from `src/tab`, so a single imported source can't span both build boundaries without restructuring the build — out of proportion to the benefit. The parity gate (plus its self-test, §12.4.3) makes drift a CI failure, giving the same guarantee a single source would, at lower blast radius. This is the same pattern the repo already uses for `gpg-verifier.ts`/`https-client.ts`/`uri-scheme-guard.ts`.

---

## 6. Downstream contract summary (what WP-1/2/3 read)

**Exported from `digest-schema.ts` (both copies byte-identical):**
`DigestEnvelope`, `PlanDigest`, `PlanResource`, `AttrChange`, `DriftResource`, `RedactedValue`, `ApplyDigest`, `ApplyResource`, `Diagnostic`, `OutputChange`, `Digest`.

**Exported from `caps.ts` (both copies byte-identical):**
`MAX_RESOURCES`, `MAX_ATTR_CHANGES_PER_RESOURCE`, `MAX_REDACTED_VALUE_BYTES`, `MAX_DIAGNOSTICS`, `SOFT_MAX_DIGEST_BYTES`, `HARD_MAX_DIGEST_BYTES`, `TAB_PARSE_CEILING_BYTES`, `TAB_MAX_RENDERED_ROWS`.

**Parity gate:** `scripts/check-shared-modules.js` carries a family pairing `Tasks/TerraformTask/TerraformTaskV5/src/results` with `src/tab` for `digest-schema.ts` + `caps.ts`. Because that family's second directory is the repo-root tab source (not under `Tasks/`), `scripts/test-check-shared-modules.js` copies `src/` in addition to `Tasks/` into its scratch tree. A drift between the task copy and the tab copy fails CI.
