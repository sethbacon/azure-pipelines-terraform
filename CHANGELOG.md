# Changelog

All notable changes to **Pipeline Tasks for Terraform** (`sethbacon.pipeline-tasks-terraform`) are documented here.

This project adheres to [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses [semantic versioning](https://semver.org/).

## [0.3.0] — 2026-04-06

### Security
- Mask AWS backend credentials with `tasks.setSecret()` (access_key, secret_key)
- Mask Azure ARM_CLIENT_SECRET with `tasks.setSecret()` for ServicePrincipal auth
- Mask HCP API token with `tasks.setSecret()`
- Register OCI private key file and generated .tf config for temp file cleanup
- Fix proxy URL construction in installer using `URL` class (prevents malformed URLs with special characters)

### Fixed
- Fix GCP backend prefix: treat `backendGCPPrefix` as optional (no longer crashes when omitted)
- Fix output/show/custom file paths to resolve relative to `workingDirectory` instead of `process.cwd()`
- Fix `azure-devops-extension.json`: correct `"Tags"` → `"tags"` (marketplace schema), fix `"aws-enpoint-type"` typo
- Fix OCI handler typo `tfConfigyFilePath` → `tfConfigFilePath`
- Add missing `TerraformPlanFailed` localization key to task.json

### Added
- OCI provider tests: init, plan, apply, destroy
- Backend decoupling test: S3 backend with AzureRM provider
- ESLint configuration and CI lint step for V5 and InstallerV1
- ESLint devDependencies (`eslint`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`)

### Changed
- Bump TypeScript from `^4.0.0` to `^5.0.0` in V5 and InstallerV1
- Bump `@types/node` to `^20.11.0`, `@types/mocha` to `^10.0.0` in V5 and InstallerV1
- Remove Node10 execution target from V5 and InstallerV1 task.json (Node16 + Node20_1 remain)
- Remove dead `del` dependency and unused `compareVersions()` method from base handler
- Replace `const fs = require('fs')` with `import fs = require('fs')` in base handler
- Update `author` to `sethbacon` and `helpMarkDown` to GitHub URL in task.json files
- Add `optimization.minimize: false` and `performance.hints: false` to webpack config
- Exclude `tsconfig*.json` and `.eslintrc.json` from webpack VSIX copy
- Rewrite `overview.md` to document fork capabilities

### Documentation
- Review and fix all markdown documentation for correctness
- Add implementation status to initiative docs (1, 2, 3 all marked COMPLETED)
- Update CLAUDE.md: fix Node10 reference, add missing commands, fix test description
- Fix CONTRIBUTING.md: correct test command description, add InstallerV1 test info
- Fix overview.md: correct backendType default behavior description
- Fix InstallerV1 README: update support links, fix typos, fix markdown formatting
- Fix V5 README: replace Microsoft aka.ms link with fork documentation link
- Update initiative-3: mark HCP as completed, note generic/local handler routing

### Removed
- Delete empty `temp.js` artifact from repo root
- Delete orphaned `L0CompareVersions.ts` test file (method was removed)

**102 tests passing (TerraformTaskV5)**

---

## [0.2.3] — 2026-03-22

### Documentation

- Rewrote README from scratch: fork identity, task reference (`PipelineTerraformInstaller@1`, `PipelineTerraformTask@5`), all 13 commands, all 7 `backendType` options, provider/auth table, service connection types, WIF quick-reference YAML, differences-from-MS-DevLabs comparison table
- Replaced SECURITY.md with GitHub Security Advisory guidance (removed Microsoft MSRC contact)
- Updated SUPPORT.md: removed Microsoft references, retained GitHub Issues guidance
- Replaced CODE_OF_CONDUCT.md with Contributor Covenant v2.1 (removed Microsoft OSS CoC)

---

## [0.2.1] — 2026-03-18

### Fixed
- Reverted task GUIDs to original values for marketplace compatibility (marketplace enforces GUID consistency across extension versions)
- Fixed task name consistency across V1-V4 versions (all now use `PipelineTerraformTask`)

---

## [0.2.0] - 2026-03-18

### Breaking Changes

- **Task rename for side-by-side install**: Tasks renamed to `PipelineTerraformTask` and `PipelineTerraformInstaller` with new unique GUIDs. Pipeline YAML references must change to `PipelineTerraformTask@5` and `PipelineTerraformInstaller@1`. This allows coexistence with the original MS DevLabs extension.

### Security

- **Credential debug logging removed** (HIGH): `environment-variables.ts` no longer logs secret values in `tasks.debug()` output
- **Command whitelist added** (MEDIUM): `parent-handler.ts` validates commands against a static whitelist before dynamic dispatch
- **SHA256 verification for HashiCorp downloads**: Installer now fetches and verifies `SHA256SUMS` for HashiCorp and mirror downloads (registry already had this)
- **AWS secrets registered for masking**: `tasks.setSecret()` called on AWS secret access key to prevent pipeline log exposure
- **Temp credential file cleanup**: OIDC token files and GCP credential JSON files are now deleted after terraform execution via `cleanupTempFiles()` in a `finally` block
- **GCP credentials built with JSON.stringify**: Replaced unsafe template literal with `JSON.stringify()` for service account JSON construction
- **URL-encoded serviceConnectionId**: `id-token-generator.ts` uses `encodeURIComponent()` for the OIDC request URL
- **chmod 755**: Installer binary permissions changed from `777` to `755`
- **Error handling hardened**: `index.ts` properly extracts error messages with `instanceof Error` check

### Added

- **HCP Terraform Cloud backend**: New `backendType: hcp` with `backendHCPToken`, `backendHCPOrganization`, `backendHCPWorkspace` inputs
- **InstallerV1 test suite** (8 tests): HashiCorp latest/specific version, cached install, registry download, mirror download, insecure URL rejection, SHA256 mismatch, invalid version
- **V5 command tests** (5 tests): show (console + file), output, custom, terraform test command
- **Test helper factory**: `Tests/test-helpers.ts` and `Tests/test-l0-helpers.ts` reduce boilerplate for new tests
- **Strict TypeScript**: Both V5 and InstallerV1 compile with `strict: true`, `noImplicitReturns`, `noFallthroughCasesInSwitch`
- **Type declaration** for `uuid/v4` module (`src/types.d.ts`)
- **Split tsconfig**: `tsconfig.json` (strict, src only) and `tsconfig.tests.json` (relaxed, includes tests) for each task

### Fixed

- **Return type bugs**: `show()`, `output()`, `custom()` methods now correctly return `commandOutput.code` (number) instead of the full `IExecSyncResult` object
- **Missing default case**: `getServiceProviderNameFromProviderInput()` now throws for unknown providers instead of returning `undefined`
- **Invalid outputTo handling**: `show()` and `custom()` throw descriptive errors instead of silently returning `undefined`

---

## [0.1.0] - 2026-03-07

First published release of the `sethbacon.pipeline-tasks-terraform` fork.

### Added

#### Foundation (Part 0)

- CI workflow (`.github/workflows/unit-test.yml`): `actions/checkout@v4`, `actions/setup-node@v4` pinned to Node 18 LTS, removed legacy V4 job, added TerraformInstallerV1 build job
- Release workflow (`.github/workflows/release.yml`): semver-tag-triggered, guards tag is on `main`, runs CI, packages `.vsix`, publishes to VS Marketplace, creates GitHub Release
- `configs/release.json`: release manifest override for `sethbacon` publisher
- `CHANGELOG.md`, `CLAUDE.md`, `CONTRIBUTING.md`: project documentation
- `docs/initiatives/`: initiative planning documents
- `docs/setup/aws-wif-setup.md`, `docs/setup/gcp-wif-setup.md`: Workload Identity Federation setup guides

#### Initiative 2: Complete CLI Coverage (TerraformTaskV5)

- `workspace` command with `workspaceSubCommand` (new/select/list/delete/show) and `workspaceName` inputs
- `state` command with `stateSubCommand` (list/pull/push/mv/rm/show) and `stateAddress` inputs
- `fmt` command with `fmtCheck` (fail if formatting needed) and `fmtRecursive` inputs
- `get` command for Terraform module download
- `-replace` flag input on `plan` and `apply` (`replaceAddress`) as the modern replacement for the deprecated `taint` command
- Tests for all new commands (WorkspaceTests, StateTests, FmtTests, GetTests, plan/apply with -replace)

#### Initiative 3: Workload Identity Federation for AWS and GCP (TerraformTaskV5)

- AWS WIF support: `environmentAuthSchemeAWS` (ServiceConnection / WorkloadIdentityFederation), `awsRoleArn`, `awsRegion`, `awsSessionName` inputs; writes OIDC JWT to temp file, sets `AWS_ROLE_ARN` + `AWS_WEB_IDENTITY_TOKEN_FILE`
- GCP WIF support: `environmentAuthSchemeGCP` (ServiceConnection / WorkloadIdentityFederation), `gcpProjectNumber`, `gcpWorkloadIdentityPoolId`, `gcpWorkloadIdentityProviderId`, `gcpServiceAccountEmail` inputs; builds external account credentials JSON for `GOOGLE_CREDENTIALS`
- Backend/provider decoupling: new `backendType` input (`azurerm`/`s3`/`gcs`/`oci`/`generic`/`local`) — for `init`, backend type selects the handler independently of the deployment `provider`
- Generic backend handler (`TerraformCommandHandlerGeneric`): `backendConfigFile` and `backendConfigArgs` (key=value lines) inputs passed as `-backend-config` flags to `terraform init`
- Backwards-compatible: existing pipelines without `backendType` continue to work (falls back to `provider`)
- Tests for generic init, AWS WIF plan, GCP WIF plan (92 total tests passing)

### Changed

- Extension manifest: publisher `sethbacon`, id `pipeline-tasks-terraform`, name `Pipeline Tasks for Terraform`
- Service endpoint type names made globally unique: `PTTAWSServiceEndpoint`, `PTTGoogleCloudServiceEndpoint`, `PTTOCIServiceEndpoint`
- Upgraded `tfx-cli` from `0.16.0` to `0.23.1`
- `parent-handler.ts`: routing decoupled for init (backend) vs. other commands (provider); added Generic/Local handler
- TerraformTaskV5 mocha upgraded to `^11.2.0` for Node 25 compatibility
- `visibleRule` expressions simplified to supported syntax (no `||` or parentheses)

---

## Fork History

This project is a fork of [azure-pipelines-terraform](https://github.com/microsoft/azure-pipelines-terraform) by Microsoft DevLabs (MIT License). The original extension was published as `ms-devlabs.custom-terraform-tasks`. Version history prior to this fork is maintained in the upstream repository.
