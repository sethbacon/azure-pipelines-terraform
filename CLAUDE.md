# Azure Pipelines Terraform Extension - Project Instructions

## Overview

This is a fork of the Microsoft DevLabs Azure DevOps extension that provides Terraform integration for Azure Pipelines. It enables running Terraform commands (init, validate, plan, apply, destroy, show, output, custom, workspace, state, fmt, test, get) against cloud providers (Azure, AWS, GCP, OCI) within Azure Pipelines build/release pipelines.

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

## Workflow Per Change

1. Create branch from `main`: `git checkout -b feature/<description> main`
2. Make changes.
3. Run local quality gate before pushing:
   - `npm run compile` (TypeScript build, zero errors)
   - `npm test` (all tests pass)
4. Open PR to `main` with a conventional-commit title.
5. CI runs automatically: version consistency check → build + test (Ubuntu + Windows) → type-check tab → actionlint.
6. Squash-merge when CI passes and the PR is approved; the branch is deleted automatically.

## Release Process

Releases are fully automated via [release-please](https://github.com/googleapis/release-please):

1. Merge conventional-commit PRs to `main` — release-please accumulates them.
2. release-please opens a **Release PR** that bumps `azure-devops-extension.json` (`version`) and updates `CHANGELOG.md`.
3. Before merging the Release PR, manually bump the `Minor` field in `task.json` for every task whose code changed since the last release. ADO agents cache tasks by `Major.Minor` and will not pick up new code until `Minor` increments.

   Files to update:
   - `Tasks/TerraformTask/TerraformTaskV5/task.json` — if TerraformTaskV5 changed
   - `Tasks/TerraformInstaller/TerraformInstallerV1/task.json` — if TerraformInstallerV1 changed
   - `Tasks/TerraformProviderMirror/TerraformProviderMirrorV1/task.json` — if TerraformProviderMirrorV1 changed
   - `Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/task.json` — if PolicyAgentInstallerV1 changed
   - `Tasks/TerraformPolicyCheck/TerraformPolicyCheckV1/task.json` — if TerraformPolicyCheckV1 changed
   - `Tasks/TerraformDriftReport/TerraformDriftReportV1/task.json` — if TerraformDriftReportV1 changed
   - `Tasks/TerraformModulePublish/TerraformModulePublishV1/task.json` — if TerraformModulePublishV1 changed

   Increment `Minor` by 1, leave `Patch` at 0.

   **Verify before bumping:** when a change must reach agents immediately (e.g. dropping a Node execution handler), the `Minor` may be bumped in the feature PR instead. If a task's `Minor` was already incremented in a merged feature PR since the last release, do **not** bump it again here — compare against the last release tag first to avoid a double-increment.

4. Merge the Release PR. release-please creates a draft GitHub Release and pushes the `vX.Y.Z` tag.
5. The `release.yml` workflow fires on the tag:
   - Verifies the tag is reachable from `main`
   - Verifies `azure-devops-extension.json` version matches the tag
   - Runs full CI
   - Builds release bundle + packages `.vsix`
   - Generates CycloneDX SBOMs + cosign signature
   - Creates draft GitHub Release with assets
   - **Publishes to VS Marketplace** (requires `marketplace` environment approval)
   - Undrafts the GitHub Release

**Required secrets/variables:**

| Name                       | Type     | Purpose                                                                            |
| -------------------------- | -------- | --------------------------------------------------------------------------------- |
| `AZDO_PUBLISH_CLIENT_ID`   | Variable | Client ID of the Entra app federated to GitHub for the Marketplace publish login  |
| `AZDO_PUBLISH_TENANT_ID`   | Variable | Entra tenant ID for the publish login                                             |
| `RELEASE_DISPATCH_APP_ID`  | Variable | GitHub App client ID for release-please                                           |
| `RELEASE_DISPATCH_APP_KEY` | Secret   | GitHub App private key for release-please                                          |

As of PR #218, `release.yml` publishes via **GitHub OIDC federated to Microsoft Entra** — there is no stored `TFX_PAT`. The publish job (under the `marketplace` environment, `id-token: write`) signs in with `azure/login` using the two `AZDO_PUBLISH_*` variables, exchanges the OIDC token for a short-lived Entra access token, and passes it to `tfx extension publish`. The Entra app needs a federated credential with subject `repo:sethbacon/azure-pipelines-terraform:environment:marketplace`.

The `marketplace` environment (Settings → Environments) must have at least one required reviewer so every VS Marketplace publish gets human approval.

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
│   └── TerraformModulePublish/
│       └── TerraformModulePublishV1/    # Module publish to HCP / private registry
├── src/
│   └── tab/                           # Terraform Plan tab UI (React + ADO Extension SDK)
│       ├── tabContent.tsx             # Tab component with ANSI rendering
│       ├── tabContent.css             # Tab styling
│       ├── index.html                 # Tab HTML shell
│       └── tsconfig.json              # Tab TypeScript config
├── configs/                           # Extension manifest configs
│   ├── dev.json                       # Dev publisher override
│   ├── release.json                   # Release publisher override (sethbacon)
│   └── self.json                      # Personal dev override (gitignored)
├── docs/
│   ├── initiatives/                   # Initiative plans
│   └── setup/                        # Setup guides (WIF, etc.)
└── .github/workflows/                 # GitHub Actions CI/CD
    ├── unit-test.yml                  # CI: build + test on PR/push
    └── release.yml                    # Release: tag-triggered marketplace publish
```

**Always work in TerraformTaskV5.** TerraformInstallerV1 is the active installer task. TerraformProviderMirrorV1 is the provider mirror configuration task. Legacy task versions (V1-V4, InstallerV0) have been removed.

## Task Architecture (TerraformTaskV5)

### Source files: `Tasks/TerraformTask/TerraformTaskV5/src/`

| File                                 | Role                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `index.ts`                           | Entry point - reads `provider` and `command` inputs, delegates to `ParentCommandHandler`       |
| `parent-handler.ts`                  | Routes provider/backend name to the correct handler class                                      |
| `base-terraform-command-handler.ts`  | Abstract base with shared command implementations                                              |
| `terraform.ts`                       | `TerraformToolHandler` - locates terraform binary and builds `ToolRunner`                      |
| `terraform-commands.ts`              | Data classes: `TerraformBaseCommandInitializer`, `TerraformAuthorizationCommandInitializer`    |
| `azure-terraform-command-handler.ts` | AzureRM-specific backend and provider auth (MSI, WorkloadIdentityFederation, ServicePrincipal) |
| `aws-terraform-command-handler.ts`   | AWS-specific backend and provider auth                                                         |
| `gcp-terraform-command-handler.ts`   | GCP-specific backend and provider auth                                                         |
| `oci-terraform-command-handler.ts`   | OCI-specific backend (HTTP backend via PAR URL) and provider auth                              |
| `environment-variables.ts`           | Helper for setting environment variables with tracking and cleanup                             |
| `secure-file-loader.ts`              | Downloads secure var files from ADO Secure Files library                                       |
| `id-token-generator.ts`              | Generates OIDC ID tokens for Workload Identity Federation fallback                             |

### Provider dispatch pattern

`ParentCommandHandler.execute(provider, command)` selects the handler via switch/case, then calls `handler[command]()` dynamically. For `init`, the `backendType` input selects the handler (backend/provider are decoupled). For all other commands, the `provider` input selects the handler.

To add a new command: implement it as a method on `BaseTerraformCommandHandler`.
To add a new provider: create a handler class implementing `handleBackend()` and `handleProvider()`, add a case in `parent-handler.ts`.

### Command implementations in `BaseTerraformCommandHandler`

- **`init`** - calls `handleBackend()` then runs `terraform init -backend-config=...`
- **`validate`** - runs `terraform validate` (no auth needed)
- **`plan`** - calls `handleProvider()`, runs with `-detailed-exitcode`, sets `changesPresent` output variable. When `publishPlanResults` is set, captures stdout and publishes as `terraform-plan-results` pipeline attachment for the Terraform Plan tab.
- **`apply`** - calls `handleProvider()`, forces `-auto-approve` if not already present
- **`destroy`** - calls `handleProvider()`, forces `-auto-approve` if not already present
- **`show`** - calls `handleProvider()`, supports `outputTo=console|file` and `outputFormat=json|default`
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

1. `WorkloadIdentityFederation` (preferred) - OIDC token; sets `ARM_CLIENT_ID`, `ARM_USE_OIDC`, and either `ARM_OIDC_TOKEN` (id token generation) or `ARM_OIDC_AZURE_SERVICE_CONNECTION_ID` (token refresh)
2. `ManagedServiceIdentity` - sets `ARM_USE_MSI=true`
3. `ServicePrincipal` - sets `ARM_CLIENT_ID` + `ARM_CLIENT_SECRET` (deprecated)

## TerraformInstaller Task (TerraformInstallerV1)

Source: `Tasks/TerraformInstaller/TerraformInstallerV1/src/terraform-installer.ts`

- Downloads Terraform from `https://releases.hashicorp.com/terraform/` for the requested version
- Supports `latest` (queries HashiCorp checkpoint API, falls back to `1.14.8`)
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

| File                  | Role                                                       |
| --------------------- | ---------------------------------------------------------- |
| `index.ts`            | Entry point — reads inputs, validates URL, writes config   |
| `config-generator.ts` | Pure function generating HCL `provider_installation` block |

## PolicyAgentInstaller Task (PolicyAgentInstallerV1)

Source: `Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/`. Installs a policy engine — **Sentinel** (GPG-signed zip from releases.hashicorp.com) or **OPA** (raw, sha256-verified binary from GitHub releases `open-policy-agent/opa`) — from `official`, `registry` (terraform-registry-backend), or `mirror` sources. Reuses `gpg-verifier.ts`/`hashicorp-gpg-key.ts`/`http-client.ts` from TerraformInstallerV1. `latest` resolves via the checkpoint API (Sentinel) or the GitHub releases API (OPA). Output variables: `policyAgentLocation`, `policyAgentDownloadedFrom`. OPA only ships amd64/arm64.

## TerraformPolicyCheck Task (TerraformPolicyCheckV1)

Source: `Tasks/TerraformPolicyCheck/TerraformPolicyCheckV1/src/`. Evaluates policies against Terraform plan JSON (`terraform show -json` output). Engine dispatch in `index.ts`:

| File | Role |
| --- | --- |
| `index.ts` | Orchestrator — resolves source, runs engine, sets outputs, publishes JUnit, cleans up temp dirs |
| `opa-engine.ts` | `opa exec --decision <path> --bundle <dir> <input>`; parses JSON result, gates on `failMode` (nonEmpty/defined) |
| `sentinel-engine.ts` | Generates `sentinel.hcl` (static import + policies), runs `sentinel apply`, maps exit code (0/1/2/3/9), applies enforcement level (advisory/soft/hard + override) |
| `policy-source.ts` | `path` (local dir) or `gitUrl` (HTTPS shallow clone / SHA checkout, token via `http.extraheader`) |
| `results.ts` | Raw output file + JUnit XML + `results.publish` logging command |

The standalone Sentinel CLI does NOT gate on `enforcement_level` (HCP-only) — the task applies it off the exit code. Policies see the raw `terraform show -json` schema (not the TFC `tfplan/v2` mock). Output variables: `policyResult`, `violationCount`, `resultsFilePath`. See [Initiative 5](docs/initiatives/initiative-5-policy-evaluation.md).

## task.json Schema Key Points

- `id` is shared across all versions of TerraformTask (`FE504ACC-6115-40CB-89FF-191386B5E7BF`)
- `execution` targets `Node24` only across all tasks — Node 24 is the floor. The legacy `Node20_1` handler was dropped on 2026-06-21 (Node 20 reached EOL April 2026), so a task's `Minor` must be bumped for agents to re-fetch a handler change
- Inputs use `visibleRule` to conditionally show provider- and command-specific fields
- `dataSourceBindings` wire up picklist inputs to Azure REST API endpoints
- Output variables: `jsonPlanFilePath`, `jsonOutputVariablesPath`, `changesPresent`, `showFilePath`, `customFilePath`

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
npm install --include=dev   # installs tfx-cli, webpack, glob-exec, etc.
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

Tests are in `Tasks/TerraformTask/TerraformTaskV5/Tests/` and follow a mock-runner pattern. Test files come in pairs:

- `<Name>.ts` - test data/mock setup (mock runner)
- `<Name>L0.ts` - the actual mocha test using `MockTestRunner`

Tests are organized by command x provider: `InitTests/`, `PlanTests/`, `ApplyTests/`, `DestroyTests/`, `MultipleProviderTests/`, `ValidateTests/`, `WorkspaceTests/`, `StateTests/`, `FmtTests/`, `GetTests/`, `TestCommandTests/`, `ShowTests/`, `OutputTests/`, `CustomTests/`, `ImportTests/`, `ForceUnlockTests/`, `RefreshTests/`.

### Personal dev publishing

1. Create `configs/self.json` with your publisher (see CONTRIBUTING.md)
2. `npm run build:release` from repo root
3. `npm run package:self` — generates a `.vsix` file
4. Upload to marketplace as a private extension

## Key Dependencies

| Package                                  | Purpose                                            |
| ---------------------------------------- | -------------------------------------------------- |
| `azure-pipelines-task-lib`               | ADO task SDK (inputs, variables, tool runners)     |
| `azure-pipelines-tool-lib`               | Tool download/cache (used by installer)            |
| `azure-devops-node-api`                  | Azure DevOps REST API client                       |
| `azure-pipelines-tasks-artifacts-common` | Shared artifact utilities                          |
| `typescript`                             | Build toolchain                                    |
| `mocha` + `ts-node`                      | Test framework                                     |
| `openpgp`                                | GPG signature verification for installer downloads |

## CI/CD

- `.github/workflows/unit-test.yml` — **Active CI.** Runs on push/PR to `main` and on `workflow_call` (reused by release). Jobs: `Check Version Consistency`, `Build and Test V5`, `Build and Test Installer V1`, `Build and Test Provider Mirror V1`, `Build and Test Policy Agent Installer V1`, `Build and Test Policy Check V1`, `Build and Test Tab`, `Lint GitHub Actions`.
- `.github/workflows/release-please.yml` — **Release automation.** Runs on push to `main`; uses a GitHub App token to open/update the Release PR (version bump + changelog).
- `.github/workflows/release.yml` — **Release pipeline.** Triggered by semver tags (`v*.*.*`) or manual dispatch. Verifies tag is on `main`, runs full CI via `workflow_call`, builds release bundle, packages `.vsix`, generates CycloneDX SBOMs, signs with cosign (keyless), creates draft GitHub Release, publishes to VS Marketplace (requires `marketplace` environment approval), then undrafts the release.
- `.github/workflows/codeql.yml` — **Code scanning.** CodeQL static analysis for TypeScript (GitHub Advanced Security).

## Local Development Environment

Verified tooling (as of May 2026):

| Tool               | Status                 | Version                                          |
| ------------------ | ---------------------- | ------------------------------------------------ |
| Node.js            | Installed              | v24.14.0 (Active LTS — matches CI target)        |
| npm                | Installed              | v11.9.0                                          |
| TypeScript (`tsc`) | Not globally installed | Available as dev dep after `npm install`         |
| `tfx-cli`          | Not globally installed | Available as dev dep after `npm install` at root |
| GitHub CLI (`gh`)  | Installed              | v2.87.3                                          |
| Terraform          | Installed              | v1.14.6 at `/c/dev/terraform`                    |

CI and local development both target Node 24 LTS (Active LTS, EOL April 2028). Node 20 is EOL as of April 2026.

## Supported Providers

| Provider  | Handler class                    | Auth method                                                  |
| --------- | -------------------------------- | ------------------------------------------------------------ |
| `azurerm` | `TerraformCommandHandlerAzureRM` | Workload Identity Federation / MSI / Service Principal       |
| `aws`     | `TerraformCommandHandlerAWS`     | AWS service connection credentials                           |
| `gcp`     | `TerraformCommandHandlerGCP`     | GCP service connection credentials                           |
| `oci`     | `TerraformCommandHandlerOCI`     | OCI private key + TF_VAR_ env vars; HTTP backend via PAR URL |

## Important Notes

- The OCI backend does NOT support `-backend-config` CLI flags; it generates a `config-<uuid>.tf` file at runtime
- `plan` uses `-detailed-exitcode`: exit code 2 means changes present (not an error), sets `changesPresent=true`
- `apply` and `destroy` always inject `-auto-approve`
- `warnIfMultipleProviders()` runs `terraform providers` and warns if multiple cloud providers are detected (non-fatal)
- Credential env vars are cleared via `EnvironmentVariableHelper.clearTrackedVariables()` in the `finally` block after every command
- Installer verifies GPG signature of SHA256SUMS before trusting checksums for HashiCorp downloads
- Client secret (ServicePrincipal) auth is deprecated in V5 and will be removed in a future version
- `taint`/`untaint` are NOT supported (removed in Terraform 1.0); use the `-replace` flag on `plan`/`apply` instead
- The **Terraform Plan tab** is a build-results-tab extension contribution that reads `terraform-plan-results` pipeline attachments. The tab UI is in `src/tab/` and bundled via webpack. The attachment type and naming convention is compatible with jason-johnson/azure-pipelines-tasks-terraform for migration.

## Repository Security Hardening (applied 2026-04-09)

### Branch Protection

**`main` branch:**

- Required status checks (strict — branch must be up-to-date): `Check Version Consistency`, `Build and Test V5`, `Build and Test Installer V1`, `Build and Test Provider Mirror V1`
- Required pull request reviews: 1 approving review, dismiss stale reviews, require code owner review
- Enforce admins: no (admin/owner can bypass review requirements as sole maintainer)
- Required linear history: yes (squash/rebase only, no merge commits)
- Required conversation resolution: yes
- Force pushes: blocked
- Branch deletion: blocked

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
  - npm: TerraformTaskV5, TerraformInstallerV1, TerraformProviderMirrorV1, root (weekly)

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

### Remaining Recommendations (not yet applied)

- **Enable secret scanning non-provider patterns and validity checks** for broader secret detection
- **Add a second collaborator/maintainer** to reduce bus factor (currently sole maintainer: @sethbacon)
- **Consider adding a tag protection rule** to prevent deletion of release tags (`v*.*.*`)

## Completed Initiatives

All 7 roadmap phases are complete as of v1.0.0. See `docs/initiatives/` for detailed plans:

- [Initiative 1: Flexible Terraform Installer](docs/initiatives/initiative-1-flexible-installer.md) — Completed
- [Initiative 2: Complete CLI Coverage](docs/initiatives/initiative-2-complete-cli-coverage.md) — Completed
- [Initiative 3: Workload Identity Federation for Non-AzureRM](docs/initiatives/initiative-3-workload-identity-federation.md) — Completed
- [Initiative 4: Workload Identity Federation for OCI](docs/initiatives/initiative-4-oci-wif.md) — Completed

See [docs/roadmap.md](docs/roadmap.md) for the full 7-phase plan and [CHANGELOG.md](CHANGELOG.md) for the release history.
