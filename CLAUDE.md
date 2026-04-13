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
- `development` — integration branch; all feature/fix PRs merge here first
- `feature/<description>` — created from `development`; deleted after merge
- `fix/<description>` — bug fix branches from `development`

**Never commit directly to `main`.** Use PRs from `development`.

## Commit Convention

Format: `type: short description` (50 chars max for the title)

Types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`

Body line: `Closes #<issue-number>`

Example:

```txt
feat: add registry download strategy to terraform installer

Closes #12
```

## Workflow Per Change

1. Open a GitHub issue before writing code
2. Create branch from `development`: `git checkout -b feature/<description> development`
3. Run local quality gate before pushing:
   - `npm run compile` (TypeScript build, zero errors)
   - `npm test` (all tests pass)
4. Rebase on `origin/development` before pushing: `git rebase origin/development`
5. Open PR to `development` with a `## Changelog` section in the body
6. Squash-merge when approved (only merge strategy allowed)
7. Feature branches are deleted automatically after merge
8. Never merge directly to `main`

## Release Process

1. Collect changelog entries from merged PR bodies
2. Update `CHANGELOG.md` on `development` branch
3. **Bump `version` in `azure-devops-extension.json`** to match the release tag (e.g. `"0.3.0"` for tag `v0.3.0`). The release workflow will fail if these don't match.
4. Open PR: `development` → `main` (squash merge)
5. Tag the merge commit: `git tag vX.Y.Z origin/main && git push origin vX.Y.Z`
6. The release workflow (`.github/workflows/release.yml`) triggers automatically on the semver tag
7. The workflow: guards the tag is on `main` → verifies extension version matches tag → runs CI → builds → packages `.vsix` → publishes to Marketplace → creates GitHub Release

**Required GitHub secret:** `TFX_PAT` — Personal Access Token for Visual Studio Marketplace with `Marketplace (publish)` scope. Set in repository Settings → Secrets → Actions.

## Publisher Registration

To publish to the VS Marketplace:

1. Navigate to: `https://marketplace.visualstudio.com/manage/createpublisher`
2. Sign in with a Microsoft account
3. Publisher ID: `sethbacon`
4. Accept the Marketplace Publisher Agreement
5. The `TFX_PAT` secret must have `Marketplace (publish)` scope to enable automated publishing

## Extension Naming — HashiCorp Trademark

HashiCorp's trademark policy prohibits using "Terraform" as a standalone product name. Nominative fair use (accurately describing compatibility) is permitted. The name `"Pipeline Tasks for Terraform"` is compliant — it describes the extension's function without implying official HashiCorp affiliation.

**Attribution:** The `LICENSE` file retains the original Microsoft copyright notice. The README notes the fork origin.

## Repository Structure

```txt
azure-pipelines-terraform/
├── Tasks/
│   ├── TerraformInstaller/
│   │   └── TerraformInstallerV1/      # Current installer task
│   └── TerraformTask/
│       └── TerraformTaskV5/           # Current development target
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

**Always work in TerraformTaskV5.** TerraformInstallerV1 is the active installer task. Legacy task versions (V1-V4, InstallerV0) have been removed.

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
- **`test`** - runs `terraform test` with optional filter and verbose flags
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
- Supports `latest` (queries HashiCorp checkpoint API, falls back to `1.9.8`)
- Supports Windows, macOS, Linux on amd64, arm64, arm, 386
- Verifies GPG signature of SHA256SUMS using HashiCorp's embedded public key (`gpg-verifier.ts`)
- Sets `terraformLocation` pipeline variable after install
- Handles proxy configuration via `tasks.getHttpProxyConfiguration()`

## task.json Schema Key Points

- `id` is shared across all versions of TerraformTask (`FE504ACC-6115-40CB-89FF-191386B5E7BF`)
- `execution` targets `Node16` and `Node20_1` in V5
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

- `.github/workflows/unit-test.yml` — **Active CI for this fork.** Runs build + tests on push/PR to `main`/`development`
- `.github/workflows/release.yml` — **Release pipeline.** Triggered by semver tags (`v*.*.*`); publishes to VS Marketplace

## Local Development Environment

Verified tooling (as of March 2026):

| Tool               | Status                 | Version                                          |
| ------------------ | ---------------------- | ------------------------------------------------ |
| Node.js            | Installed              | v25.7.0 (not LTS — CI pins Node 18)              |
| npm                | Installed              | v11.10.1                                         |
| TypeScript (`tsc`) | Not globally installed | Available as dev dep after `npm install`         |
| `tfx-cli`          | Not globally installed | Available as dev dep after `npm install` at root |
| GitHub CLI (`gh`)  | Installed              | v2.87.3                                          |
| Terraform          | Installed              | v1.14.6 at `/c/dev/terraform`                    |

Node v25.7.0 is not LTS. The GitHub Actions workflow pins Node 18 LTS. Local development on Node 25 works for tests; build-related failures may be version-related.

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

- Required status checks (strict — branch must be up-to-date): `Check Version Consistency`, `Build and Test V5`, `Build and Test Installer V1`
- Required pull request reviews: 1 approving review, dismiss stale reviews, require code owner review
- Enforce admins: no (admin/owner can bypass review requirements as sole maintainer)
- Required linear history: yes (squash/rebase only, no merge commits)
- Required conversation resolution: yes
- Force pushes: blocked
- Branch deletion: blocked

**`development` branch:**

- Required status checks (non-strict): `Check Version Consistency`, `Build and Test V5`, `Build and Test Installer V1`
- Required linear history: yes
- Force pushes: blocked
- Branch deletion: blocked
- Admin bypass: allowed (owner can push directly for admin tasks)

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
  - npm: TerraformTaskV5, TerraformInstallerV1, root (weekly)

### Code Ownership

- **CODEOWNERS** file at `.github/CODEOWNERS` — `@sethbacon` owns all files; `.github/`, `configs/`, and `azure-devops-extension.json` require explicit owner review

### Security Features (GitHub)

- Secret scanning: enabled
- Secret scanning push protection: enabled
- `npm audit --omit=dev --audit-level=high` in CI
- All GitHub Actions pinned to full commit SHAs

### Repository Topics

`terraform`, `azure-devops`, `azure-pipelines`, `infrastructure-as-code`, `azure-devops-extension`, `devops`

### Remaining Recommendations (not yet applied)

- **Enable code scanning** (CodeQL) for TypeScript static analysis — requires GitHub Advanced Security or a public repo CodeQL workflow
- **Enable secret scanning non-provider patterns and validity checks** for broader secret detection
- **Add a second collaborator/maintainer** to reduce bus factor (currently sole maintainer: @sethbacon)
- **Consider adding a tag protection rule** to prevent deletion of release tags (`v*.*.*`)

## Active Initiatives

See `docs/initiatives/` for detailed plans:

- [Initiative 1: Flexible Terraform Installer](docs/initiatives/initiative-1-flexible-installer.md) — Support HashiCorp official releases, terraform-registry-backend, and custom mirror URLs
- [Initiative 2: Complete CLI Coverage](docs/initiatives/initiative-2-complete-cli-coverage.md) — Add workspace, state, fmt, test, get commands; -replace flag on plan/apply
- [Initiative 3: Workload Identity Federation for Non-AzureRM](docs/initiatives/initiative-3-workload-identity-federation.md) — AWS and GCP WIF support; backend/provider decoupling
