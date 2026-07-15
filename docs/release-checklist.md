# Pre-Release Inspection Checklist

Manual verification steps to run before publishing a release to the VS Marketplace.

---

## 1. CI gate

- [ ] All CI checks pass on `main` (release-please opens the Release PR from `main`)
- [ ] Version in `azure-devops-extension.json` matches the intended tag (e.g. `1.0.0` for `v1.0.0`) — release-please sets this in the Release PR
- [ ] `CHANGELOG.md` has an entry for the release version (release-please generates this)
- [ ] **Minor bumps (mandatory):** every task whose `src/` changed since the last release tag has its `Minor` incremented in `task.json`. ADO agents cache tasks by `Major.Minor`, so a code (especially security) fix to an un-bumped task would ship to the Marketplace but never reach running agents. The release `guard` job enforces this via `scripts/check-minor-bumps.js`; run it locally too: `node scripts/check-minor-bumps.js` (defaults to comparing `HEAD` against the previous `v*` tag).
- [ ] **Sibling-fork scan (recurring):** skim recent commits/issues in [microsoft/azure-pipelines-terraform](https://github.com/microsoft/azure-pipelines-terraform) and [jason-johnson/azure-pipelines-tasks-terraform](https://github.com/jason-johnson/azure-pipelines-tasks-terraform) since the last release for auth- or security-relevant fixes or reports worth reviewing or backporting to this fork.

## 2. Build the `.vsix` locally

```bash
# From repo root
npm install --include=dev
npm run build:release
npm run package:release   # or package:self for a private test extension
```

- [ ] Build completes with zero errors
- [ ] `.vsix` file is produced in the repo root

## 3. Install in a test Azure DevOps organization

- [ ] Upload the `.vsix` to a test ADO org via **Organization Settings → Extensions → Browse local extensions → Upload**
- [ ] Extension installs without errors
- [ ] All eleven tasks appear: `PipelineTerraformInstaller@1`, `PipelineTerraformProviderMirror@1`, `PipelineTerraformTask@5`, `PipelineTerraformModulePublish@1`, `PipelinePolicyAgentInstaller@1`, `PipelineTerraformPolicyCheck@1`, `PipelineTerraformDriftReport@1`, `PipelineTerraformDocsInstaller@1`, `PipelineTerraformDocs@1`, `Markdown2Html@1`, and `PublishKbArticle@1`

## 4. Installer task smoke test

- [ ] `PipelineTerraformInstaller@1` with `binary: terraform`, `terraformVersion: latest` — installs and reports version
- [ ] `PipelineTerraformInstaller@1` with `binary: tofu`, `terraformVersion: latest` — installs and reports version
- [ ] `PipelineTerraformInstaller@1` with a pinned version (e.g. `1.14.8`) — installs correct version

## 4b. Provider mirror task smoke test

- [ ] `PipelineTerraformProviderMirror@1` with a valid mirror URL — generates `.terraformrc` and sets `TF_CLI_CONFIG_FILE`
- [ ] `PipelineTerraformProviderMirror@1` with `allowDirectFallback: false` — config contains only `network_mirror` block
- [ ] Subsequent `terraform init` downloads providers from the configured mirror

## 4c. Policy agent installer smoke test

- [ ] `PipelinePolicyAgentInstaller@1` with `policyAgent: opa`, `version: latest` — installs and reports version
- [ ] `PipelinePolicyAgentInstaller@1` with `policyAgent: sentinel`, `version: latest` — installs and reports version
- [ ] Output variables `policyAgentLocation` and `policyAgentDownloadedFrom` are set

## 4d. Policy check smoke test

- [ ] `PipelineTerraformPolicyCheck@1` with `engine: opa` against a plan JSON and a local policy directory — sets `policyResult`/`violationCount` and publishes JUnit results
- [ ] `PipelineTerraformPolicyCheck@1` with `engine: sentinel` — exit-code-driven enforcement maps correctly
- [ ] `policySource: git` clones the policy repo at the requested ref

## 4e. Drift report smoke test

- [ ] `PipelineTerraformDriftReport@1` with a plan JSON — reports drift counts and a changed-resource summary
- [ ] `failOnDrift: true` fails the task when drift is present
- [ ] With `callbackUrl` set (HTTPS), the summary POSTs to the TSM drift callback

## 4f. Module publish smoke test

- [ ] `PipelineTerraformModulePublish@1` with `registryType: private` — publishes a version to a terraform-registry-backend instance
- [ ] `PipelineTerraformModulePublish@1` with `registryType: hcp` — publishes a version to HCP Terraform / TFE
- [ ] `waitForPublish: true` blocks until the version is available (bounded by `timeoutSeconds`)

## 4g. terraform-docs installer smoke test

- [ ] `PipelineTerraformDocsInstaller@1` with `version: latest` — installs and reports version
- [ ] `PipelineTerraformDocsInstaller@1` with a pinned version (e.g. `0.20.0`) — installs correct version
- [ ] Output variables `terraformDocsLocation` and `terraformDocsDownloadedFrom` are set

## 4h. terraform-docs smoke test

- [ ] `PipelineTerraformDocs@1` with `formatter: markdown-table`, `outputFile: README.md` — writes documentation and sets `generatedFilePath`
- [ ] `PipelineTerraformDocs@1` with `outputCheck: true` against stale docs — fails the task

## 4i. Markdown2Html smoke test

- [ ] `Markdown2Html@1` on a sample `.md` — writes HTML and sets `htmlFilePath`
- [ ] Front matter (`title`, `includes`) is honored; an `includes:` entry outside the base directory is rejected
- [ ] A raw `<script>`, an `onerror=` handler, and a `javascript:`/non-image `data:` URI in the source are stripped by the sanitizer (inspect the generated HTML)

## 4j. PublishKbArticle smoke test

- [ ] `PublishKbArticle@1` with `dryRun: true` — reports the planned create/update without calling ServiceNow
- [ ] Create then update against a test ServiceNow instance — `kbArticleId`/`kbArticleNumber`/`kbWorkflowState` outputs are set
- [ ] HTML that fails validation (inline `<script>`, `on*` handler, `javascript:`/`data:` URI) is always rejected, regardless of `force` — only the content-loss heuristic (output retains too little of the input's length) is downgraded to a warning when `force: true`
- [ ] Image upload rewrites `<img src>` to ServiceNow attachments; a missing image fails unless `force: true`; a crafted `instance` value (not `^[a-z0-9-]+$`) is rejected

## 5. Core commands smoke test (AzureRM)

Use a minimal Terraform configuration with an AzureRM backend and provider.

- [ ] `init` — succeeds, backend is configured
- [ ] `validate` — succeeds
- [ ] `plan` — succeeds, `changesPresent` output variable is set
- [ ] `apply` — succeeds with `-auto-approve` injected
- [ ] `destroy` — succeeds with `-auto-approve` injected
- [ ] `show` — outputs to console
- [ ] `output` — writes JSON to file
- [ ] `fmt` — reports formatting status
- [ ] `workspace` — list/select/new work

## 6. Provider auth smoke test

- [ ] **AzureRM WIF** — `init` + `plan` with Workload Identity Federation
- [ ] **AWS** — `plan` with service connection credentials
- [ ] **GCP** — `plan` with service connection credentials
- [ ] **OCI** — `plan` with service connection credentials (API key)

## 7. Plan tab

- [ ] Run a `plan` with `publishPlanResults: <name>` — plan tab appears in build results
- [ ] Plan output renders correctly (ANSI colors, no truncation for reasonable-sized plans)

## 8. Tag and release (release-please)

Releases are automated by release-please — do NOT hand-tag.

- [ ] Conventional-commit PRs are merged to `main`; release-please accumulates them into a **Release PR** ("chore(main): release X.Y.Z") that bumps `azure-devops-extension.json` and updates `CHANGELOG.md`
- [ ] Before merging the Release PR, confirm the per-task `Minor` bumps (see section 1) — bump any missed task in the same PR
- [ ] Merge the Release PR — release-please pushes the `vX.Y.Z` tag automatically (the `guard` job fails the release if the tag version doesn't match `azure-devops-extension.json`)
- [ ] The `release.yml` workflow triggers on the tag: verifies the tag is on `main`, runs full CI + the Minor-bump check, builds the `.vsix`, generates SBOMs + cosign signature, and creates a draft GitHub release
- [ ] Approve the `marketplace` environment deployment when prompted
- [ ] Extension appears on the VS Marketplace with the correct version; the GitHub release is undrafted

## 9. Post-release

- [ ] Verify the extension installs correctly from the public marketplace in a fresh ADO org
