# Structured Terraform results tab — user walkthrough

The `PipelineTerraformTask@5` task can publish a **structured, redacted JSON summary**
of a `plan`, `apply`, `destroy`, or the current state (`show`) to the pipeline run's
**Terraform** results tab, in addition to (or instead of) the legacy raw ANSI attachment.
This page walks through enabling it and reading each section. It is the standalone
companion to the summary in
[`README.md`](../README.md#structured-terraform-results-tab); see
[`SECURITY.md`](../SECURITY.md) for the residual risks the redaction depends on and
[`docs/design/plan-apply-digest-spec.md`](design/plan-apply-digest-spec.md) for the
normative digest/redaction contract.

## Enabling structured results

All inputs are optional (`required: false`) and default to today's behavior when unset.

| Input | Command | Type / default | Effect |
| --- | --- | --- | --- |
| `publishPlanResults` | `plan` | string (name), unset | Legacy raw ANSI plan attachment. Independent of the summary below. |
| `publishPlanSummary` | `plan`, `destroy` | string (name), unset | Structured, redacted **Plan** summary. Adds `-out=<tempfile>` to the plan and runs `terraform show -json` on it. On `destroy`, built from the destroy's own plan the same way and labeled **Destroy** in the tab; destroy still auto-approves and still fails the task on a non-zero exit. |
| `publishApplyResults` | `apply` | string (name), unset | Structured, redacted **Apply** summary. Runs apply with `-json`; each event's human-readable message is still echoed to the console. |
| `includeDiagnosticDetail` | `apply` | boolean, `false` | Include each apply diagnostic's longer `detail` field (higher residual leak risk than `summary`); no effect unless `publishApplyResults` is set. |
| `publishStateResults` | `show` | string (name), unset | Structured, redacted **State** inventory. Runs its own `terraform show -json` of the current state, independent of this step's own `commandOptions`/output settings. Has no effect if `commandOptions` names a saved plan file (that show is a planfile show, not a state show). |

Example (`azure-pipelines.yml`):

```yaml
- task: PipelineTerraformTask@5
  inputs:
    provider: azurerm
    command: plan
    publishPlanSummary: production      # structured Plan pivot
    # publishPlanResults: production    # optional: also keep the raw ANSI attachment

- task: PipelineTerraformTask@5
  inputs:
    provider: azurerm
    command: apply
    publishApplyResults: production     # structured Apply pivot
    # includeDiagnosticDetail: true     # optional: include diagnostic detail text

- task: PipelineTerraformTask@5
  inputs:
    provider: azurerm
    command: destroy
    publishPlanSummary: production      # structured Plan pivot, labeled "Destroy"

- task: PipelineTerraformTask@5
  inputs:
    provider: azurerm
    command: show
    publishStateResults: production     # structured State pivot (current state inventory)
```

See [`docs/yaml-examples.md`](yaml-examples.md) for more.

## Reading the Plan pivot

- **Overview list** (when more than one plan is published) — each plan's name with
  add / change / destroy / replace counts and a drift badge; select one to open its detail.
  A destroy plan additionally shows a **Destroy** badge.
- **Summary header** — the counts, `No changes` / `Drift detected` badges, the tool and
  version, and a **`This digest was truncated.`** notice with per-note reasons when any
  size cap was hit (see [Size caps](#size-caps--truncation)).
- **Resource list** — grouped by action (replace / delete / create / update / read / no-op)
  and filterable by address.
- **Resource diff** — for the selected resource, a before → after table of only the
  changed attributes.
- **Drift** — drifted resources (from `resource_drift`), rendered as before → after diffs.
- **Outputs** — masked output changes.

### Destroy plans

A `destroy` run with `publishPlanSummary` set publishes to the **same Plan pivot** as an
ordinary plan — a destroy plan is just a plan whose changes are all deletes, and Terraform
computes and saves one before applying exactly like `plan` does. The only difference is a
**Destroy** badge on the overview row and in the detail header. Destroy still auto-approves
and still fails the task on a non-zero exit; publishing the summary does not change that.

## Reading the Apply pivot

- **Overview list** (when more than one apply is published) — each apply's name, counts,
  and success / failed outcome.
- **Summary header** — counts, the `Succeeded` / `Failed` outcome badge, tool/version,
  and the truncation notice when applicable.
- **Apply timeline** — per-resource action, status (`started` / `complete` / `errored`),
  and duration, in the order Terraform reported them. On a failed apply, a
  **Completed before the apply errored** list shows the addresses that finished first.
- **Diagnostics** — errors first, then warnings; freeform text is scrubbed before display.
- **Outputs** — masked final outputs.

## Reading the State pivot

The State pivot shows a **point-in-time inventory** of the current Terraform state — not a
change set: no action, no before/after, no known-after-apply. Enable it with
`publishStateResults` on a `show` step (see above).

- **Overview list** (when more than one state inventory is published) — each inventory's
  name with resource / data-source counts; select one to open its detail.
- **Summary header** — the resource and data-source counts, the tool and version, and the
  truncation notice when applicable.
- **State inventory list** — grouped by resource type and filterable by address or type;
  each row expands to an attribute table of that resource's **current** values (address,
  type, provider, and — for a resource inside a module — its module path).
- **Outputs** — masked current output values (no action, since state is not a change set).

## Redaction

Every value is redacted **by the task, before the attachment is written** — the tab never
receives the underlying value. A value Terraform marks sensitive (via
`after_sensitive` / `before_sensitive` / `sensitive_values` / `outputs[].sensitive`)
renders as `(sensitive)`; a not-yet-known value renders as `(known after apply)`. When a
sensitivity mask's shape does not match its value, the value is **masked fail-closed**
(never shown) and the event is recorded in the truncation notes. Redaction relies on
Terraform correctly emitting those marks — see [`SECURITY.md`](../SECURITY.md).

The State inventory is redacted the same way, against each resource's own `sensitive_values`
mask; because state values are fully materialized, there is no unknown/known-after-apply
case for state.

## Size caps & truncation

To keep a large (or hostile) digest from bloating the attachment or the browser, the task
bounds each part of the digest and the tab re-applies the same bounds defensively. When a
bound is hit, `truncated` is set and a human-readable note explains what was capped; long
rendered lists also show an inline "List truncated to N of M …" banner. The limits are the
single-source-of-truth values in
[`docs/design/plan-apply-digest-spec.md`](design/plan-apply-digest-spec.md) §3 (resources,
attribute changes per resource, outputs, drift resources, diagnostics, per-value bytes,
applied-before-failure addresses, truncation notes, and the total-digest soft/hard byte
ceilings — plus, for State, its own resource and per-resource attribute caps, §7.4). A
digest whose declared size exceeds the tab parse ceiling is not rendered structurally;
download it from the build artifacts instead.

## Same-run only

The tab loads attachments only from the current pipeline run (build ID). It does not
correlate or display a plan/apply summary from a different run, and there is no cross-run
plan ↔ apply pairing.

## Raw fallback

Legacy `publishPlanResults` attachments — and any digest the tab cannot parse — still
render as ANSI-colored raw text, unchanged. Each structured detail view also offers a
**View raw digest** expander.
