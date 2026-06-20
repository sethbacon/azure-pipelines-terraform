<!--
Initiative 6: TerraformDriftReport task — move drift plan parsing out of the
inline runner script and into a first-class extension task.
-->
# Initiative 6: TerraformDriftReport task

## Implementation Status

**Not started.** Plan only. Supersedes nothing; additive to the extension.

## Goal

Replace the inline `terraform show -json | jq | curl` block that the Terraform
State Manager (TSM) backend bakes into its dispatched drift pipelines with a
first-class, cross-platform extension task: **`PipelineTerraformDriftReport`**.

The task parses a Terraform plan JSON document into the drift counts + summary
that TSM consumes, emits them as pipeline variables / a JSON artifact, and
(optionally) POSTs them to a TSM drift callback. It is **consume-only** — it
does not run `terraform plan`; `TerraformTaskV5` already does that and publishes
the plan path as `$(showFilePath)`.

### Why

The current runner-side parsing lives as an inline Bash + `jq` step in the
backend's generated templates (`terraform-state-manager-backend`,
`internal/api/drift_workflows.go`, consts `githubDriftWorkflow` /
`azureDriftPipeline`). Problems it carries:

- **Linux/bash only.** The `- bash:` step cannot run on Windows agents; a Node
  task runs on every agent the extension already supports (Node20_1 / Node24).
- **`jq` must be present** on the agent and the JSON is assembled in shell.
- **Hand-rolled JSON/shell-quoting safety.** The template's own comments document
  the `jq -n` / `--argjson` discipline needed to stop a crafted resource address
  from breaking out of the payload. A typed task removes that whole class of risk.
- **No tests, opaque failures.** A jq filter error surfaces as a shell non-zero;
  a task gives typed inputs, named errors, and unit tests (the extension's
  per-task `Tests/` convention).

## Decisions

1. **Consume-only, not plan-and-report.** Single responsibility; avoids
   duplicating Terraform execution/credential wiring already owned by
   `TerraformTaskV5`. The task's required input is a plan JSON file path, which
   pipelines typically set to `$(showFilePath)`.
2. **Generic first, TSM-aware by opt-in.** The task is a generic
   *plan-summary/drift-report* task. It always emits counts + summary as
   variables and a JSON artifact. The TSM callback POST is enabled only when
   `callbackUrl` + `callbackToken` are supplied. Keeps the extension
   product-agnostic and reusable outside TSM.
3. **Additive, not a replacement.** The backend keeps the inline jq template as
   the zero-dependency default. The task is the nicer optional path; the backend
   may later emit a task-based template variant when the extension is detected.
4. **Semantics are frozen against a shared fixture set** (see *Contract
   stability*). The TS implementation must produce byte-identical counts/summary
   to the Go parser and the jq template for the same plan JSON.

## Task: TerraformDriftReportV1

Location: `Tasks/TerraformDriftReport/TerraformDriftReportV1/`, mirroring the
layout of `TerraformPolicyCheckV1` (the closest existing analog — it also
consumes `terraform show -json` output, parses it, and publishes results).

```
Tasks/TerraformDriftReport/TerraformDriftReportV1/
├── task.json                       # new GUID; name PipelineTerraformDriftReport
├── package.json / tsconfig.json    # same toolchain as PolicyCheckV1
├── eslint.config.mjs
├── icon.png
├── Strings/en-US/resources.resjson
├── src/
│   ├── index.ts                    # entry: read inputs, orchestrate, publish
│   ├── summarize.ts                # the jq → TS port (the contract)
│   ├── provenance.ts               # module_calls + modules.json extraction
│   ├── callback.ts                 # optional POST (reuses the http.ts pattern)
│   └── types.ts
└── Tests/
    ├── summarize.spec.ts           # golden-fixture contract tests
    └── fixtures/                    # vendored from the backend (see below)
```

### task.json (shape)

- `id`: new GUID (generate once; never reused).
- `name`: `PipelineTerraformDriftReport`; `friendlyName`: "Pipeline Terraform drift report".
- `category`: `Utility`; `author`: `sethbacon`; `version`: `1.0.0`.
- `instanceNameFormat`: `Drift report ($(planJsonFile))`.
- `execution`: `Node20_1` and `Node24`, `target: src/index.js` (matches every
  current task).

### Inputs

| Input | Type | Req | Default | Notes |
|-------|------|-----|---------|-------|
| `planJsonFile` | filePath | yes | — | Output of `terraform show -json <plan>`. Typically `$(showFilePath)` from TerraformTaskV5. |
| `moduleManifest` | filePath | no | `.terraform/modules/modules.json` | Resolved module lockfile for locked versions; silently skipped if absent. |
| `includeModuleProvenance` | boolean | no | `true` | Emit `configuration.root_module.module_calls` (+ locks) for module freshness. |
| `failOnDrift` | boolean | no | `false` | When drift is detected, set task result to SucceededWithIssues (or Failed — see spike). |
| `detail` | string | no | `""` | Free-text run label forwarded as `detail` (e.g. `$(Build.BuildId)`). |
| `callbackUrl` | string | no | — | TSM callback URL. POST happens only if both URL and token are set. |
| `callbackToken` | string | no | — | Per-run one-shot token; sent as `X-TSM-Callback-Token`. Mark `secret`. |
| `rejectUnauthorized` | boolean | no | `true` | TLS verification for the callback (reuses http.ts knob). |

### Behavior

1. Resolve and read `planJsonFile`; fail with a clear message if missing
   (mirrors PolicyCheck's "Provide the JSON output of 'terraform show -json'").
2. `summarize()` classifies each `resource_changes[]` entry — **semantics fixed
   to match `driftingest.Summarize`** (see *Contract*):
   - `added` += actions contains `create`
   - `changed` += actions contains `update`
   - `destroyed` += actions contains `delete`
   - a replacement (`["delete","create"]`) counts as **both** added and destroyed
   - `summary` = every change whose actions are **not exactly** `["no-op"]`, as
     `{address, actions}`
3. `drifted` flag — **`drifted = any summary entry whose actions ⊄ {no-op, read}`**
   (resolved; see *drifted definition* below). A pure read-only refresh is not
   reported as drift; every create/update/delete/replace is.
4. If `includeModuleProvenance`, extract `module_calls` and parse
   `moduleManifest` into the `plan` + `module_locks` payload fields.
5. Publish:
   - pipeline variables: `driftDetected`, `addedCount`, `changedCount`,
     `destroyedCount`, `summaryFilePath`.
   - a JSON artifact file (the exact callback body) via `setVariable`/attachment.
6. If `callbackUrl` && `callbackToken`: POST the body with
   `Content-Type: application/json` and `X-TSM-Callback-Token`, using the
   `createHttpsClient()` helper pattern from
   `TerraformModulePublishV1/src/http.ts` (copied into the task — tasks are
   self-contained units in this repo, each with its own deps/compile entry).
7. If `failOnDrift` && drifted: set the task result accordingly.

### Callback body (must match the backend exactly)

Consumed by `terraform-state-manager-backend` `internal/api/drift.go`
`RunResults` (`POST /api/v1/drift/runs/{id}/results`):

```json
{
  "status": "completed",
  "added": 0, "changed": 0, "destroyed": 0,
  "drifted": false,
  "summary": [{ "address": "…", "actions": ["…"] }],
  "plan": { "configuration": { "root_module": { "module_calls": {} } } },
  "module_locks": null,
  "detail": "azdo build 1234"
}
```

## Contract stability (the crux)

The drift count/summary semantics now exist in **three** places that the
project must keep in lockstep:

- the jq in `drift_workflows.go` (runner), and
- `driftingest.Summarize` in `internal/services/driftingest/plan.go` (the
  `/drift/ingest` push path; its package doc literally says "matching CI
  workflows' jq semantics"), and
- the **GitHub twin**, already built and test-locked:
  `terraform-suite-github-actions/actions/drift-report/src/summarize.ts` (the
  reference TypeScript implementation, including the resolved `drifted` rule).

This ADO task adds a **fourth** implementation. **Do not write a new parser** —
port (or, better, share) the GitHub twin's `summarize.ts` so ADO and GitHub run
byte-identical logic. To stop the four from diverging:

- **Canonical fixtures live with the backend** (`driftingest` test data is the
  source of truth for semantics) as `plan.json` → expected `{added, changed,
  destroyed, summary}` pairs. Cover: pure create/update/delete, replacement
  (delete+create counts as both), `["no-op"]` exclusion, `["read"]` refresh
  (in summary, counts toward nothing), and an empty/clean plan. The GitHub twin
  already vendors these as `actions/drift-report/__tests__/fixtures/*.json`.
- The extension task **vendors the identical fixtures** into
  `Tests/fixtures/` and asserts `summarize()` matches the expected pairs.
- Add a short note + cross-link in all three repos so a semantics change in one
  is a PR checklist item in the others. (Future hardening: a CI step that fails
  if the vendored fixtures drift from the backend copy by checksum; and extract
  one shared `summarize()` package consumed by both the ADO task and the GitHub
  action, the cleanest end state.)

## Extension & repo integration

1. **Manifest** `azure-devops-extension.json`:
   - add `{ "path": "Tasks/TerraformDriftReport" }` to `files`;
   - add a contribution `custom-terraform-drift-report-task`;
   - bump extension `version` `1.3.0 → 1.4.0`.
2. **Root `package.json`** — add the per-task wiring that every task already has:
   `deps:npm:driftreport`, `deps:prune:driftreport`, `compile:driftreport`, and
   fold them into the aggregate `deps` / `deps:prune` / `compile` chains.
3. **`scripts/check-versions.js`** — add the new `task.json` to its file list.
4. **Docs** — task README section + an entry in the extension overview;
   document the `$(showFilePath)` → `planJsonFile` handoff with a YAML example.

### Example pipeline (what users write)

```yaml
- task: TerraformInstaller@1
  inputs: { terraformVersion: latest }
- task: TerraformTaskV5@5
  inputs: { command: plan, commandOptions: -detailed-exitcode }
  # publishes $(showFilePath) = terraform show -json output
- task: TerraformDriftReport@1
  inputs:
    planJsonFile: $(showFilePath)
    callbackUrl: $(tsmCallbackUrl)
    callbackToken: $(tsmCallbackToken)
    failOnDrift: false
```

## Verification spikes (resolve before locking task.json)

1. **`drifted` definition — RESOLVED.** The runner sets `drifted` from `terraform
   plan -detailed-exitcode` (exit `2`). A consume-only task has no exit code. The
   Go `Result.Drifted()` uses `len(summary) > 0`, but the backend's `RunResults`
   defaults `drifted = added+changed+destroyed > 0` when the field is absent —
   and a `["read"]`-only plan makes those disagree. **Decision: `drifted = any
   summary entry whose actions ⊄ {no-op, read}`** — a pure read-only refresh is
   not drift; every create/update/delete/replace is. The task always sends the
   `drifted` field, so this rule governs (the backend default never applies).
   This was implemented and test-locked first in the GitHub twin
   (`terraform-suite-github-actions/actions/drift-report/src/summarize.ts`,
   `isDrifted`); the ADO task must use the identical rule via the shared
   `summarize()` (see §5). Backend reconciliation (aligning `Result.Drifted()`
   to exclude `read`) is a separate optional follow-up, not required because the
   field is always present in the payload.
2. **`failOnDrift` result level.** SucceededWithIssues vs Failed — confirm which
   the TSM UX wants when drift is the *expected, reportable* outcome (lean
   SucceededWithIssues; Failed only on genuine task error).
3. **`$(showFilePath)` availability.** Confirm `TerraformTaskV5` sets it for the
   `plan` command in current versions and across Node20_1/Node24 (it is set in
   `base-terraform-command-handler.ts`; verify the variable name/scope).
4. **`-detailed-exitcode` vs task failure.** TerraformTaskV5 may treat exit `2`
   as failure; confirm the pipeline can reach the drift task after a "changed"
   plan (e.g. `continueOnError` or a documented option) so drift is still
   reported.

## Phases

- **Phase 0 — spikes.** Resolve the four above; freeze input schema + `drifted`
  rule. No code beyond throwaway YAML.
- **Phase 1 — task skeleton.** Scaffold the task dir from PolicyCheckV1; wire
  manifest, root scripts, `check-versions.js`; empty `summarize()` + passing
  no-op test; `npm run build:release` green.
- **Phase 2 — summarize + provenance.** Port jq → TS; vendor backend fixtures;
  golden-fixture contract tests pass. Emit variables + JSON artifact.
- **Phase 3 — callback.** Add the optional POST (http.ts pattern), secret
  handling, `rejectUnauthorized`, `failOnDrift`. Negative tests (missing token,
  non-2xx, bad URL).
- **Phase 4 — package + docs.** Bump to 1.4.0, `package:dev` smoke install,
  task README + cross-repo contract note. (Backend change to emit a task-based
  template is a separate follow-up in `terraform-state-manager-backend`.)

## Out of scope

- GitHub Actions parity (a matching JS action) — note the asymmetry; separate
  effort if pursued.
- Removing the backend's inline jq template (kept as the zero-dependency
  default).
- Running `terraform plan` inside the task.
