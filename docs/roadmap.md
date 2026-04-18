# Roadmap

Sequenced plan to close gaps identified in the April 2026 codebase review. Each item is sized for a single PR off `development`. Effort: **S** = <½ day, **M** = ½–2 days, **L** = 2–5 days.

> **STATUS: COMPLETED** — All 7 phases delivered across v0.7.2 through v1.0.0. See [CHANGELOG.md](../CHANGELOG.md) for details by version.

---

## Phase 1 — Correctness bugs

**P1.1 · fix: filename input case mismatch** — `fix/filename-input-case` · S
- Rename [task.json](../Tasks/TerraformTask/TerraformTaskV5/task.json) input `fileName` → `filename` (matches `tasks.getInput("filename")` in `base-terraform-command-handler.ts`).
- Update the matching `loc.input.label.filename` / `loc.input.help.filename` keys in `Strings/resources.resjson/en-US/resources.resjson`.
- Acceptance: `show` and `custom` to-file flows produce the output file on a fresh pipeline.

**P1.2 · fix: 32-bit arch detection** — `fix/installer-ia32-arch` · S
- [terraform-installer.ts](../Tasks/TerraformInstaller/TerraformInstallerV1/src/terraform-installer.ts) `getArchString`: `os.arch()` returns `ia32` for 32-bit x86, not `x32`. Add `ia32` case (keep `x32` for belt-and-braces).
- Test: mock `os.arch()` exercising `ia32 → 386`.

**P1.3 · fix: contradictory help text default** — `fix/backend-cli-flags-helptext` · S
- [task.json](../Tasks/TerraformTask/TerraformTaskV5/task.json) `backendAzureRmUseCliFlagsForAuthentication`: help says "Defaults to true," schema default is `false`. Fix the help text.

**P1.4 · chore: prune build artifacts from VCS** — `chore/untrack-build-artifacts` · S
- Add `tsconfig.tsbuildinfo` to `.gitignore`.
- `git rm --cached` the two tracked `tsconfig.tsbuildinfo` files.
- Confirm `Tasks/**/*.js` is still excluded.

---

## Phase 2 — Documentation drift

**P2.1 · docs: README command table** — `docs/readme-command-completeness` · S
- Add `import`, `forceunlock`, `refresh` to the commands table in [README.md](../README.md).
- Mark OCI as not yet supporting Workload Identity Federation in the Providers table.
- Update the "Differences from Microsoft DevLabs" row `Commands` to `16`.

**P2.2 · docs: migration guide** — `docs/migration-from-ms-devlabs` · M
- New `docs/migration-from-ms-devlabs.md`: YAML rename table (`TerraformCLI@0` → `PipelineTerraformTask@5`, `TerraformInstaller@0` → `PipelineTerraformInstaller@1`), service connection type renames, side-by-side install instructions.
- Link from README.

**P2.3 · docs: plan tab contributor guide** — `docs/tab-dev-guide` · S
- New section in `CONTRIBUTING.md`: `npm run build:release` flow for the tab, how to load a dev build of the extension in an ADO test org, how webpack bundles `src/tab/`.

**P2.4 · docs: troubleshooting expansion** — `docs/troubleshooting-auth` · S
- Extend `docs/troubleshooting.md`: auth-scheme case sensitivity, OIDC token timeout behavior, interpreting the "multiple providers" warning.

---

## Phase 3 — Security hardening

**P3.1 · feat: strict-by-default GPG verification** — `feat/gpg-strict-mode` · M
- Add installer input `requireGpgSignature` (boolean; default `true` for `hashicorp`, `false` for `mirror`).
- [gpg-verifier.ts](../Tasks/TerraformInstaller/TerraformInstallerV1/src/gpg-verifier.ts): when required, throw on missing `.sig` instead of warning.
- Tests: `GpgSignatureRequiredButMissingFails.ts`; extend `GpgSignatureUnavailable` to cover both modes.

**P3.2 · feat: plan tab hardening** — `feat/tab-safety` · M
- [tabContent.tsx](../src/tab/tabContent.tsx) `ansiToHtml`: rewrite as a state machine that emits balanced `<span>` tags. Consider swapping for `ansi-to-html` (3 kB gz, well-tested).
- Add size cap: if attachment > 2 MB, render a warning + "Download raw" link (blob URL) instead of inline.
- Unit tests: balanced tags, mixed colors, oversized input fallback.

**P3.3 · feat: fail-closed on unknown auth scheme (AWS/GCP)** — `feat/aws-gcp-strict-auth-scheme` · S
- [aws-terraform-command-handler.ts](../Tasks/TerraformTask/TerraformTaskV5/src/aws-terraform-command-handler.ts), [gcp-terraform-command-handler.ts](../Tasks/TerraformTask/TerraformTaskV5/src/gcp-terraform-command-handler.ts): validate `environmentAuthSchemeAWS` / `environmentAuthSchemeGCP` against `["ServiceConnection","WorkloadIdentityFederation"]` and throw on anything else. Match AzureRM's stricter pattern.
- Tests: `AWSPlanInvalidAuthScheme.ts`, `GCPPlanInvalidAuthScheme.ts`.

**P3.4 · fix: token file permissions parity on Windows** — `fix/token-file-permissions` · S
- Wrap AWS/GCP OIDC token writes in the same try/catch + Windows ACL fallback as OCI.
- Extract a helper `writeSecretFile(path, content)` in a new `secure-temp.ts` so all three handlers share one implementation.

**P3.5 · feat: uncaughtException/unhandledRejection cleanup** — `feat/emergency-cleanup-hardening` · S
- [index.ts](../Tasks/TerraformTask/TerraformTaskV5/src/index.ts): hook `uncaughtException` and `unhandledRejection` in addition to SIGTERM/SIGINT; call `parentHandler.emergencyCleanup()` then `tasks.setResult(Failed)` then `process.exit(1)`.
- Mock-runner test: inject a throw after env vars are set, assert tracked vars are cleared.

**P3.6 · refactor: Set-based env var tracking** — `refactor/env-var-set` · S
- [environment-variables.ts](../Tasks/TerraformTask/TerraformTaskV5/src/environment-variables.ts): switch `trackedVariables: string[]` to `Set<string>`. Idempotent re-registration, cleaner debug output.
- Tests: `EnvironmentVariableHelperTests.ts` covering re-registration and clear.

**P3.7 · refactor: stricter provider detection** — `refactor/provider-detection-regex` · S
- `warnIfMultipleProviders` in base handler: replace substring `.includes(provider)` with a regex anchored to typical `terraform providers` output (e.g. `^\s*provider\[.*/(hashicorp|integrations)/<name>\]`).
- Tests cover false-positive case (module named `my-aws-helper`).

---

## Phase 4 — Test coverage backfill

**P4.1 · test: plan tab unit tests** — `test/tab-jest-harness` · M
- Add Jest + ts-jest to `src/tab/`. Test `ansiToHtml` edge cases, `loadPlans` network failure, empty state.
- Add as a third CI job in `unit-test.yml`.

**P4.2 · test: environment-variables** — `test/env-vars` · S
- Covers tracking, re-registration, secret marking, clear-all. Depends on P3.6.

**P4.3 · test: id-token-generator** — `test/id-token-generator` · M
- Mock `fetch`. Cover: happy path, 3 retries with backoff, timeout, missing `oidcToken` field, missing `SYSTEM_OIDCREQUESTURI`.

**P4.4 · test: output-variable pipeline logic** — `test/setoutputvariables` · M
- Extract `setOutputVariables`, `detectDestroyChanges`, `warnIfSensitiveOutputs` into a `plan-output-analyzer.ts` module for testability.
- Tests: sensitive-flagged outputs become ADO secret variables; destroy detection; missing `resource_changes`; malformed JSON.

**P4.5 · test: emergency cleanup signal handling** — `test/emergency-cleanup` · S
- Depends on P3.5. Exercise the SIGTERM path via a mock-runner scenario that kills mid-command.

**P4.6 · test: ParentCommandHandler unknown-provider path** — `test/parent-handler-errors` · S
- Mock-runner test feeding `provider: invalid` — asserts task fails with the expected error message.

**P4.7 · ci: coverage reporting** — `ci/coverage-nyc` · S
- New CI job: `npm run test:coverage` in each task dir, upload coverage to a GH artifact, add a coverage badge.
- Set a minimum threshold starting at the current measured %, ratchet up in later PRs.

**P4.8 · ci: lint extends to Tests/** — `ci/eslint-tests` · S
- `unit-test.yml`: `npx eslint src/ Tests/`. Fix any lint violations that surface.

---

## Phase 5 — CI/CD hardening

**P5.1 · ci: cross-platform matrix** — `ci/matrix-os-node` · M
- Convert `build-and-test-v5` and `build-and-test-installer-v1` to matrix jobs on `os: [ubuntu, windows, macos]`, `node: [20]`.
- Fix any Windows-specific test failures that surface (likely path separators in mock data).

**P5.2 · ci: audit level to moderate** — `ci/audit-moderate` · S
- `unit-test.yml`: `--audit-level=moderate`. Triage surfaced advisories before merging.

**P5.3 · ci: actionlint** — `ci/actionlint` · S
- Add an `actionlint` step to `unit-test.yml`. Pin the action to a SHA.

**P5.4 · ci: CodeQL** — `ci/codeql` · S
- Add `.github/workflows/codeql.yml` for TypeScript. Weekly schedule + on PR.

**P5.5 · ci: changelog guard** — `ci/release-changelog-guard` · S
- `release.yml`: verify `CHANGELOG.md` has an entry matching the tag version (grep `"^## \[?${TAG_VERSION}"`).

**P5.6 · ci: release via GH draft environment** — `ci/release-draft-first` · M
- Restructure `release.yml`: create **draft** GH release + upload vsix first; publish to Marketplace only after a manual "ready to publish" approval gate (GH environment protection rule). Undraft on publish success.
- Eliminates half-published state on partial failure.

**P5.7 · ci: SBOM + cosign signing** — `ci/sbom-cosign` · L
- Generate CycloneDX SBOM via `@cyclonedx/cyclonedx-npm` for each task's production deps.
- Sign the `.vsix` with cosign keyless (OIDC-backed).
- Attach SBOM + signature to the GH release.
- Aligns with the release-process initiative.

---

## Phase 6 — Architecture improvements

**P6.1 · feat: OpenTofu installer support** — `feat/tofu-installer` · M
- Add a `binary: terraform | tofu` input (or a new `downloadSource` that targets OpenTofu GitHub releases).
- Parameterize release-fetch URLs and binary naming.
- OpenTofu uses cosign instead of GPG — add a cosign verify path (optional behind a flag if cosign isn't available on the agent).
- New installer tests mirroring the Terraform ones.
- Align with the existing `terraform.ts` binary-name allowlist.

**P6.2 · feat: OCI Workload Identity Federation** — `feat/oci-wif` · L
- Implement [docs/initiatives/initiative-4-oci-wif.md](./initiatives/initiative-4-oci-wif.md).
- Add `environmentAuthSchemeOCI`, `ociTenancyOCID`, `ociRegion`, and related fields.
- Update README Providers table (removes the OCI-not-supported caveat added in P2.1).

**P6.3 · chore: freshen fallback Terraform version** — `chore/fallback-version-bump` · S
- [terraform-installer.ts](../Tasks/TerraformInstaller/TerraformInstallerV1/src/terraform-installer.ts) `FALLBACK_TERRAFORM_VERSION`: bump to latest known-good.
- Either a Dependabot-style recurring task or a release-workflow step that updates the constant (fetch latest HashiCorp release, commit on release tag).

**P6.4 · refactor: share resource-address regex** — `refactor/resource-address-regex` · S
- Extract the duplicated regex in `prependReplaceFlag` and `prependTargetResources` into a named constant. Add a unit test with valid and invalid addresses.

**P6.5 · refactor: remove dynamic require in cleanup** — `refactor/cleanup-no-dynamic-require` · S
- `base-terraform-command-handler.ts` `cleanupTempFiles`: reuse the top-level import instead of `require('./secure-file-loader')`.

**P6.6 · refactor: OCI PEM handling** — `refactor/oci-pem-parse` · M
- Replace the string replace-chain in `oci-terraform-command-handler.ts` `getPrivateKeyFilePath` with a proper PEM normalizer (split base64 body into 64-char lines, preserve header/footer). Validate with `crypto.createPrivateKey(...)` before writing.
- Tests: PKCS#8 key with literal `\n`, with spaces, with CRLF, malformed key rejected.

**P6.7 · refactor: upgrade React** — `refactor/react-18` · M
- Bump `react`/`react-dom` to 18, switch to `createRoot`. Verify the tab still renders in a static local harness.

**P6.8 · refactor: DRY commandOptions composition** — `refactor/command-options-pipeline` · M
- Build a `CommandOptionsBuilder` with explicit ordering to replace the hand-rolled `prependX`/`appendX` chains in `plan`, `apply`, `destroy`, `refresh`, `import`. Reduces drift.

---

## Phase 7 — Observability & polish

**P7.1 · feat: fallback-triggered telemetry** — `feat/installer-telemetry` · S
- When `FALLBACK_TERRAFORM_VERSION` fires or GPG verification is skipped, surface via `tasks.warning(...)` so it appears in the pipeline Warnings panel (already partial — audit for consistency).

**P7.2 · docs: pre-release inspection checklist** — `docs/release-checklist` · S
- New `docs/release-checklist.md`: manual pre-publish verification (install the draft `.vsix` into a test org, run through each command once).

---

## Dependencies & ordering

```
Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5 ──► Phase 6 ──► Phase 7
              (P2 parallel with P3)   (P4.2 after P3.6; P4.5 after P3.5)
                                              (P5 largely independent of P4)
```

Suggested sequencing with limited bandwidth:

1. **Week 1:** P1.1–P1.4, P2.1, P3.3, P3.5.
2. **Week 2:** P3.1, P3.2, P3.4, P3.6, P3.7, plus P4.2/P4.6.
3. **Week 3:** P4.1, P4.3, P4.4, P4.7; P5.1–P5.5.
4. **Week 4:** P5.6, P5.7, P6.3–P6.5, P2.2–P2.4.
5. **Longer tail:** P6.1 (OpenTofu), P6.2 (OCI WIF), P6.6–P6.8, P7.x.

## Release cuts

- After Phase 1 + 2: **v0.7.2** (patch — doc + bug fixes).
- After Phase 3: **v0.8.0** (minor — security hardening, auth-scheme validation, strict GPG).
- After Phase 4 + 5: **v0.9.0** (quality + release-pipeline uplift; SBOM, cosign).
- After Phase 6.1 + 6.2: **v1.0.0** (OpenTofu + OCI WIF — feature complete across providers).

Each phase boundary is a good squash-merge `development → main` + tag moment. Use the release checklist (P7.2) before each tag.
