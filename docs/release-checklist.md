# Pre-Release Inspection Checklist

Manual verification steps to run before publishing a release to the VS Marketplace.

---

## 1. CI gate

- [ ] All CI checks pass on the `development → main` PR
- [ ] Version in `azure-devops-extension.json` matches the intended tag (e.g. `1.0.0` for `v1.0.0`)
- [ ] `CHANGELOG.md` has an entry for the release version

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
- [ ] Both tasks appear: `PipelineTerraformInstaller@1` and `PipelineTerraformTask@5`

## 4. Installer task smoke test

- [ ] `PipelineTerraformInstaller@1` with `binary: terraform`, `terraformVersion: latest` — installs and reports version
- [ ] `PipelineTerraformInstaller@1` with `binary: tofu`, `terraformVersion: latest` — installs and reports version
- [ ] `PipelineTerraformInstaller@1` with a pinned version (e.g. `1.14.8`) — installs correct version

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

## 8. Tag and release

- [ ] Squash-merge `development → main`
- [ ] Tag the merge commit: `git tag vX.Y.Z origin/main && git push origin vX.Y.Z`
- [ ] Release workflow triggers automatically
- [ ] Draft GitHub release is created with `.vsix`, SBOM, and cosign signature
- [ ] Approve the `marketplace` environment deployment
- [ ] Extension appears on the VS Marketplace with the correct version

## 9. Post-release

- [ ] Sync `development` with `main`: merge `origin/main` into `development`
- [ ] Verify the extension installs correctly from the public marketplace in a fresh ADO org
