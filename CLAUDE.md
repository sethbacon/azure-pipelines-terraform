# Azure Pipelines Terraform Extension - Project Instructions

## Overview

This is a fork of the Microsoft DevLabs Azure DevOps extension that provides Terraform integration for Azure Pipelines. It enables running Terraform commands (init, validate, plan, apply, destroy, show, output, workspace, state, fmt, test, get, import, forceunlock, refresh, custom) against cloud providers (Azure, AWS, GCP, OCI) within Azure Pipelines build/release pipelines.

**Fork:** `https://github.com/sethbacon/azure-pipelines-terraform`
Local path: `C:\dev\gh\azure-pipelines-terraform`

**VS Marketplace publisher:** `sethbacon`
**Extension ID:** `pipeline-tasks-terraform`
**Extension name:** `Pipeline Tasks for Terraform`
**Full marketplace address:** `sethbacon.pipeline-tasks-terraform`

## Working Repository

All changes are made in the fork. The GitHub Actions CI workflow (`.github/workflows/unit-test.yml`) is the primary CI target.

## Branch Strategy

- `main` — production-ready; tagged releases only; never force-pushed
- `feature/<description>` — created from `main`; deleted after merge
- `fix/<description>` — bug fix branches from `main`

**Never commit directly to `main`.** Use PRs with conventional-commit titles.

## Commit Convention

Format: `type: short description` (50 chars max for the title)

Types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `ci`, `deps`, `security`, `perf`

Body line: `Closes #<issue-number>`

Example:

```txt
feat: add registry download strategy to terraform installer

Closes #12
```

**One merged commit announces exactly ONE breaking change.** This repo squashes
with `squash_merge_commit_message=COMMIT_MESSAGES`, so every commit body in a PR
is concatenated into one merge commit — and release-please keeps only the
**first** `BREAKING CHANGE:` footer, reading a `!` marker only from the header.
A second declaration anywhere in the PR ships with no changelog entry and no
notice (terraform-registry-backend v4.0.0 shipped two that way). Moving the
footers into separate commits does not help; the squash concatenates them back.
Open one PR per breaking change, or combine them into a single footer and write
each one up in the upgrade guide. A footer plus a `!` header in the *same*
commit is one declaration, not two. The `Breaking-change footers survive the
squash` job in `.github/workflows/pr-checks.yml` counts them across the PR;
`4cloudguru/shared-workflows' tests/test-breaking-change-footers.js` extracts that script from the workflow
and proves it still rejects, in the required `Workflow Security` job.

## Workflow Per Change

1. Create branch from `main`: `git checkout -b feature/<description> main`
2. Make changes.
3. Run local quality gate before pushing, from inside the changed task's directory (e.g. `Tasks/TerraformTask/TerraformTaskV5/`) — there is no root-level `compile`/`test` script; each task is an independent npm package:
   - `npm run compile` (TypeScript build, zero errors)
   - `npm test` (all tests pass)
4. Open PR to `main` with a conventional-commit title.
5. CI runs automatically: version consistency check → build + test (Ubuntu + Windows) → type-check tab → actionlint.
6. Squash-merge when CI passes and the PR is approved; the branch is deleted automatically.

## Release Process

**[CONTRIBUTING.md → Release process](CONTRIBUTING.md#release-process) is the single authoritative reference.** release-please opens a **Release PR** that bumps the extension version and changelog. Per-task `task.json` `Minor` bumps are applied automatically and triple-enforced (auto-bump workflow, PR merge gate, tag-time guard) — never hand-edit them, and never bump an already-bumped task again (no double-increment). Merging the Release PR pushes the `vX.Y.Z` tag, and `release.yml` then runs full CI, builds and signs the `.vsix`, and publishes it to the VS Marketplace via GitHub OIDC federated to Microsoft Entra.

The release is a **public, publicly-listed** Marketplace extension: `npm run package:release` overrides the base manifest with `configs/release.json` (`"public": true`, `galleryFlags: ["Public"]`). The `"public": false` in `azure-devops-extension.json` (and in `configs/dev.json` / `configs/test.json`) is only the dev-safe default so a dev/test package can never accidentally ship a public listing — it is not the distribution model.

The publish itself goes through `scripts/publish-marketplace.js`, which keeps the minted Entra token on tfx's stdin (never on argv, where it would be readable in `/proc/<pid>/cmdline`) and retries a transient upstream failure a bounded number of times — the sibling `azure-pipelines-packer` repo lost its v1.2.7 release to a single HTTP 503 at this step, leaving an orphaned draft release behind. A deterministic rejection is never retried. It runs as a step inside the `marketplace` environment job, so it neither changes nor bypasses that environment's gates.

The `marketplace` environment (Settings → Environments) must have (1) at least one required reviewer so every VS Marketplace publish gets human approval, and (2) a deployment branch/ref policy so a publish can only run from an approved branch or tag (e.g. `main` / `v*`) even after a reviewer approves. Both are verified automatically by the `verify-marketplace-environment-protection` job in `weekly-security.yml` — which fails the scheduled run (filing an issue) if either rule, or the environment itself, is missing or removed — and, fail-closed at publish time, by the matching guard step in `release.yml`.

## Publisher Registration

To publish to the VS Marketplace:

1. Navigate to: `https://marketplace.visualstudio.com/manage/createpublisher`
2. Sign in with a Microsoft account
3. Publisher ID: `sethbacon`
4. Accept the Marketplace Publisher Agreement
5. Automated publishing uses the GitHub OIDC → Entra federated credential (no PAT). A Marketplace PAT is only needed for manual CLI publishing of private dev builds (see `docs/setup/private-testing.md`).

## Extension Naming — HashiCorp Trademark

HashiCorp's trademark policy prohibits using "Terraform" as a standalone product name. Nominative fair use (accurately describing compatibility) is permitted. The name `"Pipeline Tasks for Terraform"` is compliant — it describes the extension's function without implying official HashiCorp affiliation.

**Attribution:** The `LICENSE` file retains the original Microsoft copyright notice. The README notes the fork origin.

## Repository Structure

```txt
azure-pipelines-terraform/
├── Tasks/
│   ├── TerraformInstaller/
│   │   └── TerraformInstallerV1/        # Terraform / OpenTofu installer
│   ├── TerraformProviderMirror/
│   │   └── TerraformProviderMirrorV1/   # Provider mirror configuration task
│   ├── TerraformTask/
│   │   └── TerraformTaskV5/             # Current development target
│   ├── PolicyAgentInstaller/
│   │   └── PolicyAgentInstallerV1/      # OPA / Sentinel installer
│   ├── TerraformPolicyCheck/
│   │   └── TerraformPolicyCheckV1/      # OPA / Sentinel policy evaluation
│   ├── TerraformDriftReport/
│   │   └── TerraformDriftReportV1/      # Plan-JSON drift summary + TSM callback
│   ├── TerraformModulePublish/
│   │   └── TerraformModulePublishV1/    # Module publish to HCP / private registry
│   ├── TerraformDocsInstaller/
│   │   └── TerraformDocsInstallerV1/    # terraform-docs installer
│   ├── TerraformDocs/
│   │   └── TerraformDocsV1/             # terraform-docs documentation generator
│   ├── Markdown2Html/
│   │   └── Markdown2HtmlV1/             # Markdown -> HTML converter (ServiceNow KB articles)
│   └── PublishKbArticle/
│       └── PublishKbArticleV1/          # Publish/update ServiceNow KB articles
├── src/
│   └── tab/                           # Terraform results tab UI (React + ADO Extension SDK)
│       ├── tabContent.tsx             # Tab component: Plan/Apply/State pivots, overview lists, raw ANSI fallback
│       ├── tabContent.css             # Tab styling
│       ├── digest-model.ts            # Safe parse/validate of a fetched digest attachment into typed objects
│       ├── digest-schema.ts           # Digest TypeScript shape — byte-identical copy of the task's src/results/digest-schema.ts
│       ├── caps.ts                    # Size/DoS caps — byte-identical copy of the task's src/results/caps.ts
│       ├── ansi-to-html.ts            # SGR-to-HTML converter used only by the raw fallback view
│       ├── components/                # Presentational components (SummaryHeader, ResourceList, ResourceDiff, ApplyTimeline, OutputsPanel, DiagnosticsPanel, OverviewList, StateInventory, RawView)
│       ├── index.html                 # Tab HTML shell
│       └── tsconfig.json              # Tab TypeScript config
├── configs/                           # Extension manifest configs
│   ├── dev.json                       # Dev publisher override
│   ├── release.json                   # Release publisher override (sethbacon)
│   └── self.json                      # Personal dev override (gitignored)
├── docs/
│   ├── design/
│   │   └── plan-apply-digest-spec.md # Frozen digest schema/caps contract (Phase 5)
│   ├── initiatives/
│   │   └── structured-plan-apply-tabs.md # Retained design/redaction narrative for the shipped tab (see Completed Initiatives below)
│   ├── setup/                        # WIF setup guides (aws/gcp/oci) + private-testing.md + servicenow-setup.md
│   ├── migration-from-ms-devlabs.md  # Step-by-step migration from the MS DevLabs extension
│   ├── release-checklist.md          # Manual release verification steps
│   ├── structured-results.md         # Walkthrough: enabling/reading the Terraform results tab
│   ├── troubleshooting.md            # Common issues: auth, backend config, installer, agents
│   └── yaml-examples.md              # YAML examples for every task/command, incl. cross-cloud
└── .github/workflows/                 # GitHub Actions CI/CD
    ├── unit-test.yml                  # CI: build + test on PR/push
    └── release.yml                    # Release: tag-triggered marketplace publish
```

**Always work in TerraformTaskV5.** TerraformInstallerV1 is the active installer task. TerraformProviderMirrorV1 is the provider mirror configuration task. Legacy task versions (V1-V4, InstallerV0) have been removed.

## Task Architecture (TerraformTaskV5)

### Source files: `Tasks/TerraformTask/TerraformTaskV5/src/`

| File                                   | Role                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                             | Entry point - reads `provider` and `command` inputs, delegates to `ParentCommandHandler`                                                                                                                                                                                                                                                                      |
| `parent-handler.ts`                    | Routes provider/backend name to the correct handler class                                                                                                                                                                                                                                                                                                     |
| `base-terraform-command-handler.ts`    | Abstract base with shared command implementations                                                                                                                                                                                                                                                                                                             |
| `terraform.ts`                         | `TerraformToolHandler` - locates terraform binary and builds `ToolRunner`                                                                                                                                                                                                                                                                                     |
| `terraform-commands.ts`                | Data classes: `TerraformBaseCommandInitializer`, `TerraformAuthorizationCommandInitializer`                                                                                                                                                                                                                                                                   |
| `azure-terraform-command-handler.ts`   | AzureRM-specific backend and provider auth (MSI, WorkloadIdentityFederation, ServicePrincipal)                                                                                                                                                                                                                                                                |
| `aws-terraform-command-handler.ts`     | AWS-specific backend and provider auth                                                                                                                                                                                                                                                                                                                        |
| `gcp-terraform-command-handler.ts`     | GCP-specific backend and provider auth                                                                                                                                                                                                                                                                                                                        |
| `oci-terraform-command-handler.ts`     | OCI-specific backend (HTTP backend via PAR URL) and provider auth                                                                                                                                                                                                                                                                                             |
| `temp-file-manager.ts`                 | Owns the command handler's temp-file lifecycle: the two tracking tiers (normal-completion vs cancellation-only, #650), scrub-then-unlink of each tracked path (#595), and the secure var file's scrub-before-delete (#662)                                                                                                                                    |
| `argument-builder.ts`                  | Turns task inputs into Terraform argv: the `commandOptions` tokenizer that mirrors task-lib's `_argStringToArray` (#875) and the readers built on it (`-out=`, `-json`, positional plan file), the multi-line input parsers (`-var-file`, `-target`, `-var`), and `ArgumentBuilder` for the input-reading flags (`-replace`, `-parallelism`, secure var file) |
| `command-executor.ts`                  | Runs a `ToolRunner` and turns the result into output or an error: the wall-clock deadline (#822), the bounded stdout/stderr capture that forces `silent: true` (#492, #613, #632), fmt/test's separate message capture (#826), and the loc-keyed failure formatter (#821)                                                                                     |
| `results-publisher.ts`                 | Turns a finished command's output into what a pipeline consumes: structured digest attachments (#881), `TF_OUT_*` variables behind the printable-ASCII guard, the `apply -json` console echo with `##vso` neutralization (#678), 0600 command-output files (#484), and the sensitive-output warn/fail checks (#488, #650, #802)                               |
| `secure-file-loader.ts`                | Downloads secure var files from ADO Secure Files library                                                                                                                                                                                                                                                                                                      |
| `generic-terraform-command-handler.ts` | `TerraformCommandHandlerGeneric` — generic backend (`backendType: generic`) wired via `-backend-config` file/args                                                                                                                                                                                                                                             |
| `hcp-terraform-command-handler.ts`     | `TerraformCommandHandlerHCP` — HCP Terraform / Terraform Cloud backend (sets `TF_TOKEN_app_terraform_io` from `backendHCPToken`)                                                                                                                                                                                                                              |
| `backend-detection.ts`                 | Maps a Terraform `backend.type` (from `.terraform/terraform.tfstate`) to the cloud whose credentials the backend needs — enables cross-cloud state-backend credential injection (bounded state-file read)                                                                                                                                                     |
| `temp-dir.ts`                          | Resolves the directory for ephemeral WIF credential/token files (prefers agent-purged `Agent.TempDirectory` over `os.tmpdir()`); shared by the AWS/GCP/OCI handlers                                                                                                                                                                                           |
| `credential-guards.ts`                 | Fail-closed credential guards: clears inherited identity-selecting env vars before a handler applies its own, and derives the per-run AWS role session name (`resolveRoleSessionName`) instead of a fixed constant. `readSecretEndpointDataParameter`/`maskSecretLines` (reads `ENDPOINT_DATA_*` service-connection parameters without the task-lib read path that logs the value) come from `@4cloudguru/pipeline-task-ado` rather than a local file (#1069)                                                                                                                                                                                   |
| `secure-var-file-masking.ts`           | Registers the values inside a downloaded secure var file as secrets, line-wise, before terraform can echo them                                                                                                                                                                                                                                                |

**`oci-token-exchange.ts` no longer lives here (#1074).** The OCI UPST exchange — the second hop of
the OCI WIF flow — moved to `@4cloudguru/pipeline-task-ado` (`exchangeOidcForUpst`,
`validateIdentityDomainUrl`, `OciTokenExchangeError`) when `azure-pipelines-packer` gained OCI WIF
and needed the same four Oracle realm suffixes, the same `idcs-` first-label check and the same
`redirect: 'manual'` refusal. It was promoted rather than copied deliberately:
`scripts/check-shared-modules.js` verifies a provenance header exists but cannot byte-compare
across repositories, so a second copy of a realm allowlist would have drifted invisibly. Change it
in the package, not here. `scripts/check-proxy-parity.js` holds the call site to a version floor
the way it already does for `generateIdToken`.

`Tests/OciTokenExchangeL0.ts` was deliberately **kept** and repointed at the package rather than
deleted with the implementation. The package ships its own tests, but these run from the consumer
side, so a behaviour reversal in a future package release fails at the version bump here instead of
in a pipeline — a type-only check would not catch it, since the signature is unchanged.

### Manifest (`task.json`) size & organization convention

`TerraformTaskV5/task.json` is by far the largest task manifest (~1,200 lines vs. <330 for every other task), because it declares several cloud provider/backend combinations plus the dynamic AzureRM/AWS/OCI pickers in one task. That size is expected, but the manifest gets no compiler/lint support the way `.ts` does, so keep it reviewable as it grows:

- Group every input under a `groupName` (e.g. `providerAzureRm`, `backendAWS`, `backendGCP`) and keep a provider's inputs contiguous with its group.
- Put dynamic pickList lookups in the `dataSourceBindings` block, keyed by the target input — do not inline lookup logic elsewhere.
- Prefer a `visibleRule` on an existing input over adding a new input when an input can simply be shown conditionally.

New inputs should extend an existing group rather than adding a parallel section, so the manifest grows proportionally to real capability rather than becoming an unreviewable flat list (#836).

### Structured plan/apply results (`src/results/`)

Builds the redacted JSON digests published to the **Terraform** tab (see `docs/design/plan-apply-digest-spec.md` for the frozen schema/redaction contract):

| File               | Role                                                                                                                                                                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `digest-schema.ts` | The `PlanDigest`/`ApplyDigest`/`StateDigest` TypeScript shape (schemaVersion 1) — byte-identical copy in `src/tab/`, gated by `scripts/check-shared-modules.js`                                                                                                                                |
| `caps.ts`          | Size/DoS caps (max resources, max attribute changes, byte ceilings, etc.) — byte-identical copy in `src/tab/`, same gate                                                                                                                                                                       |
| `redact.ts`        | The recursive redaction core: converts a raw value + its `*_sensitive`/`*_unknown` mask maps into a `RedactedValue`, fail-closed on mask/value shape mismatch                                                                                                                                  |
| `plan-digest.ts`   | Builds a `PlanDigest` from a parsed `terraform show -json <planfile>` object; also accepts an optional `mode: 'destroy'` (Phase 5) so a destroy plan is tagged `planMode: "destroy"` for the tab to label — same builder, same shape, no new type                                              |
| `apply-digest.ts`  | Builds an `ApplyDigest` from the `terraform apply -json` NDJSON event stream                                                                                                                                                                                                                   |
| `state-digest.ts`  | (Phase 5) Builds a `StateDigest` from a parsed `terraform show -json` of the **current state** — a point-in-time resource/data-source/output inventory (no change actions, no before/after, no unknown), redacted against each resource's own `sensitive_values` via the same `redact.ts` core |
| `secret-scrub.ts`  | Freeform-text scrub for apply diagnostics (known-secret string replacement + entropy/format heuristic) and attachment-name sanitization                                                                                                                                                        |

`redact.ts` and `state-digest.ts` have only one copy each (task-side); neither is duplicated into `src/tab/` — the task produces a digest, the tab only ever consumes an already-redacted one — so they are intentionally not in the `check-shared-modules.js` parity families. `digest-schema.ts`/`caps.ts` remain the byte-identical parity families; the Phase 5 `StateDigest` type and `MAX_STATE_RESOURCES`/`MAX_STATE_ATTRS_PER_RESOURCE` caps were added to those two existing files (no new family needed).

### Provider dispatch pattern

`ParentCommandHandler.execute(provider, command)` selects the handler via switch/case, then calls `handler[command]()` dynamically. For `init`, the `backendType` input selects the handler (backend/provider are decoupled). For all other commands, the `provider` input selects the handler.

To add a new command: implement it as a method on `BaseTerraformCommandHandler`.
To add a new provider: create a handler class implementing `handleBackend()` and `handleProvider()`, add a case in `parent-handler.ts`.

### Command implementations in `BaseTerraformCommandHandler`

- **`init`** - calls `handleBackend()` then runs `terraform init -backend-config=...`
- **`validate`** - runs `terraform validate` (no auth needed)
- **`plan`** - calls `handleProvider()`, runs with `-detailed-exitcode`, sets `changesPresent` output variable. When `publishPlanResults` is set, captures stdout and publishes as `terraform-plan-results` pipeline attachment (raw fallback view). When `publishPlanSummary` is set, adds `-out=<tempfile>`, runs `terraform show -json` on it, builds a redacted `PlanDigest` (`src/results/plan-digest.ts`), and publishes it as `terraform-plan-summary` for the Terraform tab's Plan pivot. The two are independent and can both be enabled.
- **`apply`** - calls `handleProvider()`, forces `-auto-approve` if not already present. When `publishApplyResults` is set, runs apply with `-json`, echoes each event's `@message` to the console (preserving the live log), builds a redacted `ApplyDigest` (`src/results/apply-digest.ts`, honoring `includeDiagnosticDetail`), and publishes it as `terraform-apply-summary` for the Apply pivot; exit-code/failure semantics are unchanged.
- **`destroy`** - calls `handleProvider()`, forces `-auto-approve` if not already present. When `publishPlanSummary` is set (Phase 5), adds `-out=<tempfile>` to the destroy, runs `terraform show -json` on it, and publishes the resulting `PlanDigest` (via `plan-digest.ts`'s `mode: 'destroy'`) as `terraform-plan-summary`, labeled "Destroy" by the tab — reuses the plan digest unchanged since a destroy plan is a plan whose changes are all deletes. Auto-approve and non-zero-exit failure semantics are unchanged.
- **`show`** - calls `handleProvider()`, supports `outputTo=console|file` and `outputFormat=json|default`. When `publishStateResults` is set (Phase 5) and this show has no positional plan-file argument in `commandOptions` (i.e. it is showing the CURRENT state, not a saved plan file — see `hasPositionalCommandArg()`), runs its own separate `terraform show -json` of the current state, builds a redacted `StateDigest` (`src/results/state-digest.ts`), and publishes it as `terraform-state-summary` for the tab's State pivot.
- **`output`** - calls `handleProvider()`, always uses `-json`, writes to file, sets `jsonOutputVariablesPath`
- **`custom`** - calls `handleProvider()`, runs arbitrary command from `customCommand` input
- **`workspace`** - runs `terraform workspace` with `workspaceSubCommand` (select, new, list, show, delete)
- **`state`** - runs `terraform state` with `stateSubCommand` (list, show, mv, rm, pull, push)
- **`fmt`** - runs `terraform fmt -check` for formatting validation
- **`test`** - runs `terraform test` with optional filter and verbose flags. Service connection is **optional**: omit for unit tests, provide for integration tests that need provider auth
- **`get`** - runs `terraform get` to download modules
- **`import`** - runs `terraform import` with `importAddress` and `importId` inputs
- **`forceUnlock`** - runs `terraform force-unlock` with `lockId` input
- **`refresh`** - calls `handleProvider()`, supports `varFile`, `targetResources`, `parallelism`, `secureVarsFile`, `terraformVariables`

### Azure auth schemes (AzureRM handler)

Three modes via service connection `authorizationScheme`:

1. `WorkloadIdentityFederation` (preferred) - OIDC token; sets `ARM_CLIENT_ID`, `ARM_USE_OIDC`, and either `ARM_OIDC_TOKEN` (id token generation) or, for token refresh, both `ARM_ADO_PIPELINE_SERVICE_CONNECTION_ID` (azurerm's primary variable) and `ARM_OIDC_AZURE_SERVICE_CONNECTION_ID` (AzAPI-compatibility fallback)
2. `ManagedServiceIdentity` - sets `ARM_USE_MSI=true`
3. `ServicePrincipal` - sets `ARM_CLIENT_ID` + `ARM_CLIENT_SECRET` (deprecated)

## TerraformInstaller Task (TerraformInstallerV1)

Source: `Tasks/TerraformInstaller/TerraformInstallerV1/src/terraform-installer.ts`

- Downloads Terraform from `https://releases.hashicorp.com/terraform/` for the requested version
- Supports `latest` (queries HashiCorp checkpoint API; fails closed with an actionable error — pin an explicit `version` instead — rather than falling back to a stale version if the checkpoint API is unreachable)
- Supports Windows, macOS, Linux on amd64, arm64, arm, 386
- Verifies GPG signature of SHA256SUMS using HashiCorp's embedded public key (`gpg-verifier.ts`)
- Sets `terraformLocation` pipeline variable after install
- Handles proxy configuration via `tasks.getHttpProxyConfiguration()`

## TerraformProviderMirror Task (TerraformProviderMirrorV1)

Source: `Tasks/TerraformProviderMirror/TerraformProviderMirrorV1/src/`

- Generates a `.terraformrc` CLI configuration file with a `provider_installation` block for network mirroring
- Sets `TF_CLI_CONFIG_FILE` pipeline variable so subsequent `terraform init` routes provider downloads through the mirror
- Supports include/exclude patterns for routing specific providers to the mirror vs direct registry
- Pure config generation — no network calls, no credentials needed
- Intended to run once per agent job, before `terraform init`

| File                      | Role                                                                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                | Entry point — reads inputs, validates URL, writes config                                                                                                                                                               |
| `config-generator.ts`     | Pure function generating HCL `provider_installation` block                                                                                                                                                             |

## TerraformDocsInstaller Task (TerraformDocsInstallerV1)

Source: `Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src/`. Installs **terraform-docs** from `official` (GitHub releases `terraform-docs/terraform-docs`), `registry` (terraform-registry-backend), or `mirror` sources. terraform-docs ships as a `.tar.gz` (Unix) / `.zip` (Windows) archive with a single `terraform-docs-v{version}.sha256sum` file and **no** detached GPG/cosign signature, so — like OPA — it is sha256-verified against the same GitHub release origin (HTTPS + GitHub's release infrastructure is the trust root). Reuses the `http-client.ts` adapter from TerraformInstallerV1 (byte-identical, enforced by `scripts/check-shared-modules.js`), whose HTTPS-pinned transport now comes from `@4cloudguru/pipeline-task-core`; it does not use `gpg-verifier.ts`/`hashicorp-gpg-key.ts`. `latest` resolves via the GitHub releases API. Output variables: `terraformDocsLocation`, `terraformDocsDownloadedFrom`.

## TerraformDocs Task (TerraformDocsV1)

Source: `Tasks/TerraformDocs/TerraformDocsV1/src/`. Runs terraform-docs to generate module documentation. `args-builder.ts` is a pure function mapping the `formatter` picklist (markdown table/document, json, yaml, toml, pretty, asciidoc table/document, tfvars hcl/json) plus the `outputFile`/`outputMode`/`configFile`/`sortBy`/`recursive`/`outputCheck` inputs to an ordered terraform-docs argument list; `index.ts` locates the binary via `tasks.which`, runs it with `ignoreReturnCode`, and fails on a non-zero exit (so `--output-check` can gate a pipeline on stale docs). No cloud auth. Output variable: `generatedFilePath`.

## PolicyAgentInstaller Task (PolicyAgentInstallerV1)

Source: `Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/`. Installs a policy engine — **Sentinel** (GPG-signed zip from releases.hashicorp.com) or **OPA** (raw, sha256-verified binary from GitHub releases `open-policy-agent/opa`) — from `official`, `registry` (terraform-registry-backend), or `mirror` sources. Reuses `gpg-verifier.ts`/`hashicorp-gpg-key.ts`/`http-client.ts` from TerraformInstallerV1 (the last of which is now a thin adapter over `@4cloudguru/pipeline-task-core`'s client). `latest` resolves via the checkpoint API (Sentinel) or the GitHub releases API (OPA). Output variables: `policyAgentLocation`, `policyAgentDownloadedFrom`. OPA only ships amd64/arm64.

## TerraformPolicyCheck Task (TerraformPolicyCheckV1)

Source: `Tasks/TerraformPolicyCheck/TerraformPolicyCheckV1/src/`. Evaluates policies against Terraform plan JSON (`terraform show -json` output). Engine dispatch in `index.ts`:

| File                 | Role                                                                                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`           | Orchestrator — resolves source, runs engine, sets outputs, publishes JUnit, cleans up temp dirs                                                                                                                                                                           |
| `opa-engine.ts`      | `opa exec --decision <path> --bundle <dir> <input>`; parses JSON result, gates on `failMode` (nonEmpty/defined)                                                                                                                                                           |
| `sentinel-engine.ts` | Generates `sentinel.hcl` (static import + policies), runs `sentinel apply`, maps exit code (0/1/2/3/9), applies enforcement level (advisory/soft/hard + override)                                                                                                         |
| `policy-source.ts`   | `path` (local dir) or `gitUrl` (HTTPS shallow clone / SHA checkout, token delivered as an `http.extraheader` Authorization header via per-invocation `GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` env vars, not argv, so it never appears in the child process's command line) |
| `results.ts`         | Raw output file + JUnit XML + `results.publish` logging command                                                                                                                                                                                                           |
| `exec-timeout.ts`    | Wall-clock ceiling for a local policy-engine subprocess — task-lib's `execAsync` bounds captured output size but not time, so a hung engine would otherwise run to the ADO job timeout                                                                                    |
| `output-cap.ts`      | Bounded stdout/stderr capture (`attachBoundedCapture`) so a runaway engine cannot grow one JS string until the agent OOMs (#632)                                                                                                                                          |
| `types.ts`           | Shared type definitions for the engines and the orchestrator                                                                                                                                                                                                              |

The standalone Sentinel CLI does NOT gate on `enforcement_level` (HCP-only) — the task applies it off the exit code. Policies see the raw `terraform show -json` schema (not the TFC `tfplan/v2` mock). Output variables: `policyResult`, `violationCount`, `resultsFilePath`.

## TerraformDriftReport Task (TerraformDriftReportV1)

Source: `Tasks/TerraformDriftReport/TerraformDriftReportV1/src/`. Parses a Terraform/OpenTofu plan JSON (`terraform show -json` output) into drift counts (create/update/delete) and a changed-resource summary, and optionally POSTs it to a Terraform State Manager (TSM) drift callback URL.

| File              | Role                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `index.ts`        | Entry point — computes drift counts, orchestrates the callback and SARIF report                                                                                          |
| `callback.ts`     | POSTs the drift summary to TSM; retries transport failures/5xx only, never after a received response (`callbackToken` is one-shot)                                       |
| `sarif.ts`        | Generates a SARIF 2.1.0 report of drift findings (opt-in)                                                                                                                |
| `https-client.ts` | Task-side wiring over `@4cloudguru/pipeline-task-core`'s raw-https transport: the agent proxy tunnel and the log-masker registration the package cannot read for itself; byte-identical copy in TerraformModulePublishV1 |
| `path-containment.ts` | Realpath-based `isWithinWorkingDirectory` guard on `moduleManifest`, symlink-aware; byte-identical copy of ChangelogV1's implementation (azure-pipelines-release-docs) |

Output variables: `driftDetected`, `addedCount`/`changedCount`/`destroyedCount`, `summaryFilePath` (opt-in `cleanupSummaryFile` removes it after use), `sarifFilePath`.

## TerraformModulePublish Task (TerraformModulePublishV1)

Source: `Tasks/TerraformModulePublish/TerraformModulePublishV1/src/`. Publishes a Terraform module version to HCP Terraform (private module registry) or a private/self-hosted Terraform registry.

| File                   | Role                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `index.ts`             | Entry point — reads inputs, dispatches to the chosen `registryType`                                     |
| `hcp-publisher.ts`     | Publishes via the HCP Terraform module registry API; polls ingest status                                |
| `private-publisher.ts` | Publishes to a private registry via its API (`apiKey` auth); auto-creates the module if absent          |
| `http.ts`              | Shared HTTP client with bounded retry (`retryHttp()` — the reference implementation other tasks mirror) |
| `https-client.ts`      | Task-side wiring over `@4cloudguru/pipeline-task-core`'s raw-https transport; byte-identical copy in TerraformDriftReportV1 |
| `types.ts`             | Shared type definitions for both publishers                                                             |

## Markdown2Html Task (Markdown2HtmlV1)

Source: `Tasks/Markdown2Html/Markdown2HtmlV1/src/`. Converts Markdown files to HTML for publishing as ServiceNow knowledge base articles — parses YAML front matter, renders via `markdown-it` with `highlight.js` syntax highlighting, and resolves `{% include %}`-style file includes.

| File                  | Role                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`            | Entry point — orchestrates the conversion pipeline                                                                                                                   |
| `converter.ts`        | Markdown → HTML conversion pipeline                                                                                                                                  |
| `frontmatter.ts`      | YAML front-matter parsing (`js-yaml`)                                                                                                                                |
| `includes.ts`         | Resolves `{% include %}`-style file includes                                                                                                                         |
| `highlight-theme.ts`  | Syntax-highlighting theme wiring for `highlight.js`                                                                                                                  |
| `document.ts`         | Document model / metadata                                                                                                                                            |
| `render.ts`           | HTML rendering + sanitization (uses `uri-scheme-guard.ts`)                                                                                                           |
| `deprecation-notice.ts` | The migration notice this task warns with on every run (#55) — byte-identical copy also in PublishKbArticleV1 |
| `html-sanitizer.ts`   | Shared HTML allowlist sanitizer (`sanitize-html`) — byte-identical copy also in PublishKbArticleV1, gated by `scripts/check-shared-modules.js`                       |
| `uri-scheme-guard.ts` | Shared XSS-prevention URI/scheme allowlist — byte-identical copy also in PublishKbArticleV1                                                                          |
| `html-sanitizer.ts`   | Shared `sanitize-html` allowlist — the final stored-XSS defense before HTML reaches ServiceNow's `text` field; byte-identical copy also in PublishKbArticleV1 (#820) |
| `path-containment.ts` | Realpath-based `isWithinWorkingDirectory` guard on front-matter `includes:` paths, symlink-aware; byte-identical copy in every task carrying one, gated by `scripts/check-shared-modules.js` |

Output variable: `htmlFilePath`.

## PublishKbArticle Task (PublishKbArticleV1)

Source: `Tasks/PublishKbArticle/PublishKbArticleV1/src/`. Publishes or updates a knowledge base article in ServiceNow — create, update, workflow-state transition, and image-attachment sync (content-hash-based idempotency).

| File                   | Role                                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`             | Entry point — orchestrates the create/update/workflow flow                                                                                                        |
| `auth.ts`              | OAuth client-credentials and Basic auth; masks secrets including derived/encoded forms                                                                            |
| `servicenow-client.ts` | ServiceNow Table API client — every `sysparm_query` interpolation goes through `assertQueryValueSafe()`                                                           |
| `servicenow-http.ts`   | ServiceNow layer over `@4cloudguru/pipeline-task-core`'s raw-https transport: query params, body encoding, non-2xx rejection, and bounded retry (transport + 5xx/429 only, never a received 4xx) |
| `attachments.ts`       | Image-attachment upload/list/sync                                                                                                                                 |
| `image-rewrite.ts`     | Rewrites local `<img src>` references to uploaded attachment URLs                                                                                                 |
| `html-validate.ts`     | Security gate for article HTML before publish; `force` only bypasses the content-loss heuristic, never the security checks                                        |
| `html-sanitizer.ts`    | Shared HTML allowlist sanitizer (`sanitize-html`) — byte-identical copy also in Markdown2HtmlV1, gated by `scripts/check-shared-modules.js`                       |
| `uri-scheme-guard.ts`  | Shared XSS-prevention URI/scheme allowlist — byte-identical copy also in Markdown2HtmlV1                                                                          |
| `manifest.ts`          | Legacy `KB<number>.json` manifest read/write                                                                                                                      |
| `dry-run.ts`           | `dryRun` mode — validates without calling ServiceNow                                                                                                              |
| `deprecation-notice.ts` | The migration notice this task warns with on every run (#55) — byte-identical copy also in Markdown2HtmlV1 |
| `html-sanitizer.ts`    | Shared `sanitize-html` allowlist — the final stored-XSS defense before HTML reaches ServiceNow's `text` field; byte-identical copy also in Markdown2HtmlV1 (#820) |
| `path-containment.ts`  | Realpath-based `isWithinWorkingDirectory` guard on local image srcs, symlink-aware; byte-identical copy in every task carrying one, gated by `scripts/check-shared-modules.js` |

Output variables: `kbArticleId`, `kbArticleNumber`, `kbWorkflowState`.

## task.json Schema Key Points

- `id` is the fork's own TerraformTask GUID (`981E87CD-B686-4A9E-B09E-B4AFDEDF126B`), deliberately distinct from the upstream MS DevLabs `FE504ACC-6115-40CB-89FF-191386B5E7BF` — that distinct GUID is what enables the documented side-by-side install. (The legacy `custom-terraform-release-task` contribution id in `azure-devops-extension.json` is a cosmetic carryover that points at the same TerraformTaskV5 folder.)
- `execution` targets `Node24` with a `Node20_1` fallback across all tasks — Node 24 is preferred, and the `Node20_1` handler (re-added 2026-07-05, #380) lets older on-prem/air-gapped agents that lack the Node 24 runner degrade gracefully instead of failing to find a handler. A task's `Minor` must be bumped for agents to re-fetch a handler change
- Inputs use `visibleRule` to conditionally show provider- and command-specific fields
- `dataSourceBindings` wire up picklist inputs to Azure REST API endpoints
- Output variables: `jsonOutputVariablesPath`, `changesPresent`, `destroyChangesPresent`, `showFilePath`, `customFilePath`

## Development Workflow

### First-time setup

```bash
# For testing TerraformTaskV5
cd Tasks/TerraformTask/TerraformTaskV5
npm install --include=dev
npm test

# For testing TerraformInstallerV1
cd Tasks/TerraformInstaller/TerraformInstallerV1
npm install --include=dev
npm run compile

# For full build + packaging (from repo root)
npm install --include=dev   # installs tfx-cli, webpack, etc.
npm run build:release       # compiles all tasks and bundles with webpack
npm run package:release     # produces .vsix for sethbacon publisher
```

### Test

```bash
cd Tasks/TerraformTask/TerraformTaskV5
npm test
# Runs: tsc -b tsconfig.json && tsc -p tsconfig.tests.json && mocha --timeout 10000 --require ts-node/register Tests/L0.ts
```

### Test structure

Tests are in `Tasks/TerraformTask/TerraformTaskV5/Tests/` and follow a mock-runner pattern. The mock-runner entry must be the task's **real** `src/index.ts` (`path.join(__dirname, '..', 'src', 'index.js')`), never a re-implementation of it in `Tests/`, and `src/index.js` must not be excluded from `.nycrc.json` — a declared `execution` target that no test loads and no metric measures is unverified in production (#189, sibling `azure-pipelines-packer` #189). `scripts/check-enforced-disciplines.js` fails CI if either property regresses for any task. Test files come in pairs:

- `<Name>.ts` - test data/mock setup (mock runner)
- `<Name>L0.ts` - the actual mocha test using `MockTestRunner`

Tests are organized by command x provider: `InitTests/`, `PlanTests/`, `ApplyTests/`, `DestroyTests/`, `MultipleProviderTests/`, `ValidateTests/`, `WorkspaceTests/`, `StateTests/`, `FmtTests/`, `GetTests/`, `TestCommandTests/`, `ShowTests/`, `OutputTests/`, `CustomTests/`, `ImportTests/`, `ForceUnlockTests/`, `RefreshTests/`. `Tests/results/` holds pure-logic tests for the `src/results/` digest builders/redaction (`RedactL0.ts`, `PlanDigestL0.ts`, `ApplyDigestL0.ts`, `StateDigestL0.ts` (Phase 5), `SecretScrubL0.ts`, `GoldenFixturesL0.ts`, `Phase5GoldenFixturesL0.ts`); `Tests/fixtures/` holds the scrubbed golden `show -json`/`apply -json` corpus and its `.expected.json` digests, including the Phase 5 `state-*.json`/`plan-destroy-marked.expected.json` fixtures.

### Personal dev publishing

1. Create `configs/self.json` with your publisher (see CONTRIBUTING.md)
2. `npm run build:release` from repo root
3. `npm run package:self` — generates a `.vsix` file
4. Upload to marketplace as a private extension

## Key Dependencies

| Package                                    | Purpose                                                                                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `azure-pipelines-task-lib`                 | ADO task SDK (inputs, variables, tool runners) — all 11 tasks                                                                                         |
| `azure-pipelines-tool-lib`                 | Tool download/cache — TerraformInstaller, PolicyAgentInstaller, TerraformDocsInstaller                                                                |
| `azure-devops-node-api`                    | Azure DevOps REST API client — TerraformTaskV5                                                                                                        |
| `azure-pipelines-tasks-artifacts-common`   | Shared artifact utilities — TerraformTaskV5                                                                                                           |
| `azure-pipelines-tasks-securefiles-common` | Secure file download — TerraformTaskV5 (`secureVarsFile` input)                                                                                       |
| `openpgp`                                  | GPG signature verification for installer downloads                                                                                                    |
| `undici`                                   | HTTP/proxy client — TerraformInstaller, PolicyAgentInstaller, TerraformDocsInstaller                                                                  |
| `sanitize-html`                            | Primary allowlist HTML sanitizer (final stored-XSS defense) — Markdown2Html                                                                           |
| `cheerio`                                  | Markdown2Html: defense-in-depth pre-filter parsing ahead of `sanitize-html`; PublishKbArticle: independent `html-validate.ts` content-inspection gate |
| `markdown-it`                              | Markdown parser — Markdown2Html                                                                                                                       |
| `highlight.js`                             | Syntax highlighting — Markdown2Html                                                                                                                   |
| `js-yaml`                                  | YAML front-matter parsing — Markdown2Html                                                                                                             |
| `@4cloudguru/terraform-drift-contract`     | Drift-summary contract types — TerraformDriftReport                                                                                                   |
| `typescript`                               | Build toolchain                                                                                                                                       |
| `mocha` + `ts-node`                        | Test framework                                                                                                                                        |

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the authoritative, per-task bundled-dependency breakdown.

## CI/CD

- `.github/workflows/unit-test.yml` — **Active CI.** Runs on push/PR to `main` and on `workflow_call` (reused by release). Jobs: `Check Version Consistency`, `Check Shared Module Parity`, `Build and Test V5`, `Build and Test Installer V1`, `Build and Test Provider Mirror V1`, `Build and Test Module Publish V1`, `Build and Test Policy Agent Installer V1`, `Build and Test Policy Check V1`, `Build and Test Drift Report V1`, `Build and Test terraform-docs Installer V1`, `Build and Test terraform-docs V1`, `Build and Test Markdown2Html V1`, `Build and Test Publish KB Article V1`, `Build and Test V5 Smoke`, `Build and Test Tab`, `Workflow Security`, `Workflow Security Record`.
- `.github/workflows/release-please.yml` — **Release automation.** Runs on push to `main`; uses a GitHub App token to open/update the Release PR (version bump + changelog).
- `.github/workflows/release.yml` — **Release pipeline.** Triggered by semver tags (`v*.*.*`) or manual dispatch. Verifies tag is on `main`, runs full CI via `workflow_call`, builds release bundle, packages `.vsix`, generates CycloneDX SBOMs, signs with cosign (keyless), creates draft GitHub Release, publishes to VS Marketplace (requires `marketplace` environment approval), then undrafts the release.
- `.github/workflows/codeql.yml` — **Code scanning.** CodeQL static analysis for TypeScript (GitHub Advanced Security).
- `.github/workflows/signature-replay.yml` — **Remediation gate.** Re-runs every recorded defect-class signature from the private `sethbacon/security-orchestration` ledger against the whole suite (six suite repos plus both ADO extensions) and fails the PR if a class recorded as fixed matches again, or if a new instance appears that no issue covers. Eight of the twelve signatures apply only to `ado-extension` kind — this repo and `azure-pipelines-packer` — so this is the half of the gate that can block a bad merge here. Needs the `SUITE_READ_APP_ID` variable and `SUITE_READ_APP_KEY` secret; every checkout except the private `security-orchestration` one runs on the job's own `GITHUB_TOKEN`. Not yet a required status check.

### Reconciling a shared module (`npm run sync:shared`)

Each ADO task is an independent npm package that ships its own compiled JS in place (`include: ["src/**/*"]`, then `webpack` copies `Tasks/**` minus the `.ts`), so a shared module physically has to exist inside every task that uses it — there is no runtime import path out of a task directory. The repo's answer is byte-identical copies plus a fail-closed parity gate rather than a workspace package.

To change one of those modules, edit the **canonical** copy (the first directory of its family, or the first file of its region family, in `scripts/check-shared-modules.js`) and then run:

```bash
npm run sync:shared   # node scripts/check-shared-modules.js --fix
npm run check:shared  # verify (this is what CI runs)
```

`--fix` rewrites every non-canonical copy from its canonical source — whole files for `FAMILIES`, and only the text between the `// #region shared:<name>` markers for `REGION_FAMILIES`, so a region's host file keeps its own surrounding code. A missing canonical or a broken marker stays a hard failure even under `--fix`: there is nothing trustworthy to sync from.

Syncing is deliberately **not** wired into the build. If it ran automatically before packaging, a genuine unintended divergence would be silently repaired instead of failing CI, which is exactly what the gate exists to prevent. Syncing is an authoring step; CI only ever verifies.

The `Check Shared Module Parity` job also runs `scripts/check-enforced-disciplines.js` — the signature for the "documented-but-unenforced discipline" class: every task's declared execution entry point must be loaded by a test and measured by its coverage config, every declared execution handler (`Node24`, `Node20_1`) must be exercised by a CI job for that task, the Minor-bump rule must be enforced in all three layers, and the Marketplace publish must retry transient failures and keep the token off argv. No new required status check was introduced — both it and its self-test are **steps inside existing required jobs**, so branch protection needs no change.

## Local Development Environment

Verified tooling snapshot (periodically re-verified rather than tracked to an exact date — re-check locally with `--version` if it's been a while since the table below was last touched):

| Tool               | Status                 | Version                                                                                                  |
| ------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------- |
| Node.js            | Installed              | v24.14.0 (Active LTS — matches CI target)                                                                |
| npm                | Installed              | v11.9.0                                                                                                  |
| TypeScript (`tsc`) | Not globally installed | Available as dev dep after `npm install`                                                                 |
| `tfx-cli`          | Not globally installed | Available as dev dep after `npm install` at root (pinned `0.23.2` at the repo root — see `package.json`) |
| GitHub CLI (`gh`)  | Installed              | v2.87.3                                                                                                  |
| Terraform          | Installed              | v1.14.6 at `/c/dev/terraform`                                                                            |

CI and local development both target Node 24 LTS (Active LTS, EOL April 2028). Node 20 is EOL as of April 2026.

**Node 20 is load-only, not a behavioral gate (#720):** every task ships a `Node20_1` fallback
handler (see above), and each task's CI leg has a "Set up Node 20 for Node20_1 handler smoke
test" step that runs the already-compiled `src/index.js` under Node 20 with no ADO inputs
supplied — this proves the compiled module graph parses and loads under Node 20 (a real,
useful check: a Node-20-incompatible dependency or syntax construct would fail it), but the
task's own try/catch converts the resulting "input required" error into a caught failure
before any real command, credential, or verification logic executes. The full mocha/L0
assertion suite only ever runs under Node 24 — **Node 24 is the sole behavioral gate**;
Node 20 is deliberately load-only. This is an intentional scope decision (not an oversight):
running the full test suite twice per task would roughly double CI time for every task, and
Node 20 is already EOL, so the fallback handler exists purely for agents that haven't yet
upgraded their runner, not as a second fully-verified execution path.

## Supported Providers

| Provider  | Handler class                    | Auth method                                                                                   |
| --------- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| `azurerm` | `TerraformCommandHandlerAzureRM` | Workload Identity Federation / MSI / Service Principal                                        |
| `aws`     | `TerraformCommandHandlerAWS`     | AWS service connection credentials                                                            |
| `gcp`     | `TerraformCommandHandlerGCP`     | GCP service connection credentials                                                            |
| `oci`     | `TerraformCommandHandlerOCI`     | OCI private key + TF_VAR_ env vars, or Workload Identity Federation; HTTP backend via PAR URL |

## Important Notes

- The OCI backend does NOT support `-backend-config` CLI flags; it generates a `config-<uuid>.tf` file at runtime
- `plan` uses `-detailed-exitcode`: exit code 2 means changes present (not an error), sets `changesPresent=true`
- `apply` and `destroy` always inject `-auto-approve`
- `warnIfMultipleProviders()` runs `terraform providers` and warns if multiple cloud providers are detected (non-fatal)
- Credential env vars are cleared via `EnvironmentVariableHelper.clearTrackedVariables()` in the `finally` block after every command
- Installer verifies GPG signature of SHA256SUMS before trusting checksums for HashiCorp downloads
- Client secret (ServicePrincipal) auth is deprecated in V5 and will be removed in a future version
- `taint`/`untaint` are NOT supported (removed in Terraform 1.0); use the `-replace` flag on `plan`/`apply` instead
- The **Terraform tab** (`terraform-plan-tab` contribution, displayed as "Terraform") is a build-results-tab extension contribution with Plan/Apply/State pivots (State added Phase 5; no manifest change was needed — it is a pivot inside the same existing contribution). It reads four attachment types: the legacy `terraform-plan-results` (raw ANSI, compatible with jason-johnson/azure-pipelines-tasks-terraform for migration) plus the structured `terraform-plan-summary`/`terraform-apply-summary`/`terraform-state-summary` (redacted structured JSON digests, schemaVersion 1). A destroy plan is published as an ordinary `terraform-plan-summary` (`PlanDigest.planMode === "destroy"`) and rendered in the Plan pivot with a "Destroy" badge — there is no separate destroy attachment type or pivot. The tab UI is in `src/tab/` and bundled via webpack; it only fetches attachments for the current build (same-run only — no cross-run plan↔apply/state correlation).

## Repository Security Hardening (applied 2026-04-09)

### Branch Protection

**`main` branch:**

- Required status checks (strict — branch must be up-to-date): the complete `unit-test.yml` matrix (29 contexts) — `Check Version Consistency`, `Check Shared Module Parity`, every `Build and Test *` job on both `ubuntu-latest` and `windows-2025` (V5, Installer V1, Provider Mirror V1, Module Publish V1, Policy Agent Installer V1, Policy Check V1, Drift Report V1, terraform-docs Installer V1, terraform-docs V1, Markdown2Html V1, Publish KB Article V1), `Build and Test V5 Smoke`, `Build and Test Tab`, `Workflow Security`, `Workflow Security Record`, and `Release PR Minor Bumps` (the pr-checks.yml merge gate — a fast no-op pass on non-release PRs, and the layer-2 backstop that keeps an un-bumped Release PR from merging if the auto-bump workflow is ever broken). Pinned to the GitHub Actions app (`app_id` 15368). Add both matrix legs of any new task's job here when introducing a task.
- Required pull request reviews: 1 approving review, dismiss stale reviews, require code owner review
- Enforce admins: no (admin/owner can bypass review requirements as sole maintainer)
- Required linear history: yes (squash/rebase only, no merge commits)
- Required conversation resolution: yes
- Force pushes: blocked
- Branch deletion: blocked

These settings are documented here in prose, so they are re-verified automatically, not just written down: the `verify-branch-protection` job in `weekly-security.yml` reads `main`'s live branch protection via the GitHub API (needs a token scoped with `administration:read`, minted from the `RELEASE_DISPATCH_APP` installation) and fails the scheduled run (filing an issue) if the required-status-checks strictness, review count/dismiss-stale/code-owner settings, enforce-admins, linear-history, conversation-resolution, or force-push/deletion rules drift from what is written above. It deliberately does not diff the exact list of 29 required-status-check contexts — that list changes with ordinary task additions — only the structural settings.

### Merge Strategy

- **Squash merge only** — merge commits and rebase merges are disabled
- **Delete branch on merge** — enabled; feature/fix branches are cleaned up automatically
- **Allow update branch** — enabled; PRs can pull in base branch changes via GitHub UI
- **Web commit signoff required** — enabled; all web-based commits require DCO signoff

### Dependency Management

- **Dependabot vulnerability alerts** — enabled
- **Dependabot automated security fixes** — enabled
- **Dependabot version updates** — configured via `.github/dependabot.yml` for:
  - GitHub Actions (weekly)
  - npm: all 11 task directories + root (weekly)

### Code Ownership

- **CODEOWNERS** file at `.github/CODEOWNERS` — `@sethbacon` owns all files; `.github/`, `configs/`, and `azure-devops-extension.json` require explicit owner review

### Security Features (GitHub)

- Code scanning: enabled (CodeQL for TypeScript)
- Secret scanning: enabled
- Secret scanning push protection: enabled
- `npm audit --omit=dev --audit-level=high` in CI
- All GitHub Actions pinned to full commit SHAs

### Repository Topics

`terraform`, `azure-devops`, `azure-pipelines`, `infrastructure-as-code`, `azure-devops-extension`, `devops`

### Accepted Risk Register

- **Admin bypass of required review, sole CODEOWNERS reviewer (audit #499):** `Enforce admins: no` lets the sole maintainer (`@sethbacon`) push to `main` or merge without satisfying the required-review/required-status-check rules, and CODEOWNERS names that same single account for every path (including `.github/`), so there is structurally no independent second reviewer even when the rule is respected. **Accepted** for a solo-maintainer project: enabling `enforce_admins` today would deadlock every PR that requires code-owner review, since no other codeowner could ever approve it. Revisit once a second maintainer/codeowner exists — see the second-maintainer item below (audit #518).
- **Sole maintainer bus factor (audit #518):** the entire task/provider surface (11 tasks, GPG/cosign trust roots, WIF for 4 clouds, a ServiceNow integration) is maintained by one person — a real availability risk for timely key rotation, incident response, and CVE triage as the surface keeps growing. Recruiting at least a limited-scope second reviewer (e.g., security-only CODEOWNERS rights) remains an **open recommendation**, tracked below under "Remaining Recommendations"; not yet actioned.

### Remaining Recommendations (not yet applied)

- **Enable secret scanning non-provider patterns and validity checks** for broader secret detection
- **Add a second collaborator/maintainer** to reduce bus factor (currently sole maintainer: @sethbacon)
- **Consider adding a tag protection rule** to prevent deletion of release tags (`v*.*.*`)

## Completed Initiatives

All six roadmap initiatives are complete and shipped:

- Initiative 1: Flexible Terraform Installer
- Initiative 2: Complete CLI Coverage
- Initiative 3: Workload Identity Federation for Non-AzureRM
- Initiative 4: Workload Identity Federation for OCI
- Initiative 5: Policy Evaluation (OPA / Sentinel)
- Initiative 6: Drift Report Task

Most detailed planning documents were removed once their initiative shipped; see [CHANGELOG.md](CHANGELOG.md) for the release history. `docs/initiatives/structured-plan-apply-tabs.md` is retained for reference (it is the authoritative design source cited by `docs/design/plan-apply-digest-spec.md`, which normatively fixes only the frozen digest schema/caps and points back to the initiatives doc for the fuller design/redaction-algorithm narrative) — it is not dead/stale despite the shipped feature.
