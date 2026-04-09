# Implementation Plan — Post-Review Improvements (v0.6.0+)

Based on the third comprehensive code review (April 8, 2026, grade 9.0/10).
Organized into release milestones. Each item references the review finding it addresses.

---

## Milestone 1: Security & Quality Hardening (v0.5.3)

Low-risk fixes that can ship immediately on `development`.

### 1.1 Call `clearTrackedVariables()` on task exit
- **Why:** Credential env vars (`AWS_SECRET_ACCESS_KEY`, `ARM_CLIENT_SECRET`, etc.) persist in the process after task completion. `EnvironmentVariableHelper.clearTrackedVariables()` exists but is never called.
- **Files:**
  - `Tasks/TerraformTask/TerraformTaskV5/src/parent-handler.ts` — add `EnvironmentVariableHelper.clearTrackedVariables()` to the `finally` block in `execute()`
- **Tests:** Add a test verifying env vars are cleaned up after execution
- **Risk:** Low

### 1.2 Move OCI backend config to `os.tmpdir()`
- **Why:** The generated `config-<uuid>.tf` is written to the user's `workingDirectory`, unlike all other credential-adjacent files which use `os.tmpdir()`. If init fails before cleanup, the PAR URL is left on disk.
- **Files:**
  - `Tasks/TerraformTask/TerraformTaskV5/src/oci-terraform-command-handler.ts:69` — change `path.resolve(workingDirectory/...)` to `path.join(os.tmpdir(), ...)`
  - Adjust `terraform init` execution to reference the new path (may need `-backend-config` approach or symlink)
- **Risk:** Medium — OCI backend config MUST be in the working directory for Terraform to discover it. Investigate `-backend-config` flag support for HTTP backend instead. If not possible, document as accepted risk.

### 1.3 InstallerV1 ESLint parity
- **Why:** V5 enforces `no-floating-promises` and `return-await` as errors; InstallerV1 does not. Unhandled promise rejections in the installer could go unnoticed.
- **Files:**
  - `Tasks/TerraformInstaller/TerraformInstallerV1/eslint.config.mjs` — add the two rules:
    ```js
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/return-await': 'error',
    ```
  - Fix any violations that surface
- **Risk:** Low

### 1.4 Remove unused `openpgp` dependency
- **Why:** Listed in InstallerV1 `package.json` but never imported. Increases bundle size and attack surface without providing value.
- **Files:**
  - `Tasks/TerraformInstaller/TerraformInstallerV1/package.json` — remove `openpgp` from dependencies
  - Regenerate `package-lock.json`
- **Note:** Re-add when GPG verification is implemented (milestone 3)
- **Risk:** Low

### 1.5 TypeScript target ES2020
- **Why:** V5 tsconfig targets `ES6` but executes on Node 20 (supports ES2022+). This limits language features and generates longer output.
- **Files:**
  - `Tasks/TerraformTask/TerraformTaskV5/tsconfig.json` — change `"target": "ES6"` to `"target": "ES2020"`
  - Run `npm run compile` and `npm test` to verify no regressions
- **Risk:** Low — Node 20 fully supports ES2020

### 1.6 Add `engines` field to package.json files
- **Why:** No minimum Node version declared; catches environment mismatches early.
- **Files:**
  - `Tasks/TerraformTask/TerraformTaskV5/package.json`
  - `Tasks/TerraformInstaller/TerraformInstallerV1/package.json`
  - Add: `"engines": { "node": ">=20" }`
- **Risk:** Low

---

## Milestone 2: Feature Parity (v0.6.0)

Features that close gaps vs jason-johnson and the Terraform CLI.

### 2.1 `refresh` command
- **Why:** HIGH priority missing command. Used for drift detection. jason-johnson supported it. Can be partially achieved via `plan -refresh-only` (already supported), but a dedicated command is clearer for users.
- **Implementation:**
  - `base-terraform-command-handler.ts` — add `refresh()` method:
    ```typescript
    public async refresh(): Promise<number> {
        const refreshCommand = this.createAuthCommand("refresh", this.getCommandOptions());
        const terraformTool = this.terraformToolHandler.createToolRunner(refreshCommand);
        await this.handleProvider(refreshCommand);
        return terraformTool.execAsync({ cwd: refreshCommand.workingDirectory });
    }
    ```
  - `base-terraform-command-handler.ts` — add `refresh` to `executeCommand()` dispatch map
  - `task.json` — add `refresh` to the `command` picklist values. Add `visibleRule` entries for refresh-specific inputs if needed.
  - Tests: Add `RefreshTests/` directory with Azure, AWS, GCP, OCI variants
- **Risk:** Low — follows the exact same pattern as every other command

### 2.2 First-class `-var-file` input
- **Why:** Currently only available via `secureVarsFile` (Secure Files library) or `commandOptions`. Users with regular `.tfvars` files in their repo must use `commandOptions`, which is undiscoverable.
- **Implementation:**
  - `task.json` — add `varFile` input (type `filePath`), visible for plan/apply/destroy/import
  - `base-terraform-command-handler.ts` — prepend `-var-file=<path>` to args when `varFile` is set
  - Support multiple files: allow `varFile` to be multiline (one path per line), each generates a `-var-file=` flag
- **Risk:** Low

### 2.3 First-class `-target` input
- **Why:** Resource targeting is common in pipelines for partial applies. Currently only via `commandOptions`.
- **Implementation:**
  - `task.json` — add `targetResources` input (type `multiLine`), visible for plan/apply/destroy/refresh
  - `base-terraform-command-handler.ts` — for each non-empty line, prepend `-target=<address>` to args. Validate each address against the same regex used for `replaceAddress`.
- **Risk:** Low

---

## Milestone 3: GPG Signature Verification (v0.6.1)

### 3.1 Verify SHA256SUMS.sig for HashiCorp downloads
- **Why:** #1 HIGH security finding across all three reviews. SHA256SUMS is verified but SHA256SUMS.sig is not checked. A compromised CDN could serve a tampered SHA256SUMS + binary pair.
- **Implementation:**
  - Add `openpgp@^6.0.1` back to InstallerV1 dependencies
  - Embed HashiCorp's GPG public key (key ID `72D7468F`) as a constant or bundled `.asc` file
  - New function `verifyGpgSignature(sha256SumsContent, signatureContent, publicKey)`:
    1. Fetch `terraform_<version>_SHA256SUMS.sig` alongside `SHA256SUMS`
    2. Use `openpgp.verify()` to validate the signature
    3. If verification fails, throw (hard fail — do not proceed)
    4. If `.sig` fetch fails (e.g., air-gapped mirror), fall through to SHA256-only with a warning
  - Call from `downloadZipFromHashiCorp()` before `verifySha256()`
- **Files:**
  - `Tasks/TerraformInstaller/TerraformInstallerV1/src/terraform-installer.ts`
  - `Tasks/TerraformInstaller/TerraformInstallerV1/src/gpg-verifier.ts` (new)
  - `Tasks/TerraformInstaller/TerraformInstallerV1/src/hashicorp-gpg-key.ts` (new — embedded public key)
- **Tests:**
  - Mock GPG verification success/failure
  - Mock missing `.sig` file (graceful degradation)
- **Risk:** Medium — openpgp is a large dependency. Test bundle size impact. Consider whether to block or warn on verification failure for mirrors.

---

## Milestone 4: Plan Visualization Tab (v0.7.0)

### 4.1 Pipeline tab extension for plan output
- **Why:** jason-johnson's `publishPlanResults` was its killer feature and biggest differentiator. With 39K orphaned installs from its unpublishing, this is the #1 feature to capture migrating users.
- **Implementation approach:**
  1. **Extension contribution:** Add a `ms.vss-build-web.build-results-tab` contribution to `azure-devops-extension.json` that renders a "Terraform Plan" tab in the pipeline run UI
  2. **Tab UI:** React component (or vanilla JS) that reads the plan JSON from a known artifact path and renders a diff view:
     - Resources to create (green)
     - Resources to update (yellow)
     - Resources to destroy (red)
     - Attribute-level changes with before/after values
     - Sensitive values redacted
  3. **Plan artifact publishing:** In `plan()` and `show()` commands, when output format is JSON:
     - Publish the JSON plan as a pipeline artifact (`tasks.uploadArtifact()`)
     - Set a well-known artifact name (e.g., `terraform-plan-<workspace>`)
     - The tab contribution reads from this artifact
  4. **Input:** Add `publishPlanResults` boolean input (default: false) to opt in
- **Files:**
  - `azure-devops-extension.json` — new contribution
  - `src/tab/` — new directory for tab UI code (TypeScript + HTML/CSS)
  - `base-terraform-command-handler.ts` — artifact publishing in plan/show
  - `task.json` — `publishPlanResults` input
  - `webpack.config.js` — bundle the tab UI
- **Research needed:**
  - Review jason-johnson's implementation for UX patterns: `https://github.com/jason-johnson/azure-pipelines-tasks-terraform/tree/main/tasks/terraform-cli/src/runners`
  - ADO extension SDK for pipeline tabs: `azure-devops-extension-sdk`
  - Size constraints on pipeline artifacts
- **Risk:** HIGH — largest feature; requires new UI code, extension SDK integration, and webpack bundling. Plan for 2-3 PRs: (a) artifact publishing, (b) tab skeleton, (c) diff rendering.

---

## Milestone 5: Test & Quality Improvements (ongoing)

### 5.1 Direct unit tests for handler methods
- **Why:** All 151 tests use mock-subprocess pattern. Logic bugs in handler methods (e.g., `setOutputVariables`, `detectDestroyChanges`, `warnIfSensitiveOutputs`) are not covered.
- **Implementation:**
  - Create `Tests/Unit/` directory
  - Import handler classes directly and test methods with mocked `tasks` module
  - Priority targets: `setOutputVariables()`, `detectDestroyChanges()`, `warnIfSensitiveOutputs()`, `appendParallelism()`, `prependReplaceFlag()`, `ensureAutoApprove()`
- **Risk:** Low

### 5.2 Cross-platform test mocking
- **Why:** All mocks target Windows/x64. Platform-specific bugs (chmod failures, path separators, binary extensions) go undetected.
- **Implementation:**
  - Add Linux and macOS variants for key test scenarios (init, plan, apply)
  - Mock `os.type()` and `os.arch()` in test helpers
- **Risk:** Low

### 5.3 Expand .nycrc.json coverage scope
- **Why:** `index.js`, `parent-handler.js`, `id-token-generator.js`, `secure-file-loader.js` are excluded from coverage. These contain critical logic.
- **Implementation:**
  - Remove exclusions from `.nycrc.json`
  - Add unit tests (5.1) to cover the newly-included files
  - May need to temporarily lower thresholds until tests are added
- **Risk:** Low

### 5.4 InstallerV1 coverage enforcement
- **Why:** Only V5 has nyc thresholds. InstallerV1 has 8 tests with no coverage gating.
- **Implementation:**
  - Add `.nycrc.json` to InstallerV1
  - Add `nyc` devDependency and `test:coverage` script
  - Set initial thresholds conservatively (e.g., 60% lines)
  - Add missing tests: registry latest resolution, proxy config, platform/arch mapping
- **Risk:** Low

---

## Milestone 6: Modernization & Long-term (v0.8.0+)

### 6.1 Go public on marketplace
- **Why:** `"public": false` in `azure-devops-extension.json` limits discovery. As the sole actively maintained option, going public captures organic search traffic.
- **Prerequisites:** All HIGH security findings resolved (GPG verification). Plan view tab shipped. README polished for marketplace presentation.
- **Risk:** Medium — public visibility means public scrutiny

### 6.2 `-json` output mode on plan/apply
- **Why:** Machine-readable output enables structured logging and downstream pipeline processing.
- **Implementation:** Add `outputFormat` picklist (default/json) to plan and apply commands. When json, pass `-json` flag and optionally capture to file.
- **Risk:** Low

### 6.3 `providers lock` command
- **Why:** Enterprise reproducibility for airgapped environments. Creates `.terraform.lock.hcl` with verified provider checksums.
- **Risk:** Low — standard command pattern

### 6.4 Public mutable fields to protected
- **Why:** `providerName`, `backendConfig`, `terraformToolHandler` are public mutable on `BaseTerraformCommandHandler`. Should be `protected readonly` to prevent accidental mutation.
- **Risk:** Low but touches all handler subclasses

### 6.5 Extract base handler into modules
- **Why:** `base-terraform-command-handler.ts` is 612 lines. Command implementations (lines 228-539) and pipeline variable helpers (543-611) could be separate modules.
- **Risk:** Medium — refactor touches the core file; needs careful testing

---

## Release Sequence

```
v0.5.3  Milestone 1 (security/quality hardening)
v0.6.0  Milestone 2 (refresh, -var-file, -target)
v0.6.1  Milestone 3 (GPG verification)
v0.7.0  Milestone 4 (plan visualization tab)
v0.8.0  Milestones 5+6 (tests, modernization, go public)
```

Each milestone maps to a single PR to `development`, then a release PR to `main` with tag.

---

## Competitive Context

| Extension                                     | Status (April 2026)                     | Your Advantage                                 |
| --------------------------------------------- | --------------------------------------- | ---------------------------------------------- |
| microsoft/azure-pipelines-terraform           | Stale (last push Feb 2026), 7 commands  | You: 15 commands, WIF, OpenTofu                |
| jason-johnson/azure-pipelines-tasks-terraform | **Unpublished** (39K installs orphaned) | You: only available option. Gap: plan view tab |
| hashicorp/setup-terraform                     | GitHub Actions only                     | Not a competitor in ADO                        |

**Strategic priority:** Milestone 4 (plan view tab) is the highest-impact feature for user acquisition. Milestones 1-3 should ship first to ensure the foundation is solid before going public.
