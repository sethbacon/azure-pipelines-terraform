# Plan: Real-terraform behavioral smoke harness + property/fuzz test layer

## Context

Two full audit-remediation cycles hardened this repo's security properties, but **#612 and #613 — argv-ordering / stream-handling bugs — escaped four consecutive audits and were found in production within hours of the feature being enabled.** Root cause is structural, not effort: the test suite is entirely mock-runner unit tests (`azure-pipelines-task-lib` `mock-run`/`mock-test`), where `ToolRunner` exec answers are keyed by exact command-line string — so the mock happily answers whatever argv the code emits, and a wrong argv order (flag after a positional, last-`-out=`-wins) is invisible. CI **never runs a real `terraform` binary** (no `hashicorp/setup-terraform` anywhere; the only "smoke test" is a manual markdown checklist in `docs/release-checklist.md`, never executed).

Separately, the sanitizer/parser seam keeps springing one-bypass-at-a-time leaks (#446/#498/#523/#552/#587 CSS-HTML, #605 decode, #646 JSON, #648 HCL, #606 sys_id) because every test is example-based — the next bypass is found by the next audit, not before.

This plan closes both gaps with the **narrowest** mechanism that covers the proven-miss classes:
1. A **real-terraform component/smoke harness** (local backend, no cloud) that exercises the compiled task's `handleProvider → argv-build → real-terraform-exec` path. Required PR gate on both OS legs.
2. A **property/fuzz layer** (`fast-check`) over the pure, security-critical parsers/sanitizers/escapers. Fixed-seed in the normal suite (gates PRs); nightly random-seed exploration files an issue on new counterexamples.

Both are additive, independently shippable, and deliberately exclude the expensive/flaky parts (real cloud WIF, real ServiceNow/registry, live signed-artifact downloads stay mocked).

---

## Workstream 1 — Real-terraform smoke harness

Lives entirely in `Tasks/TerraformTask/TerraformTaskV5/` (the only task that shells out to terraform). Kept as a **separate suite and CI job** — NOT folded into the existing `L0.ts` / `test:coverage`, so the normal mock suite stays terraform-free and fast, and local devs without terraform still run it.

### Why it works with no cloud (verified)
- Every provider's default (non-WIF) `handleProvider()` is pure env-var writes with **zero network calls** (`aws/gcp/oci/azure-terraform-command-handler.ts`); task-lib populates endpoint auth from `ENDPOINT_AUTH_*` env vars only. A fabricated fake service connection via env vars (exactly what existing tests set, e.g. `Tests/PlanTests/Azure/AzurePlanUserOutHonored.ts:22-26`) plus a fixture `.tf` that declares **no cloud provider block** means the task sets `ARM_*`/`AWS_*` vars terraform never consumes.
- Fixtures use only **`terraform_data`** (built into terraform core ≥1.4, no provider download) + `backend "local" {}`, so `terraform init` is fully offline — no `registry.terraform.io` dependency in CI. (Do NOT use `null_resource`/`random` — those require a provider download.)
- The binary is located via `resolveToolPath` (`src/terraform.ts:35-47`): prefer the `terraformLocation` pipeline variable, else `tasks.which(binaryName)` on PATH. A test controls it by setting `terraformLocation` or prepending PATH.
- The existing harness **already supports a no-mock mode**: `TaskMockRunner.run(true)` skips registering the `azure-pipelines-task-lib/task` mock, so `tr.setInput(...)` sets real `process.env['INPUT_*']` and `tasks.tool()` returns the real, spawning `ToolRunner`. Currently unused (`grep ".run(true)"` → no hits) — this is the harness entry point.
- **Constraint:** task-lib's `_loadData()` scans and *deletes* `INPUT_*`/`ENDPOINT_*` env vars once at first `require`, so each scenario needs a fresh process. `MockTestRunner` already spawns one child node process per scenario — reuse it.

### Structure (mirrors the existing triad)
New `Tests/SmokeTests/` with, per scenario, the same triad the repo already uses:
- `Tests/SmokeTests/fixtures/local-data/main.tf` — `terraform { backend "local" {} }` + a `terraform_data` resource + a `variable`/`output`. One or two fixture dirs cover all scenarios.
- `<Scenario>.ts` — builds `TaskMockRunner`, `setInput`s (provider/command/commandOptions/publish* toggles/workingDirectory=the fixture dir), sets fake `ENDPOINT_AUTH_*` env + `terraformLocation`, sets **no `exec` answers**, and calls `tr.run(true)` (no-mock). Pattern-identical to `Tests/PlanTests/Azure/AzurePlanUserOutHonored.ts` minus the `setAnswers` block.
- `<Scenario>L0.ts` — the driver already used by every test: `runCommand(new TerraformCommandHandlerAzureRM(), 'plan', '<name>')` (from `Tests/test-l0-helpers.ts`). Reused verbatim.
- Aggregator `Tests/SmokeL0.ts` — new mocha entry (parallel to `L0.ts`) that spawns each `<Scenario>.ts` via `MockTestRunner` and asserts on the **real outcome + filesystem/stream effects** in the fixture dir (not on mocked stdout).

### Scenario set (the regression floor first, then the matrix)
Proven-miss regression cases (build these first — they are the reason this exists):
- **#612 plan:** `commandOptions='-out=userplan.tfplan'` + `publishPlanSummary` set → assert `userplan.tfplan` exists in the fixture dir (NOT a `terraform-plan-<uuid>.tfplan` tempfile), exit 0/2, and the published `PlanDigest` was built from it. Triggers `extractOutFlagPath` reuse at `base-terraform-command-handler.ts:753-759`.
- **#612 destroy:** same, at `:1131-1137`.
- **#613 apply (saved plan):** create a real plan via `terraform plan -out=x.tfplan`, then `command=apply`, `commandOptions='x.tfplan'` (positional), `publishApplyResults` set → assert exit 0 (pre-fix real terraform rejects `apply -auto-approve <planfile> -json` as "Too many command line arguments"), NDJSON parsed into an `ApplyDigest`. Guards the `-json`-before-positional fix at `applyAutoApprove(terraformTool, ["-json"])` (`:991`, `:1179-1188`).
- **#613 stderr-surfacing:** `command=apply`, `commandOptions='missing.tfplan'`, `publishApplyResults` set → the structured path runs `silent:true`; assert the thrown/failed task message contains the *real terraform stderr* text (guards `:1019-1028`).

Baseline command matrix (behavioral coverage of the argv-build surface):
- `plan` (no opts); `plan` + `publishPlanSummary` (tempfile path, no user `-out`); `apply` (fresh, no saved plan) + `publishApplyResults`; `destroy` + `publishPlanSummary`; `show` current-state + `publishStateResults` (needs fake service connection — `show` calls `createAuthCommand`); `output -json`; `validate`/`fmt` (auth-free, `createBaseCommand`).
Each asserts exit code + the real file/stream artifact it should produce.

### Wiring
- `package.json` (TerraformTaskV5): add `"test:smoke": "npm run compile:all && mocha --timeout 60000 --require ts-node/register Tests/SmokeL0.ts"`. **No `nyc`** — smoke tests spawn compiled code as child processes and are for behavior, not coverage; running under nyc would misreport. So they do not touch `.nycrc.json` or `check-per-file-coverage.js`.
- `.github/workflows/unit-test.yml`: new job `build-and-test-v5-smoke`, matrix `[ubuntu-latest, windows-2025]`, cwd `Tasks/TerraformTask/TerraformTaskV5`: `npm ci --ignore-scripts` → **SHA-pinned `hashicorp/setup-terraform` with a pinned `terraform_version`** (matches the repo's pin-everything convention; `setup-terraform` puts terraform on PATH so `resolveToolPath` finds it) → `npm run test:smoke`. Also add a stable `build-and-test-v5-smoke-gate` wrapper if the matrix legs need one required context (mirrors the existing `build-and-test-tab-gate` pattern).
- **Branch protection (lead action, flagged — needs admin):** register the new smoke check context(s) as required, per the documented gh-api process in CLAUDE.md's "Required status checks". Note in the PR that this is a manual follow-up.
- Windows caution: fixture `.tf` files and any golden output must be treated for CRLF (the repo already hit LF↔CRLF warnings); pin fixture files via `.gitattributes` if needed. The #612/#613 bugs were Windows-found, so the windows-2025 leg is load-bearing, not decorative.

### Critical files
- Reuse: `Tests/test-l0-helpers.ts` (`runCommand`), the `TaskMockRunner`/`MockTestRunner` no-mock mode, `src/terraform.ts` (`resolveToolPath`/`terraformLocation`).
- New: `Tests/SmokeTests/**`, `Tests/SmokeL0.ts`, `package.json` script, `unit-test.yml` job.
- Do NOT modify `src/` — the harness exercises shipping code unchanged.

---

## Workstream 2 — Property / fuzz layer

`fast-check` as a **per-task devDependency** (only in tasks owning the target functions: TerraformTaskV5, Markdown2Html, PublishKbArticle, TerraformPolicyCheck, TerraformProviderMirror, and the installer family for `parseRetryAfterMs`). Dev-only, so no effect on `npm audit --omit=dev`; MIT, clean for `dependency-review`.

### Determinism model (chosen)
- **Fixed-seed, in-suite (gates every PR):** property files are `*PropertyL0.ts`, imported into each task's existing `Tests/L0.ts` so they run under the normal `test:coverage` with a fixed seed + modest `numRuns` (~1000). Deterministic, reproducible, flake-free, and they *raise* coverage on the pure target functions (bonus — no gate risk since coverage only goes up).
- **Nightly random-seed exploration (files an issue):** new `.github/workflows/nightly-fuzz.yml` (scheduled + manual dispatch, mirroring `weekly-security.yml`'s osv-scan → create-issue pattern) runs a per-task `"test:fuzz:explore"` script that re-executes the same `*PropertyL0.ts` files with `FUZZ_EXPLORE=1` (random seed, high `numRuns` ~50k, `endOnFailure`), `continue-on-error: true`, and opens a labelled issue with the printed seed + shrunk counterexample on any failure.
- Property files read env once: default = fixed seed via `fc.configureGlobal({ seed: <constant>, numRuns: 1000 })`; `FUZZ_EXPLORE=1` → `{ seed: Date.now()-random, numRuns: 50000 }`; `FUZZ_SEED=<n>` replays a reported counterexample. One helper module (`Tests/fuzz-config.ts`, copied per task or added to the parity families if shared).

### Targets (build in priority order; each is a pure function with a stated invariant)
From the verified inventory — property = "for all inputs, INVARIANT holds":
1. **`redactValue`** (`TerraformTaskV5/src/results/redact.ts`) — no sensitive leaf's raw bytes appear in `serializeDigest` output; any mask/value shape or array-length mismatch fails closed to `{kind:"sensitive"}`; `__proto__`/`constructor`/`prototype` dropped; deterministic. Seed corpus from `Tests/fixtures/` goldens. (Highest value — the #446 drift class.)
2. **`cssHasDangerousConstruct`** (`uri-scheme-guard.ts`, canonical Markdown2Html copy) — if the escape-decoded + comment-collapsed form contains `url(`/`@import`/`expression(`/`-moz-binding`/`behavior:`, result is `true`. Includes ReDoS timing bound on `DANGEROUS_CSS_PATTERN`. (The exact function bypassed by #587.)
3. **`sanitizeRenderedHtml` / `applyAllowlistSanitizer`** (`Markdown2Html/src/render.ts`) — output contains no tag outside the allowlist, no `on*` attribute, no dangerous-scheme URI, no `<foreignObject>`/`<annotation-xml>` mXSS carrier; parse→serialize→reparse round-trip is stable. (Five prior one-off bypasses.)
4. **`parseDigestText`** (`src/tab/digest-model.ts`) — never throws; no live prototype-pollution key; unrecognized `RedactedValue` shape → `{kind:"sensitive"}`; oversize rejected pre-parse. NOTE: `src/tab` is tested via **jest** (`jest.config.js`), not mocha — add this as a jest property test under the tab's test setup, with fast-check as a root devDependency, and its own nightly entry.
5. **`isDangerousUriScheme` ∘ `normalizeUriForSchemeCheck`** (`uri-scheme-guard.ts`) — browser-normalized form with `javascript:`/`vbscript:`/non-raster `data:` → `true`; generator focuses on control-char/entity injection (#446).
6. **`hcl`** (`TerraformPolicyCheck/src/sentinel-engine.ts`) + **`generateProviderInstallationConfig`/`escapeHclString`** (`TerraformProviderMirror/src/config-generator.ts`) — escaped value re-embedded in `"…"` parses back to the literal and opens no new HCL construct, `${`/`%{` interpolation, or newline (#648).
7. **`buildApplyDigest` / `buildPlanDigest` / `buildStateDigest`** (`TerraformTaskV5/src/results/`) — for adversarial JSON (deep nesting, unbounded arrays, unsafe keys, mask/value mismatch) the builder terminates, never throws, output stays within caps, no leak. Seed from existing goldens.
8. **`assertQueryValueSafe`** (`PublishKbArticle/src/servicenow-client.ts`) + **`ansiToHtml`** (`src/tab/ansi-to-html.ts`) — reject any `^`/CR/LF; and no `<`/`>`/`&` survives unescaped with always-balanced spans.

### Small refactor-to-fuzz (genuine hardening, cheap)
Three security-critical validators are currently module-private + env-coupled, so they can't be property-tested as-is. Extract a pure inner function (or add an `export`) so each becomes directly fuzzable — a real robustness win for token-exfil/SSRF guards:
- `isAllowedOidcRequestHost(hostname)` (`id-token-generator.ts`, reads `process.env`) — the ADO OIDC host allowlist (#554 fail-closed).
- `assertGoogleTokenUri(tokenUri)` (`gcp-terraform-command-handler.ts`, module-private) — GCP `token_uri` allowlist (#494/#594).
`validateIdentityDomainUrl` (`oci-token-exchange.ts`) and `validateMirrorUrl` (`config-generator.ts`) are already pure/exported — fuzz them directly, no refactor.

### Wiring
- Per target-owning task: add `fast-check` to `devDependencies`; add `import './<Name>PropertyL0'` to `Tests/L0.ts` (mocha tasks) or the jest test list (tab); add `"test:fuzz:explore": "cross-env FUZZ_EXPLORE=1 mocha --timeout 300000 --require ts-node/register 'Tests/**/*PropertyL0.ts'"` (or a jest `--testPathPattern` for the tab).
- New `.github/workflows/nightly-fuzz.yml` — SHA-pinned actions, `schedule` + `workflow_dispatch`, per-task `test:fuzz:explore`, `continue-on-error`, issue-on-failure step (copy the create-issue step from `weekly-security.yml`).
- Property files are test files → excluded from `src` coverage by `.nycrc.json`; they only raise coverage on targets, so no `check-per-file-coverage.js` risk.

### Critical files
- New: `Tests/**/<Name>PropertyL0.ts` per target, `Tests/fuzz-config.ts` helper, `.github/workflows/nightly-fuzz.yml`, `devDependencies` edits.
- Small `src/` refactors: `id-token-generator.ts`, `gcp-terraform-command-handler.ts` (export a pure inner validator only — no behavior change; keep diffs surgical, they're in the parity/security-tier files).

---

## Phasing
- **Phase 1 (smoke):** #612/#613 regression floor + baseline command matrix + required CI gate. Directly targets the only defect class with a proven production escape. Independently shippable.
- **Phase 2 (fuzz):** targets 1–4 (redactValue, cssHasDangerousConstruct, sanitizer, parseDigestText) in-suite + nightly workflow. Independently shippable.
- **Phase 3 (fuzz):** targets 5–8 + the two refactor-to-fuzz validators.

Each phase is its own PR chain, following the established cycle discipline (per-task `test:coverage` green, `check-shared-modules.js`/`check-task-list.js` green, verified-green merges only).

---

## Verification

**Smoke harness (local — needs terraform ≥1.4 on PATH):**
```
cd Tasks/TerraformTask/TerraformTaskV5
npm run test:smoke
```
Prove it catches the real bugs: `git stash` the #612/#613 fixes (or check out `e1694d2`'s parent of #626), rerun — the #612 scenario must show the tempfile written instead of `userplan.tfplan`, and the #613 apply scenario must fail with terraform's "Too many command line arguments". Restore fixes → green. This is the regression floor's acceptance test.
CI: the new `build-and-test-v5-smoke` job must pass on both `ubuntu-latest` and `windows-2025`.

**Fuzz layer (local):**
```
cd Tasks/TerraformTask/TerraformTaskV5   # (or each target-owning task)
npm run test:coverage                    # includes fixed-seed property tests; must stay green + coverage non-decreasing
FUZZ_EXPLORE=1 npm run test:fuzz:explore # deep random run; should find nothing on fixed code
```
Prove each property actually bites: temporarily reintroduce a known past bypass (e.g. revert #587's comment-ordering in a scratch copy) and confirm the `cssHasDangerousConstruct` property fails with a printed counterexample + seed. Reproduce any nightly failure with `FUZZ_SEED=<reported> npm run test:fuzz:explore`.
CI: `nightly-fuzz.yml` runs green on a manual `workflow_dispatch`; a deliberately-broken target opens the expected issue.

**Gate integrity (both):** `node scripts/check-shared-modules.js`, `node scripts/check-task-list.js`, `node scripts/check-versions.js` all green (the smoke script + fuzz files are additive; the two `src/` export refactors keep the parity copies byte-identical — sync all copies).
