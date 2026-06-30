# Changelog

All notable changes to **Pipeline Tasks for Terraform** (`sethbacon.pipeline-tasks-terraform`) are documented here.

This project adheres to [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses [semantic versioning](https://semver.org/).

## [1.6.3](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.6.2...v1.6.3) (2026-06-30)


### Bug Fixes

* prefer installer terraformLocation over PATH lookup ([#321](https://github.com/sethbacon/azure-pipelines-terraform/issues/321)) ([90c2e3d](https://github.com/sethbacon/azure-pipelines-terraform/commit/90c2e3d1eccf1c23cdefb74624cc47ff30447031))
* prepend installed Terraform/OpenTofu dir to PATH ([#320](https://github.com/sethbacon/azure-pipelines-terraform/issues/320)) ([b6e2650](https://github.com/sethbacon/azure-pipelines-terraform/commit/b6e2650dc3dfe1ad6670b8e0280dac806a0c871d)), closes [#319](https://github.com/sethbacon/azure-pipelines-terraform/issues/319)


### Documentation

* document accepted az login argv credential exposure ([#327](https://github.com/sethbacon/azure-pipelines-terraform/issues/327)) ([2a62b7e](https://github.com/sethbacon/azure-pipelines-terraform/commit/2a62b7efb8a33ae6e23af08a88bfb5d27a983dc6)), closes [#288](https://github.com/sethbacon/azure-pipelines-terraform/issues/288)
* document why the two HTTP client families stay separate ([#324](https://github.com/sethbacon/azure-pipelines-terraform/issues/324)) ([c6bd90d](https://github.com/sethbacon/azure-pipelines-terraform/commit/c6bd90d5046f4ad7998d9fd9f94d2e82b4d7c5b8)), closes [#301](https://github.com/sethbacon/azure-pipelines-terraform/issues/301)


### Refactor

* single chokepoint for commandOptions input ([#328](https://github.com/sethbacon/azure-pipelines-terraform/issues/328)) ([98b56eb](https://github.com/sethbacon/azure-pipelines-terraform/commit/98b56eb0d3e87bb85038b4182cec4a3c76ac07ff)), closes [#302](https://github.com/sethbacon/azure-pipelines-terraform/issues/302)


### Security

* opt-in host allowlist for registry download_url ([#322](https://github.com/sethbacon/azure-pipelines-terraform/issues/322)) ([22cd89b](https://github.com/sethbacon/azure-pipelines-terraform/commit/22cd89bcb8b02f33f190cafe8eee89ae8342881a))
* support user-assigned MSI client ID ([#326](https://github.com/sethbacon/azure-pipelines-terraform/issues/326)) ([855a8c3](https://github.com/sethbacon/azure-pipelines-terraform/commit/855a8c3ad7d95d26b0bb8fe7edc76ae2c93a6e6b)), closes [#289](https://github.com/sethbacon/azure-pipelines-terraform/issues/289)
* validate OCI WIF tenancy OCID and region ([#325](https://github.com/sethbacon/azure-pipelines-terraform/issues/325)) ([3164521](https://github.com/sethbacon/azure-pipelines-terraform/commit/316452172d5576810296fd54608afe5779a8c758)), closes [#296](https://github.com/sethbacon/azure-pipelines-terraform/issues/296)

## [1.6.2](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.6.1...v1.6.2) (2026-06-29)


### Bug Fixes

* crop marketplace screenshots ([ef568ad](https://github.com/sethbacon/azure-pipelines-terraform/commit/ef568ad9676e5d0797be3c4dfdd6dc58b7cb5e5c))
* **deps:** pin js-yaml &gt;=4.2.0 to resolve DoS advisory (4 tasks) ([57f1b4a](https://github.com/sethbacon/azure-pipelines-terraform/commit/57f1b4a3657ef23fdd94b69f3e2eb7bef2a2110a))


### Documentation

* document accepted security residuals ([#315](https://github.com/sethbacon/azure-pipelines-terraform/issues/315)) ([58d2409](https://github.com/sethbacon/azure-pipelines-terraform/commit/58d240979ca0258b26ad3756b3607790b55b4838)), closes [#286](https://github.com/sethbacon/azure-pipelines-terraform/issues/286) [#290](https://github.com/sethbacon/azure-pipelines-terraform/issues/290) [#292](https://github.com/sethbacon/azure-pipelines-terraform/issues/292) [#293](https://github.com/sethbacon/azure-pipelines-terraform/issues/293) [#294](https://github.com/sethbacon/azure-pipelines-terraform/issues/294) [#300](https://github.com/sethbacon/azure-pipelines-terraform/issues/300) [#304](https://github.com/sethbacon/azure-pipelines-terraform/issues/304) [#311](https://github.com/sethbacon/azure-pipelines-terraform/issues/311) [#312](https://github.com/sethbacon/azure-pipelines-terraform/issues/312) [#313](https://github.com/sethbacon/azure-pipelines-terraform/issues/313) [#314](https://github.com/sethbacon/azure-pipelines-terraform/issues/314)


### Security

* fail-secure drift callback TLS verify ([#318](https://github.com/sethbacon/azure-pipelines-terraform/issues/318)) ([76351d0](https://github.com/sethbacon/azure-pipelines-terraform/commit/76351d00d9b0b94e8b60a2e2bfb8e78c27b88024)), closes [#307](https://github.com/sethbacon/azure-pipelines-terraform/issues/307)
* harden OCI WIF temp-dir and cleanup ([#316](https://github.com/sethbacon/azure-pipelines-terraform/issues/316)) ([2c08708](https://github.com/sethbacon/azure-pipelines-terraform/commit/2c0870897503eb10a4a589f757a629848a273148))
* pin per-task deps with npm ci in build ([#284](https://github.com/sethbacon/azure-pipelines-terraform/issues/284)) ([1b5e6ff](https://github.com/sethbacon/azure-pipelines-terraform/commit/1b5e6ffab633915a62506d47f99380e59fe39ed5)), closes [#239](https://github.com/sethbacon/azure-pipelines-terraform/issues/239)
* validate sentinel import name ([#317](https://github.com/sethbacon/azure-pipelines-terraform/issues/317)) ([42e8ae9](https://github.com/sethbacon/azure-pipelines-terraform/commit/42e8ae9549f0566df86edc235cd68f60bc56f7e9))

## [1.6.1](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.6.0...v1.6.1) (2026-06-28)


### Bug Fixes

* refresh marketplace screenshots for all task forms ([15e0275](https://github.com/sethbacon/azure-pipelines-terraform/commit/15e02757088c9b3ee715625096066fff076199c2))

## [1.6.0](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.5.1...v1.6.0) (2026-06-28)


### Features

* SARIF 2.1.0 output for PolicyCheck and DriftReport ([#246](https://github.com/sethbacon/azure-pipelines-terraform/issues/246)) ([b5c5c83](https://github.com/sethbacon/azure-pipelines-terraform/commit/b5c5c8366eaa3ee7b567255d68c9a32abeaac0bc)), closes [#244](https://github.com/sethbacon/azure-pipelines-terraform/issues/244)


### Bug Fixes

* add network timeouts and bounded poll loops ([#256](https://github.com/sethbacon/azure-pipelines-terraform/issues/256)) ([a3b407e](https://github.com/sethbacon/azure-pipelines-terraform/commit/a3b407e0e67130e9ce9795253cade711ee83c439)), closes [#236](https://github.com/sethbacon/azure-pipelines-terraform/issues/236)
* bound V5 secure-file download with a timeout ([f889517](https://github.com/sethbacon/azure-pipelines-terraform/commit/f8895175d4d6748cc6b7255fec40d04af571d6ca)), closes [#273](https://github.com/sethbacon/azure-pipelines-terraform/issues/273)
* drop release-please issues:write request ([#262](https://github.com/sethbacon/azure-pipelines-terraform/issues/262)) ([e2c2b45](https://github.com/sethbacon/azure-pipelines-terraform/commit/e2c2b450d34157f18bad31cfb96476f15b92c145))
* grant release-please issues:write for labels ([#261](https://github.com/sethbacon/azure-pipelines-terraform/issues/261)) ([3279945](https://github.com/sethbacon/azure-pipelines-terraform/commit/32799459ee57396f04060d73dd1fd7cd3851a66f))
* show requireChecksum for the registry source ([1a11b08](https://github.com/sethbacon/azure-pipelines-terraform/commit/1a11b0831b907ad4f1624447fe67b87566db0752)), closes [#274](https://github.com/sethbacon/azure-pipelines-terraform/issues/274)


### Dependencies

* patch serialize-javascript and js-yaml ([#260](https://github.com/sethbacon/azure-pipelines-terraform/issues/260)) ([8d76bb7](https://github.com/sethbacon/azure-pipelines-terraform/commit/8d76bb7e194443de90b9fcfaf04eb92246aab583))


### Documentation

* fix documentation drift ([#254](https://github.com/sethbacon/azure-pipelines-terraform/issues/254)) ([52a4549](https://github.com/sethbacon/azure-pipelines-terraform/commit/52a4549fd2bd3e7649fde7f49c79e3d0c028f25c)), closes [#240](https://github.com/sethbacon/azure-pipelines-terraform/issues/240)


### Refactor

* enforce installer shared-module parity ([be0e333](https://github.com/sethbacon/azure-pipelines-terraform/commit/be0e3333fb0f9eec185fb0f25af5acd8bfbad550)), closes [#238](https://github.com/sethbacon/azure-pipelines-terraform/issues/238)
* unify credential-bearing HTTPS client ([9fcef2b](https://github.com/sethbacon/azure-pipelines-terraform/commit/9fcef2baeebbb10450b027140b8da65553bd8bb6)), closes [#271](https://github.com/sethbacon/azure-pipelines-terraform/issues/271) [#272](https://github.com/sethbacon/azure-pipelines-terraform/issues/272)


### Security

* add task.json restrictions to all tasks ([#245](https://github.com/sethbacon/azure-pipelines-terraform/issues/245)) ([f228362](https://github.com/sethbacon/azure-pipelines-terraform/commit/f22836224b798545c3c3cb8a1bb3320b8f416919)), closes [#235](https://github.com/sethbacon/azure-pipelines-terraform/issues/235)
* anchor OpenTofu cosign cert identity ([#251](https://github.com/sethbacon/azure-pipelines-terraform/issues/251)) ([199337e](https://github.com/sethbacon/azure-pipelines-terraform/commit/199337e001832ec7effc18c935282038e62e15cf)), closes [#233](https://github.com/sethbacon/azure-pipelines-terraform/issues/233)
* harden PolicyCheck git policy source ([#275](https://github.com/sethbacon/azure-pipelines-terraform/issues/275)) ([611dbed](https://github.com/sethbacon/azure-pipelines-terraform/commit/611dbed7e8c78300854f6c6f6af771f95f33496b)), closes [#263](https://github.com/sethbacon/azure-pipelines-terraform/issues/263) [#264](https://github.com/sethbacon/azure-pipelines-terraform/issues/264) [#265](https://github.com/sethbacon/azure-pipelines-terraform/issues/265) [#266](https://github.com/sethbacon/azure-pipelines-terraform/issues/266)
* harden registry download path ([d37478d](https://github.com/sethbacon/azure-pipelines-terraform/commit/d37478dead92037e94ec5c458e80598e7e1bef3b)), closes [#234](https://github.com/sethbacon/azure-pipelines-terraform/issues/234)
* mask secrets + harden transport in publish/drift ([#250](https://github.com/sethbacon/azure-pipelines-terraform/issues/250)) ([221c669](https://github.com/sethbacon/azure-pipelines-terraform/commit/221c669edcf03630eac1f97d0b1c2e279ce80a8f)), closes [#232](https://github.com/sethbacon/azure-pipelines-terraform/issues/232)
* validate OCI WIF identity domain URL ([#249](https://github.com/sethbacon/azure-pipelines-terraform/issues/249)) ([a2f2b9e](https://github.com/sethbacon/azure-pipelines-terraform/commit/a2f2b9e68a71b50951d57996a1515e41274fe2ff)), closes [#231](https://github.com/sethbacon/azure-pipelines-terraform/issues/231)

## [1.5.1](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.5.0...v1.5.1) (2026-06-24)


### Bug Fixes

* prevent publishPlanResults attachment race ([#229](https://github.com/sethbacon/azure-pipelines-terraform/issues/229)) ([4f54662](https://github.com/sethbacon/azure-pipelines-terraform/commit/4f5466271554f4fd1b26135028e81c664cb52f2c))

## [1.5.0](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.4.3...v1.5.0) (2026-06-22)


### Features

* require Node 24 agent runtime, bump deps ([#225](https://github.com/sethbacon/azure-pipelines-terraform/issues/225)) ([5bc2bf7](https://github.com/sethbacon/azure-pipelines-terraform/commit/5bc2bf743751419eadf910f3f18f8deb15624817))


### Documentation

* reflect Node24-only execution floor ([#227](https://github.com/sethbacon/azure-pipelines-terraform/issues/227)) ([a64eb40](https://github.com/sethbacon/azure-pipelines-terraform/commit/a64eb4004fc6fc1125377f379465d54cfa6dd848))


### Security

* pin tfx-cli 0.23.2, overrides + drop glob-exec ([#228](https://github.com/sethbacon/azure-pipelines-terraform/issues/228)) ([7fa1f31](https://github.com/sethbacon/azure-pipelines-terraform/commit/7fa1f316f9a6f8e7132a3dd20eb0072501ca71e0))

## [1.4.3](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.4.2...v1.4.3) (2026-06-22)


### Bug Fixes

* track ProviderMirror in version check and bump it ([#223](https://github.com/sethbacon/azure-pipelines-terraform/issues/223)) ([6a1bd51](https://github.com/sethbacon/azure-pipelines-terraform/commit/6a1bd510d77b34154b63e9cb0042aa80755d8430))

## [1.4.2](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.4.1...v1.4.2) (2026-06-22)


### Bug Fixes

* bump task versions to refresh ADO task cache ([#221](https://github.com/sethbacon/azure-pipelines-terraform/issues/221)) ([919f5a1](https://github.com/sethbacon/azure-pipelines-terraform/commit/919f5a19fb13ac99debcef25151ae7a8d8882ce5))

## [1.4.1](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.4.0...v1.4.1) (2026-06-21)


### Bug Fixes

* **deps:** bump @babel/core and js-yaml, scope dev uuid override ([#219](https://github.com/sethbacon/azure-pipelines-terraform/issues/219)) ([65cdd44](https://github.com/sethbacon/azure-pipelines-terraform/commit/65cdd446cd57c7a5b40ce1afda593211b3613087))

## [1.4.0](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.3.0...v1.4.0) (2026-06-20)


### Features

* add TerraformDriftReport task sharing the drift contract ([#217](https://github.com/sethbacon/azure-pipelines-terraform/issues/217)) ([c00e59a](https://github.com/sethbacon/azure-pipelines-terraform/commit/c00e59a66d1fb41402776d3d8fbae5992e1a49c6))


### Documentation

* resolve initiative-6 drifted rule; point to the GitHub twin ([#213](https://github.com/sethbacon/azure-pipelines-terraform/issues/213)) ([e719011](https://github.com/sethbacon/azure-pipelines-terraform/commit/e71901181c83cb435e31f3878f2957391d4e0cd0))


### Security

* bump undici to ^6.27.0 in TerraformInstallerV1 (GHSA-p88m-4jfj-68fv) ([#215](https://github.com/sethbacon/azure-pipelines-terraform/issues/215)) ([616d488](https://github.com/sethbacon/azure-pipelines-terraform/commit/616d488bbc60b9be74808144fa023d7c78b7ca13))

## [1.3.0](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.2.0...v1.3.0) (2026-06-12)


### Features

* add policy agent installer and policy check tasks ([#208](https://github.com/sethbacon/azure-pipelines-terraform/issues/208)) ([cca3774](https://github.com/sethbacon/azure-pipelines-terraform/commit/cca3774eb8a6aeac45e1faba08df8eba36908c76))

## [1.2.0](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.1.2...v1.2.0) (2026-05-31)


### Features

* add module publish task (HCP + private) ([#205](https://github.com/sethbacon/azure-pipelines-terraform/issues/205)) ([a2df988](https://github.com/sethbacon/azure-pipelines-terraform/commit/a2df988bbc381b71d6380632600399fb6fb2104e))

## [1.1.2](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.1.1...v1.1.2) (2026-05-29)


### Documentation

* add YAML examples reference page ([#203](https://github.com/sethbacon/azure-pipelines-terraform/issues/203)) ([f2a4e9d](https://github.com/sethbacon/azure-pipelines-terraform/commit/f2a4e9da8acfcb33c104975e0e518ef231a9bce5))

## [1.1.1](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.1.0...v1.1.1) (2026-05-28)


### Bug Fixes

* unique provider mirror task id and command arg quoting ([#201](https://github.com/sethbacon/azure-pipelines-terraform/issues/201)) ([b214bd2](https://github.com/sethbacon/azure-pipelines-terraform/commit/b214bd2c1232f4b28152ee754c494c48f38b7938))

## [1.1.0](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.0.12...v1.1.0) (2026-05-28)


### Features

* add provider mirror configuration task ([#199](https://github.com/sethbacon/azure-pipelines-terraform/issues/199)) ([dacfc9c](https://github.com/sethbacon/azure-pipelines-terraform/commit/dacfc9c288f7e0f4fd786226699e6d8fa8a9f959))

## [1.0.12] — 2026-05-22

### Fixed

- **Guard null credentials and empty GPG signatures across all provider handlers** (closes #189–#195):
  - Azure handler (#189): throw on null `SystemVssConnection` AccessToken in OIDC token refresh path instead of silently passing `null` downstream
  - OCI handler (#190): validate `privateKey` before passing to `normalizePem`; throw a clear error when it is missing from the service connection
  - GCP handler (#191): validate all three credential fields (`Issuer`, `Audience`, `PrivateKey`) before writing the JSON credentials file; error message names which fields are missing
  - `id-token-generator` (#192): validate `AccessToken` before building the `Bearer` header; surfacing an actionable error when `SystemVssConnection` is unavailable prevents opaque HTTP 401 failures across all WIF providers
  - `gpg-verifier` (#193): guard `result.signatures.length > 0` before destructuring to avoid a `TypeError` on malformed or empty `.sig` files
  - AWS handler (#194): replace misleading `!` non-null assertions with `?? ''` on `required=false` credential parameters
  - Azure handler (#195): `tenantId` in `runAzLogin` changed to `required=true`; `ARM_TENANT_ID` env var set with `?? ''` to remove false type assertion

- **Upgrade to Node 24 LTS**: Node 20 reached EOL April 2026. All CI workflows, `package.json` engine constraints, and ADO `task.json` execution targets updated to Node 24 (`Node24` added alongside `Node20_1` for backward-compatible agent fallback).

- **GitHub Actions upgrades**: `actions/setup-node` v5→v6.4.0, `sigstore/cosign-installer` v3→v4.1.2, `softprops/action-gh-release` v2→v3.0.0 (native Node 24), `actions/github-script` v7→v9.0.0, `github/codeql-action` v3→v4.36.0, `actions/upload-artifact` v7.0.0→v7.0.1.

- **Bump task Minor versions for ADO cache invalidation**: TerraformTaskV5 `5.261→5.262`, TerraformInstallerV1 `1.220→1.221`.

- **Fix cosign v4 bundle format**: `sigstore/cosign-installer` v4 dropped `--output-signature`/`--output-certificate` in favour of `--bundle`. Release workflow updated to produce a single `.vsix.bundle` artifact instead of separate `.sig` and `.pem` files.

## [1.0.11] — 2026-05-16

### Fixed

- **Bump TerraformInstallerV1 Minor to 220 for ADO cache invalidation**: the v1.0.10 fix to the registry binary download was not picked up by ADO agents because the task Minor version was not incremented. TerraformInstaller is now at `1.220.0`.

## [1.0.10] — 2026-05-16

### Fixed

- **TerraformInstallerV1 registry download no longer fails when registry returns empty sha256**: when `downloadSource: registry` is used, the installer calls the per-platform endpoint which may return an empty `sha256` field if the registry already verified the binary server-side (`sha256_verified: true`). An empty string is falsy in JavaScript, causing a spurious "missing sha256" error. The guard now only requires `download_url`; local SHA256 verification is performed when the field is non-empty and skipped (with a debug log) when it is empty.

## [1.0.9] — 2026-05-15

### Fixed

- **Bump task Minor versions to invalidate ADO distributed task cache**: Azure DevOps caches tasks by Major.Minor and only refreshes when Minor increments. The v1.0.8 fix was not served to agents because only Patch was bumped. TerraformTask now at `5.261.0`, TerraformInstaller at `1.219.0`.

## [1.0.8] — 2026-05-15

### Fixed

- **`test` command no longer requires a service connection**: previously, running `terraform test` with any provider would fail with `Input required: environmentServiceNameAWS` (or the equivalent for other providers) even when the tests didn't need cloud credentials. The service connection is now optional for the `test` command — unit/validation tests work without one, while integration tests that provision real resources can still provide a service connection and the task will configure provider auth automatically.

## [1.0.7] — 2026-05-12

### Fixed

- Remove `task.loc.json` from `TerraformInstallerV1`: the file had `"Minor": "217"` while `task.json` had `"Minor": "218"`, causing ADO to register the installer task as version `1.217.0` instead of `1.218.0`. This was the root cause of the "No task definition found" error in pipelines referencing the installer task. The file is unused (this extension does not use the ADO localization pipeline).

## [1.0.6] — 2026-05-12

### Fixed

- Reverted task ID changes from v1.0.5: the Visual Studio Marketplace `PackageValidationStep` enforces that task GUIDs cannot change across extension versions. Task IDs restored to originals (`310afe61-...` and `981E87CD-...`).
- No functional changes from v1.0.4.

## [1.0.5] — 2026-05-12 _(failed publish — do not use)_

- Attempted to change task GUIDs (`PipelineTerraformInstaller`, `PipelineTerraformTask`) to bypass an Azure DevOps org-level task catalog cache issue. Blocked by Marketplace `PackageValidationStep` validation; never successfully published.

## [1.0.4] — 2026-05-11

### Fixed

- Bump `postcss` to 8.5.14 (CVE-2026-41305, medium, dev dep — XSS in CSS stringify output)
- Bump `fast-uri` to 3.1.2 (CVE-2026-6322, high, dev dep — host confusion via percent-encoded authority)
- Bump `uuid` to 13.0.2 via `overrides` (CVE-2026-41907, medium, nested in tfx-cli — missing buffer bounds check)
- Resolve CodeQL `incomplete-url-substring-sanitization` warning in installer test by using exact hostname comparison

## [1.0.3] — 2026-05-11

### Fixed

- Extension contribution `name` paths were missing versioned subdirectory (`TerraformInstallerV1`, `TerraformTaskV5`); ADO could not locate `task.json` to register task packages, causing `No task definition found` errors in pipelines
- Replace `uuid` dependency with Node.js built-in `crypto.randomUUID()`; uuid v14 (ESM-only) broke CJS task runner; eliminates the dependency entirely from both tasks
- Update `fast-uri` to 3.1.2 in TerraformTaskV5 (dev dep, GHSA-q3j6-qgpj-74h6, GHSA-v39h-62p7-jpjc)

## [1.0.2] — 2026-05-11

### Fixed

- Task packages (`PipelineTerraformInstaller@1`, `PipelineTerraformTask@5`) failed to register in ADO distributed task service after v1.0.1 install; re-publishing forces task re-registration

## [1.0.1] — 2026-04-17

### Fixed

- Installer `requireGpgSignature` visibleRule mixed `&&` and `||` operators, which VS Marketplace validation rejects; replaced with `binary = terraform && downloadSource != registry`

## [1.0.0] — 2026-04-17

### Added

- **P6.1 · OpenTofu installer support**: new `binary` input on TerraformInstaller (`terraform` | `tofu`); resolves latest version from GitHub releases API; downloads from `github.com/opentofu/opentofu/releases`; cosign signature verification of SHA256SUMS (optional, controlled by `requireCosignVerification` input); tool cache separated by binary name
- **P6.2 · OCI Workload Identity Federation**: OIDC-based authentication for OCI provider using RFC 8693 token exchange with OCI Identity Domains; generates ephemeral RSA-2048 key pair, exchanges Azure DevOps OIDC JWT for OCI User Principal Session Token (UPST), writes synthetic OCI config for SecurityToken auth mode; new task inputs: `environmentAuthSchemeOCI`, `ociWifTenancyOcid`, `ociWifRegion`, `ociWifIdentityDomainUrl`, `ociWifClientId`

### Changed

- **P6.0 · Codebase cleanup**: freshened Terraform fallback version to 1.14.8 and OpenTofu to 1.11.6; shared `RESOURCE_ADDRESS_RE` regex across plan/apply/destroy; removed dynamic `require()` in favor of static imports; upgraded React 16 → 18 with `createRoot` API; replaced OCI PEM string-replace chain with proper `normalizePem()` function; DRY'd `commandOptions` handling with shared `buildCommandArgs` pipeline

**193 tests passing** (158 TerraformTaskV5 + 15 TerraformInstallerV1 + 20 Tab/Jest)

## [0.9.0] — 2026-04-17

### Added

- **P5.3 · Actionlint**: GitHub Actions workflow files are now linted by `actionlint` on every CI run
- **P5.4 · CodeQL**: new TypeScript static analysis workflow runs on PRs and weekly schedule
- **P5.5 · Changelog guard**: release pipeline verifies `CHANGELOG.md` has an entry matching the tag version
- **P5.6 · Draft-first release**: release pipeline creates a draft GitHub release with `.vsix` before Marketplace publish; Marketplace publish requires manual approval via `marketplace` environment; release is undrafted on success
- **P5.7 · SBOM + cosign signing**: CycloneDX SBOMs generated for V5 and Installer V1 production deps; `.vsix` signed with cosign keyless (OIDC-backed); SBOM, signature, and certificate attached to GitHub releases

### Changed

- **P5.2 · Audit level lowered**: `npm audit` threshold lowered from `high` to `moderate` for earlier advisory detection
- **P5.1 · Cross-platform CI**: V5 and Installer V1 tests now run on both `ubuntu-latest` and `windows-latest`

### Test coverage

- **P4.1 · Tab unit tests**: 20 Jest tests for `ansiToHtml` (edge cases, performance, realistic terraform output)
- **P4.2 · Environment variable tests**: tracking, re-registration, clear-all cycle
- **P4.5 · Emergency cleanup test**: verifies `clearTrackedVariables()` removes env vars
- **P4.6 · Unknown provider test**: `ParentCommandHandler` rejects invalid provider
- **P4.7 · Coverage reporting**: nyc integration with 75/70/75 thresholds (stmts/branches/functions)
- **P4.8 · Lint extends to Tests/**: ESLint now covers `Tests/` directory with relaxed rules

**186 tests passing** (154 TerraformTaskV5 + 12 TerraformInstallerV1 + 20 Tab/Jest)

## [0.8.0] — 2026-04-17

### Security

- **P3.1 · Strict GPG verification**: new `requireGpgSignature` boolean input on TerraformInstaller (default `true` for HashiCorp source). When enabled, missing `.sig` files are a hard failure instead of a warning
- **P3.3 · Fail-closed auth scheme validation**: AWS and GCP handlers now validate `environmentAuthSchemeAWS`/`environmentAuthSchemeGCP` against `["ServiceConnection", "WorkloadIdentityFederation"]` and throw on unknown values — matches the existing AzureRM strict pattern
- **P3.4 · Secure temp file writes**: new shared `writeSecretFile()` helper (`secure-temp.ts`) writes credential files with `mode: 0o600` and verifies permissions; Windows ACL fallback. Used by AWS, GCP, and OCI OIDC token/key file writes
- **P3.7 · Stricter provider detection**: `warnIfMultipleProviders()` now uses anchored regex patterns (`provider[.*/aws]`) instead of substring `.includes()`, eliminating false positives from modules named like `my-aws-helper`

### Added

- **P3.2 · Plan tab hardening**: `ansiToHtml()` rewritten as a state machine that tracks open `<span>` tags to guarantee balanced HTML. Multi-code SGR sequences fully processed. 2 MB render cap — oversized attachments show a "Download raw output" blob-URL link instead of freezing the browser
- **P3.5 · Emergency cleanup hooks**: `uncaughtException` and `unhandledRejection` process handlers call credential cleanup and `tasks.setResult(Failed)` before exiting

### Changed

- **P3.6 · Set-based env var tracking**: `EnvironmentVariableHelper.trackedVariables` switched from `string[]` to `Set<string>` for idempotent re-registration and cleaner cleanup

**162 tests passing** (150 TerraformTaskV5 + 12 TerraformInstallerV1)

## [0.7.2] — 2026-04-17

### Fixed

- **Installer**: detect 32-bit x86 agents via `os.arch() === "ia32"` (Node's actual value) in addition to the previously-matched `x32`; `ia32` path was unreachable before
- **task.json**: rename the `fileName` input on the `show` and `custom` commands to `filename` to match `tasks.getInput("filename")` in the handler. `show`/`custom` → file had silently produced no output file because the input name mismatched; matching Strings entries also renamed (#101)
- **task.json**: correct the `backendAzureRmUseCliFlagsForAuthentication` help text — schema default is `false`, not `true`; help now matches the default

### Documentation

- New `docs/migration-from-ms-devlabs.md`: task rename table, service-connection type renames, side-by-side install, input-rename notes
- README: command table now lists all **16** supported commands (added `import`, `forceunlock`, `refresh`); OCI providers row notes WIF is not yet supported; Differences-from-DevLabs table updated from 13 to 16 commands; link added to migration guide
- CONTRIBUTING: new **Terraform Plan Tab** section covering `src/tab/` layout, the `build:release` flow, webpack bundling, and the `package:self` private-publish loop
- `docs/troubleshooting.md`: document Azure auth-scheme case-insensitivity plus the AWS/GCP exact-match gotcha; clarify OIDC federated-token 30s-per-attempt timeout and 3-attempt retry; expand the multi-provider warning section (including the known substring false-positive)
- New `docs/roadmap.md`: 7-phase plan for April 2026 codebase review — correctness, docs drift, security hardening, test backfill, CI/CD hardening, architecture improvements, observability

### Chore

- Add `tsconfig.tsbuildinfo` to `.gitignore` and untrack the two previously-committed `tsconfig.tsbuildinfo` files
- Delete stale `IMPLEMENTATION_PLAN.md`

### Security

- Override `serialize-javascript` → `^7.0.0` (was 6.0.2 via mocha) — fixes RCE via `RegExp.flags` (high) and CPU exhaustion DoS (moderate) in both V5 and InstallerV1
- Override `diff` → `^8.0.3` (was 7.x via mocha) — fixes low-severity ReDoS advisory
- Bump `follow-redirects` via `npm audit fix` — fixes auth header leak on cross-domain redirects (moderate)
- Regenerate Tests lockfile to purge ghost `nock` → `lodash.set@4.3.2` dependency (prototype pollution, high)

## [0.7.1] — 2026-04-13

### Security

- **Secret masking**: `AWS_SECRET_ACCESS_KEY`, `ARM_OIDC_TOKEN`, `ARM_OIDC_REQUEST_TOKEN`, `ARM_CLIENT_SECRET`, and `TF_TOKEN_app_terraform_io` are now explicitly registered via `tasks.setSecret()` when set as environment variables — the `isSecret: true` flag was missing from all provider handler calls, risking accidental log exposure
- **`binaryName` input validation**: restrict accepted values to `terraform`, `tofu`, `terragrunt` — prevents arbitrary binary execution from pipeline task input

### Added

- `.github/CODEOWNERS` — `@sethbacon` owns all files; `.github/`, `configs/`, and `azure-devops-extension.json` require explicit owner review
- `.github/dependabot.yml` — weekly automated dependency updates for GitHub Actions and npm (TerraformTaskV5, TerraformInstallerV1, root)

### Changed

- `THIRD_PARTY_NOTICES.md`: add language tag to fenced code blocks

## [0.7.0] — 2026-04-09

### Added

- **Terraform Plan tab** in pipeline build results — displays plan output with ANSI color rendering, accessible from the build results view when the task is used
- **`publishPlanResults` input** on the `plan` command — set a plan name (e.g. `production`) to publish plan output as a pipeline attachment visible in the Terraform Plan tab
- Multi-plan selector dropdown when multiple plan steps publish results in the same pipeline run
- `THIRD_PARTY_NOTICES.md` — attribution for jason-johnson/azure-pipelines-tasks-terraform and JaydenMaalouf/azure-pipelines-terraform-output reference implementations
- New devDependencies: `azure-devops-extension-sdk`, `azure-devops-extension-api`, `react`, `react-dom`, `ts-loader`, `style-loader`, `css-loader`
- Tab webpack entry point with TypeScript and CSS loader support
- 1 new test: plan with `publishPlanResults` attachment publishing — **148 tests passing**

### Changed

- `azure-devops-extension.json`: added `terraform-plan-tab` build-results-tab contribution with `supportsTasks` filtering to V5 task GUID
- `webpack.config.js`: added tab entry point and `index.html` copy rule
- `plan()` method captures stdout via `execWithStdoutCapture` when `publishPlanResults` is set, writes to temp file, and publishes as `terraform-plan-results` attachment

## [0.6.1] — 2026-04-09

### Security

- **GPG signature verification**: HashiCorp downloads now verify `SHA256SUMS.sig` against embedded GPG public key (key ID `34365D9472D7468F`) before trusting SHA256 checksums — closes the #1 HIGH security finding across all code reviews
- Hard fail if `.sig` file is present but signature verification fails; graceful degradation if `.sig` unavailable (custom mirrors)
- InstallerV1 ESLint parity: enforce `no-floating-promises` and `return-await` as errors (matches V5)
- Fix floating promise in InstallerV1 entry point (`run()` → `void run()`)

### Added

- **`refresh` command** — dedicated drift detection with full provider auth, var-file, target, parallelism, secure var file, and terraform variables support
- **`varFile` multiline input** — first-class `-var-file` support (one path per line), visible for plan/apply/destroy/import/refresh
- **`targetResources` multiline input** — first-class `-target` support (one address per line), visible for plan/apply/destroy/refresh
- `openpgp@^6.0.1` dependency for OpenPGP detached signature verification
- `gpg-verifier.ts` module with `verifyGpgSignature()` function
- `hashicorp-gpg-key.ts` with embedded HashiCorp GPG public key
- `fetchBuffer()` in `http-client.ts` for binary content downloads
- `parseSha256()` extracted as pure function for testability
- Input validation: target resource addresses validated against Terraform address regex; parallelism validated as positive integer; replace address validated
- 8 new tests: refresh (2), var-file (1), target (1), GPG verification (3), total **158 tests** (147 V5 + 11 InstallerV1)

### Changed

- V5 TypeScript target upgraded from ES6 to ES2020 (Node 20 supports ES2022+)
- Both tasks now declare `engines.node >= 20` in `package.json`
- Refactor `appendTerraformVariables()` from string interpolation to `ToolRunner.arg()` for proper shell escaping
- `warnIfMultipleProviders()` now catches errors internally (non-fatal)
- `downloadZipFromHashiCorp()` fetches full SHA256SUMS content, verifies GPG signature, then parses hash
- GPG verifier mocked in all 8 existing installer tests to prevent openpgp module interference

### Fixed

- Fix double-space in JSON plan command options string
- Update 4 existing terraform variables test mocks for new `-var` arg ordering

## [0.5.2] — 2026-04-08

### Security

- Add output redaction warnings for sensitive Terraform plan data (`warnIfSensitiveOutputs`)
- Fix OCI private key chmod: platform-aware error handling (throws on Linux/macOS, skips gracefully on Windows)
- Strengthen OCI PAR URL validation: `new URL()` parsing plus expanded forbidden template patterns (`${`, `%{`, `$((`, backtick)
- Add exponential backoff retry logic to OIDC token requests (3 attempts, 200ms initial backoff)
- Mark secret environment variables with `tasks.setSecret()` via new `isSecret` parameter on `setEnvironmentVariable()`

### Added

- `terraformVariables` multiline input for direct `-var` support on plan, apply, destroy, and import commands
- Detect destroy changes in JSON plan output: sets `destroyChangesPresent` pipeline variable and emits warning
- Code coverage enforcement via `nyc` with thresholds: 75% lines/functions, 70% branches
- Troubleshooting guide (`docs/troubleshooting.md`) covering auth, terraform, installer, and agent issues
- New test coverage: import command, force-unlock command, OCI parity (6 tests), terraform variables, parallelism, lockfile-readonly, fmt diff, test filter/junit, show-to-file JSON with sensitive output detection — **143 tests passing**

### Changed

- CI Node.js version updated from 18 to 20 LTS
- ESLint rules escalated from warnings to errors; added `no-floating-promises` and `return-await`
- ESLint configs exclude `**/*.mjs` from type-checked linting
- Enhanced `task.json` help text with code examples and Terraform CLI docs links
- `.gitignore` updated to exclude `.nyc_output/` and `coverage/` directories

### Fixed

- Fix floating promise in `index.ts` (`run()` → `void run()`)
- Fix `return-await` lint violations across base handler and id-token-generator
## [0.5.1] — 2026-04-08

### Security

- Upgrade `azure-pipelines-task-lib` from `^4.1.0` to `^5.2.8` in both V5 and InstallerV1 — fixes minimatch ReDoS vulnerabilities (GHSA-3ppc-4f35-3m26, GHSA-7r86-cg39-jmmj, GHSA-23c5-xmqv-rm74)

### Fixed

- CI audit now uses `--omit=dev` and fails on production vulnerabilities instead of silently continuing
- Set `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` on release workflow to address Node.js 20 deprecation in `softprops/action-gh-release`
- Fix lint warnings: `let` → `const` in import command, eslint-disable for untyped securefiles-common require

## [0.5.0] — 2026-04-08

### Security

- Move credential temp files (AWS OIDC tokens, GCP credentials JSON, GCP WIF credentials, OCI key files) from working directory to `os.tmpdir()` — prevents accidental commit and reduces exposure window
- Add `.gitignore` patterns for credential file types (`credentials-*.json`, `gcp-wif-credentials-*.json`, `keyfile-*.pem`, `*.jwt`, `config-*.tf`, `output-*.json`, `.env`)
- Restrict OCI config file permissions with `fs.chmodSync(path, 0o600)` after write
- Change `backendHCPToken` input type from `string` to `password` for log masking

### Added

- **Backend WIF for AWS S3**: `backendAuthSchemeAWS` picker with `backendAWSRoleArn`, `backendAWSRegion`, `backendAWSSessionName` inputs — OIDC authentication for S3 backend during `init`
- **Backend WIF for GCP GCS**: `backendAuthSchemeGCP` picker with `backendGCPProjectNumber`, `backendGCPWorkloadIdentityPoolId`, `backendGCPWorkloadIdentityProviderId`, `backendGCPServiceAccountEmail` inputs — OIDC authentication for GCS backend during `init`
- **Secure variables file**: `secureVarsFile` input (type `secureFile`) for plan/apply/destroy/import — downloads `.tfvars` from ADO Secure Files library and passes as `-var-file=<path>` with automatic cleanup
- **Az login integration**: `runAzLogin` boolean for AzureRM provider — runs `az login` using service connection credentials (WIF/ServicePrincipal/MSI) before terraform commands for local-exec provisioners and external data sources
- **OpenTofu support**: `binaryName` picker (terraform/tofu) — all commands and provider detection use the selected binary
- **Import command**: `terraform import` with `importAddress` and `importId` inputs
- **Force-unlock command**: `terraform force-unlock` with `lockId` input
- Auto-set pipeline variables from `terraform output` as `TF_OUT_<key>` (sensitive outputs marked as secrets)
- Destroy change detection: `destroyChangesPresent` output variable set when `terraform show -json` contains resource deletions
- Implement previously-unused inputs: `refreshOnly` (plan/apply), `lockfileReadonly` (init), `parallelism` (plan/apply/destroy), `testJunitXmlPath` and `testFilter` (test), `fmtDiff` (fmt)
- Process signal handlers (`SIGTERM`/`SIGINT`) for emergency credential cleanup
- `outputTo` now visible for `custom` command (was only `show`)

### Changed

- **Installer modernization**: Replace `node-fetch` v2 + `https-proxy-agent` v5 with built-in `fetch()` + `undici.ProxyAgent`; extract mockable `http-client.ts` module
- Add `azure-pipelines-tasks-securefiles-common` dependency for Secure Files support
- Extract 7+ helper methods in base handler to reduce code duplication (`getWorkingDirectory`, `getServiceName`, `createAuthCommand`, `createBaseCommand`, `ensureAutoApprove`, `prependReplaceFlag`, `prependRefreshOnly`, `appendParallelism`, `appendSecureVarFile`)
- AWS backend credentials now use environment variables (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`) instead of `-backend-config` CLI args
- Update error message for tool-not-found to mention both terraform and tofu

### Fixed

- Update all GCP init test mocks to use `os.tmpdir()` credential paths
- Update all AWS init test mocks to remove exposed access_key/secret_key from exec strings
- Update all installer test mocks from `node-fetch` to `./http-client` module mocks

**134 tests passing** (126 TerraformTaskV5 + 8 TerraformInstallerV1)

## [0.4.1] — 2026-04-07

### Fixed

- Make `npm audit` CI step non-blocking (`continue-on-error`) — pre-existing `azure-pipelines-task-lib` vulnerability in `minimatch` requires a breaking upgrade to resolve

## [0.4.0] — 2026-04-07

### Security

- Mask GCP private key with `tasks.setSecret()` for log masking parity with OCI/AWS/HCP (#60)
- Validate OCI PAR URL: require HTTPS scheme, reject HCL interpolation sequences `${` / `%{` (#61)
- Set file permissions `0o600` on all credential temp files — PEM keys, JSON credentials, JWT tokens (#62)
- Throw error on unrecognized Azure auth scheme instead of silent ServicePrincipal fallback (#63)

### Changed

- Drop Node16 execution target from both tasks; Node20 is now the sole target (#67)

### Fixed

- Add `showFilePath` and `customFilePath` to `task.json` `outputVariables` for ADO UI discoverability (#65)

### Added

- `npm audit --audit-level=high` CI step for dependency vulnerability scanning (#64)
- Version consistency check script (`scripts/check-versions.js`) and CI job (#68)
- Test command coverage for AWS, GCP, OCI providers; custom command coverage for AWS (#66)
- Document standard test helper pattern in CONTRIBUTING.md (#69)

## [0.3.3] — 2026-04-07

### Fixed

- Replace `execSync` with `execAsync` for file output in `show()`, `output()`, `custom()`, and `warnIfMultipleProviders()` (#46)

### Changed

- Migrate 117 L0 test handler files to shared `runCommand()` helper, reducing ~1,600 lines of boilerplate (#44)

### Added

- OCI validate, show-to-console, and output test coverage (#45)

## [0.3.2] — 2026-04-07

### Security

- Mask OCI private key with `tasks.setSecret()` before processing (#30)
- Add OIDC URL guard (`SYSTEM_OIDCREQUESTURI` check) and error handling to `id-token-generator.ts` (#31, #32)
- Escape backslash and double-quote characters in OCI PAR URLs before embedding in generated HCL backend config (#42)

### Fixed

- Rewrite `id-token-generator.ts`: proper error handling for fetch, HTTP status checks, response validation (#31, #32)
- Add runtime validation for external JSON responses in installer (`fetchJson` guard) (#40)
- Use `tasks.loc()` for non-localized log string in installer (#39)
- Extract hardcoded fallback Terraform version to `FALLBACK_TERRAFORM_VERSION` constant (#38)
- Defer proxy config evaluation to download time in installer (#47)
- Mirror SHA256 skip now uses `tasks.warning()` instead of `console.warn()` (#33)

### Changed

- Upgrade `uuid` from v3 (`^3.4.0`) to v9 (`^9.0.1`), `@types/uuid` to `^9.0.8` across V5 and InstallerV1 (#35)
- Replace all loose equality (`==`, `!=`) with strict equality (`===`, `!==`) or truthiness checks (#36)
- Replace `var` declarations with `const`/`let` throughout (#37)
- Extract duplicated backend config loop from provider handlers into `BaseTerraformCommandHandler.applyBackendConfig()` (#41)
- Make `warnIfMultipleProviders()` async (#43)
- Resolve all 61 ESLint warnings: `prefer-const`, unused params (`_` prefix convention), unused imports
- Add `argsIgnorePattern`/`varsIgnorePattern` to ESLint `no-unused-vars` rule
- Delete `src/types.d.ts` ambient declaration shim (no longer needed with uuid v9)
- Update all 18 test mock registrations from `uuid/v4` to `uuid` module

### Chore

- Sync InstallerV1 `task.loc.json` with `task.json` (matching id, name, author, execution targets) (#34)

---

## [0.3.1] — 2026-04-07

### Refactored

- Replace `(handler as any)[command]()` dynamic dispatch with typed `executeCommand()` method on `BaseTerraformCommandHandler`; `parent-handler.ts` now calls `handler.executeCommand(command)` with no unsafe cast
- Remove `VALID_COMMANDS` whitelist array from `parent-handler.ts` — the dispatch map in `executeCommand()` IS the whitelist
- Standardize all provider handlers (AWS, GCP, OCI) to use `EnvironmentVariableHelper.setEnvironmentVariable()` instead of direct `process.env` assignment, consistent with the Azure handler
- Replace `var` with `const`/`let` throughout `azure-terraform-command-handler.ts`
- Type `TerraformToolHandler` constructor parameter from `any` to `typeof import('azure-pipelines-task-lib/task')`
- Wrap switch case blocks in braces in `azure-terraform-command-handler.ts` to satisfy `no-case-declarations` ESLint rule

### Dependencies

- Migrate ESLint 8 (`.eslintrc.json`) → ESLint 9 flat config (`eslint.config.mjs`) with `typescript-eslint@8` in both TerraformTaskV5 and TerraformInstallerV1
- Update CI lint step to drop `--ext .ts` flag (ESLint 9 uses config-based file filtering)
- Remove dead devDependencies: `@types/q` from TerraformTaskV5 and TerraformInstallerV1; `nock` from TerraformTaskV5 Tests
- Add `uuid@^9.0.1` as a direct dependency in TerraformTaskV5
- Regenerate `package-lock.json` for both tasks (lockfileVersion 3)

### Fixed

- Update TerraformInstallerV1 tests to use `runAsync()` — sync `run()` was removed in `azure-pipelines-task-lib@4.x`

### Tests

- Add 15 new test cases; total **117 tests passing (TerraformTaskV5)**
  - ShowTests: AWS show (console), GCP show (console)
  - OutputTests: AWS output, GCP output
  - WorkspaceTests: workspace new, workspace delete, workspace show
  - StateTests: state show, state mv, state rm, state pull
  - ApplyTests: AWS WIF apply, GCP WIF apply
  - DestroyTests: AWS WIF destroy, GCP WIF destroy

### Removed

- Delete TerraformTaskV1, V2, V3, V4 task directories
- Delete TerraformInstallerV0 task directory
- Delete Microsoft-internal `.azure-pipelines/` CI files (unusable from fork)

---

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
