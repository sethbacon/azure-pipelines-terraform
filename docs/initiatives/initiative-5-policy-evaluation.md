<!-- markdownlint-disable MD013 -->
# Initiative 5: Policy Agent Installer + Terraform Policy Evaluation

## Implementation Status

**Status: IMPLEMENTED (2026-06-12)** on branch `feat/policy-agent-tasks`. Both tasks built, compiling, lint-clean, and tested (PolicyAgentInstallerV1: 7 L0 tests; TerraformPolicyCheckV1: 10 L0 tests). Spikes resolved:

- **S1** — Sentinel is on the checkpoint API (`v1/check/sentinel`); fallback version pinned. OPA latest via the GitHub `releases/latest` API.
- **S2** — `sentinel apply` with no policy arg runs all policies in the generated `sentinel.hcl`; static import syntax `import "static" "<name>" { source = "...", format = "json" }`.
- **S3** — OPA assets: `opa_{linux,darwin,windows}_{amd64,arm64}[.exe]` each with a `.sha256` sibling (no 386/arm). Verified against v1.17.1.
- **S4** — The standalone Sentinel CLI does **not** gate on `enforcement_level` (HCP-only). Exit codes are 0 pass / 1 fail / 2 undefined / 3 runtime / 9 other. Enforcement (advisory/soft/hard + override) is applied by the task off the exit code.

Remaining: live-agent validation of `sentinel apply` JSON/stdout shape for richer per-policy JUnit cases; live cloud pipeline runs.

## Goal

Extend `pipeline-tasks-terraform` with two new tasks:

1. **PolicyAgentInstallerV1** — install a policy engine binary (**Sentinel** or **OPA**) from official releases, the private registry (`terraform-registry-backend`), or a custom mirror.
2. **TerraformPolicyCheckV1** — evaluate policies from a git repository against Terraform plan JSON, supporting both engines, with pass/fail gating, enforcement levels, and pipeline-native result reporting.

## Decisions (confirmed 2026-06-11)

| Decision | Choice |
| --- | --- |
| Engines | **Both** Sentinel and OPA, selected via picklist (mirrors the `terraform`/`tofu` binary picklist precedent) |
| Policy source | **Both**: a local path (ADO multi-repo checkout — recommended/default) or a git URL the task clones at a given ref, with optional auth for private repos |
| Task placement | Two **new** tasks in this extension. `TerraformInstallerV1` is NOT extended — its inputs, output variables (`terraformLocation`), and messages are terraform-specific. Precedent: `TerraformProviderMirrorV1` is a separate task |

## Task 1: PolicyAgentInstallerV1

`Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1` — new GUID, `Node20_1` + `Node24`, friendly name "Pipeline policy agent installer". Reuses `gpg-verifier.ts`, `hashicorp-gpg-key.ts`, and `http-client.ts` from `TerraformInstallerV1` (extract to a shared location or copy, matching however the repo currently shares installer code).

### Inputs

| Input | Type | Default | Notes |
| --- | --- | --- | --- |
| `policyAgent` | pickList | `opa` | `sentinel` \| `opa` |
| `version` | string | `latest` | Latest resolution per source (below) |
| `downloadSource` | pickList | `official` | `official` \| `registry` \| `mirror` |
| `registryUrl` | string | — | visibleRule `downloadSource = registry`; HTTPS enforced |
| `registryMirrorName` | string | `sentinel` / `opa` | The `{name}` segment in `/terraform/binaries/{name}/...`. The backend already supports `tool: sentinel` and `tool: opa` mirror configs (`terraform_mirror_sync.go: productNameForTool`) |
| `mirrorBaseUrl` | string | — | visibleRule `downloadSource = mirror` |
| `requireGpgSignature` | boolean | `true` | visibleRule `policyAgent = sentinel && downloadSource != registry` — Sentinel ships on releases.hashicorp.com signed with the HashiCorp releases key |
| `requireChecksum` | boolean | `true` | OPA GitHub releases publish per-asset `.sha256` files; mirrors may not |

### Download sources

| Agent | `official` | `latest` resolution |
| --- | --- | --- |
| Sentinel | `releases.hashicorp.com/sentinel/{v}/sentinel_{v}_{os}_{arch}.zip` + SHA256SUMS + `.sig` (HashiCorp GPG) | checkpoint API `v1/check/sentinel`; fallback: parse `releases.hashicorp.com/sentinel/index.json` |
| OPA | GitHub releases `openpolicyagent/opa`: static binaries `opa_{os}_{arch}[.exe]` + `.sha256` | GitHub `releases/latest` API (same pattern as the OpenTofu path in TerraformInstallerV1) |
| Either | `registry`: `/terraform/binaries/{name}/versions/...` (API-provided SHA256) · `mirror`: official path structure under a custom HTTPS base URL | registry `versions/latest` endpoint |

### Behavior & outputs

Tool-lib caching, prepend PATH, proxy support, HTTPS-only URL validation — all identical to TerraformInstallerV1. Output variables: `policyAgentLocation`, `policyAgentDownloadedFrom`.

## Task 2: TerraformPolicyCheckV1

`Tasks/TerraformPolicyCheck/TerraformPolicyCheckV1` — new GUID, friendly name "Pipeline Terraform policy check". Assumes the engine binary is on PATH (installed by PolicyAgentInstallerV1) with a `policyAgentPath` override input.

### Input data

The unit of evaluation is **Terraform plan JSON** (`terraform show -json <planfile>` output). The natural chain inside this extension:

```yaml
- task: TerraformTaskV5@5        # command: plan (writes plan file)
- task: TerraformTaskV5@5        # command: show, outputTo: file, outputFormat: json
- task: TerraformPolicyCheckV1@1
  inputs:
    inputFile: $(TerraformShow.showFilePath)
```

| Input | Type | Default | Notes |
| --- | --- | --- | --- |
| `engine` | pickList | `opa` | `sentinel` \| `opa` |
| `inputFile` | string | — | Path to plan JSON (typically `showFilePath` / `jsonPlanFilePath` from TerraformTaskV5). Also accepts state JSON for posture checks |
| `policySource` | pickList | `path` | `path` \| `gitUrl` |
| `policyPath` | filePath | — | visibleRule `policySource = path`; directory from multi-repo checkout |
| `policyRepoUrl` | string | — | visibleRule `policySource = gitUrl`; HTTPS git URL |
| `policyRepoRef` | string | `main` | Branch, tag, or commit SHA (SHA recommended for supply-chain pinning) |
| `policyRepoSubdir` | string | — | Subdirectory within the cloned repo |
| `policyRepoToken` | string (secret) | — | Optional PAT/bearer for private repos, injected via `http.extraheader` so it never lands in the clone URL or logs |

`gitUrl` mode performs a shallow clone (`--depth 1` for branch/tag; full fetch + checkout for SHA) into agent temp, cleaned up in `finally`.

### OPA engine

- Command: `opa exec --bundle <policyDir> --decision <decisionPath> <inputFile>` (or `opa eval` fallback if bundles are unsuitable).
- Inputs: `decisionPath` (default `terraform/deny`), `failMode` pickList:
  - `nonEmpty` (default) — fail when the decision result is a non-empty set/array (deny-rule convention)
  - `defined` — fail when the decision is defined/true
- Violation messages from the deny set are logged as `##vso[task.logissue type=error]` lines.

### Sentinel engine

- If the policy repo contains a `sentinel.hcl`, use it (input `sentinelConfigPath` to disambiguate); otherwise generate one enumerating `*.sentinel` policies.
- The plan JSON is wired in as a **static import** (Sentinel 0.19+): `import "static" "tfplan" { source = "<inputFile>" format = "json" }`. Import name configurable via `sentinelImportName` (default `tfplan`).
- **Documentation must be explicit:** policies are evaluated against the *raw* `terraform show -json` schema, not the TFC/TFE `tfplan/v2` mock schema. Policies written for TFC need adaptation.
- Run `sentinel apply` against the config. Enforcement-level handling:
  - `advisory` failure → `##vso[task.logissue type=warning]`, task still succeeds
  - `soft-mandatory` failure → fails unless input `overrideSoftMandatory: true`
  - `hard-mandatory` failure → always fails
- `-trace` enabled via `traceOutput` boolean for debugging.

### Results & outputs

- Output variables: `policyResult` (`passed` \| `failed`), `violationCount`, `resultsFilePath` (raw engine JSON output written to agent temp).
- `publishTestResults` boolean (default `true`): emit JUnit XML (one test case per policy/deny rule) and publish via the task-lib results-publish command, so policy outcomes appear in the pipeline **Tests** tab.

## Extension & repo integration

| File | Change |
| --- | --- |
| `azure-devops-extension.json` | Two new `files` entries + two new task contributions |
| `.github/workflows/unit-test.yml` | `Build and Test Policy Agent Installer V1`, `Build and Test Policy Check V1` jobs; add both to required status checks and the version-consistency check |
| `.github/dependabot.yml` | npm entries for both new task directories |
| `CLAUDE.md` | New task sections, repository structure, release-checklist `task.json` Minor-bump list |
| `overview.md`, `README.md`, `docs/yaml-examples.md`, `docs/troubleshooting.md` | New task docs + chaining examples (plan → show → policy check; installer matrix) |

Tests follow the established mock-runner pairs: installer (`sentinel`/`opa` × 3 sources × version resolution × verification toggles), policy check (`OpaPassTests/`, `OpaFailTests/`, `SentinelEnforcementTests/`, `GitSourceTests/`, `PublishResultsTests/`).

## Verification Spikes (resolve in Phase 1/3 before locking task.json)

- **S1 — Sentinel checkpoint:** confirm `v1/check/sentinel` exists; otherwise implement `index.json` parsing for `latest`.
- **S2 — Sentinel static imports:** confirm exact `sentinel.hcl` static-import syntax and `sentinel apply` exit codes (pass/fail/undefined) on the current Sentinel release.
- **S3 — OPA asset naming:** confirm current GitHub asset names per OS/arch (incl. windows `.exe`, darwin/linux arm64) and `.sha256` format.
- **S4 — Enforcement reporting:** confirm `sentinel apply` machine-readable/JSON output options for per-policy result parsing (vs parsing stdout text).

## Phases

```txt
1. PolicyAgentInstallerV1: sentinel + opa × official/registry/mirror (incl. S1, S3)
   → verify: L0 suite; manual install of both agents on Windows + Linux agents
2. TerraformPolicyCheckV1 with OPA engine, policySource=path
   → verify: L0 pass/fail suites; live pipeline: plan → show -json → opa deny policies
3. Sentinel engine: static import wiring, sentinel.hcl generation, enforcement levels (incl. S2, S4)
   → verify: L0 enforcement matrix (advisory/soft/hard × pass/fail/override)
4. gitUrl policy source + auth; JUnit publishing; output variables
   → verify: L0 git-source + publish suites; private-repo clone with PAT in live pipeline
5. Docs, yaml-examples, screenshots, CI wiring, release via release-please
   → verify: unit-test.yml green incl. new required checks; .vsix installs and tasks render correctly
```
