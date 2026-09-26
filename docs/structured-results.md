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
| `publishPlanSummary` | `plan`, `destroy` | string (name), unset | Structured, redacted **Plan** summary. Adds `-out=<tempfile>` to the plan and runs `terraform show -json` on it — unless your `commandOptions` already saves the plan with its own `-out=<path>`, in which case that path is reused (no second `-out=` is injected, so your artifact plan is still written and the summary describes the exact plan you will apply). On `destroy`, built from the destroy's own plan the same way and labeled **Destroy** in the tab; destroy still auto-approves and still fails the task on a non-zero exit. |
| `publishApplyResults` | `apply` | string (name), unset | Structured, redacted **Apply** summary. Runs apply with `-json` (placed before any positional saved-plan file in `commandOptions`); each event's human-readable message is still echoed to the console, and on failure terraform's stderr is surfaced too. |
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

## What the tab opens on

- **Needs review** — above the pivots, a list of everything in the run worth a look before
  approving: failed applies (with their error count), plans that destroy (Terraform's own
  count, noting replacements), destroy plans, drift, and any digest that couldn't be read or
  was truncated. Select an entry to open it.
- **Pivot tabs** show how many plans, applies, and state inventories were published, and
  the Apply tab says **failed** when any apply failed.
- **Default view** — the tab opens on the Apply pivot when an apply failed, otherwise on
  the Plan pivot. In each pivot the item that most needs review is selected first: a plan
  that destroys, then one that can't be read or is truncated, then drift, then any other
  change; a failed apply before a successful one.

### Where each result came from

Plans, applies and state inventories are listed in the order their steps ran in the
pipeline (stage, then job, then step), and each one names that step, for example
`Plan prod › Plan › Terraform plan`, with a **View step log** link in its detail view.
This comes from the build's timeline: the attachment's URL names the step that published
it, so it doesn't rely on anything the attachment says about itself. When the timeline
can't be read, items are listed by name and show the stage and job the digest recorded.

Any step in a pipeline can publish an attachment of these types with
`##vso[task.addattachment]`, so a result that a step other than the Terraform task
published is marked **Not from the Terraform task** and listed under **Needs review**.

Results download four at a time, with a progress count while the tab first loads. A body
without a declared size is read as a stream and dropped as soon as it passes the parse
ceiling, rather than being read in full first.

## Reading the Plan pivot

- **Overview list** (when more than one plan is published) — each plan's name with
  add / change / destroy / replace counts and a drift badge; select one to open its detail.
  A destroy plan additionally shows a **Destroy** badge.
- **Summary header** — the counts, `No changes` / `Drift detected` badges, the tool and
  version, and a **Partial view** banner when any size cap was hit, with the reasons behind
  a disclosure (see [Size caps](#size-caps--truncation)).
- **Resource changes** — the resources the plan touches, grouped by action (import /
  replace / destroy / add / change / read / forget) and filterable by address. Action chips
  (Destroy, Add, Change, …) narrow the list to one group. Select a resource to expand,
  directly under its row, a before → after table of only the changed attributes. Unchanged
  resources are collapsed into a single **Unchanged (N)** line; select it to list them.
  - Each row gives the reason in Terraform's own wording ("must be replaced", "no longer
    in configuration", …) and tags a replacement that creates the new resource before
    destroying the old one.
  - In the attribute table, the attributes that force a replacement are tagged **forces
    replacement**. A resource being created shows each attribute's new value, and one being
    destroyed its current value, instead of a column of `null`s.
  - For a changed map, list or nested block — tags, a `site_config` block, a JSON policy
    document inside a string — the row lists only the keys and elements that changed
    (`+` added, `-` removed, `~` changed) and how many stayed the same, with both full
    values behind **Full values**.
  - `(sensitive)`, `(known after apply)` and `(value omitted: too large)` are styled apart
    from real values, including where they appear inside a map or list.
- **Drift** — drifted resources (from `resource_drift`), each comparing what Terraform's
  state recorded (**In state**) with what the provider found (**Actual**). Collapsed until
  you open it; its heading shows how many resources drifted.
- **Output changes** — masked output changes. Unchanged outputs stay behind a
  **Show N unchanged outputs** link.
- **Terraform CLI output** — when the same step also set `publishPlanResults` under the
  same name, its colored CLI output, collapsed until you open it. CLI output published
  under a name no structured plan uses gets its own section at the end of the pivot.

Every section heading shows a count, and selecting it collapses or expands the section.

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
  how long the apply took, and the partial-view banner when applicable.
- **Resources** — the apply timeline: per-resource action, status (`started` / `complete` /
  `errored`), and duration, with the three slowest resources named above it. A successful
  apply lists resources in the order Terraform reported them; a failed apply groups them
  as **Errored**, **Still running when the apply stopped**, and **Completed**, and a
  **Completed before the apply errored** list shows the addresses that finished first.
- **Diagnostics** — errors first, then warnings, with the heading counting each (for
  example `2 errors, 1 warning`); freeform text is scrubbed before display. On a failed
  apply this section comes first. Diagnostics are only included when the apply step sets
  `includeDiagnostics`, so a failed apply without them says so and points to the step log.
- **Outputs** — masked final outputs.

## Reading the State pivot

The State pivot shows a **point-in-time inventory** of the current Terraform state — not a
change set: no action, no before/after, no known-after-apply. Enable it with
`publishStateResults` on a `show` step (see above).

- **Overview list** (when more than one state inventory is published) — each inventory's
  name with resource / data-source counts; select one to open its detail.
- **Summary header** — the resource and data-source counts, the tool and version, and the
  truncation notice when applicable.
- **Resources** — the state inventory, grouped by resource type and filterable by address or type;
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

Legacy `publishPlanResults` attachments still render as ANSI-colored raw text, unchanged.
A digest the tab cannot parse is shown as plain text instead, and each structured detail
view also offers a **View raw digest** expander with the digest's JSON as plain text,
rendered only once it is opened. Raw output over 2 MB is offered as a download rather
than rendered inline.
