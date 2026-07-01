# Contributing

This document describes the development process for the **Pipeline Tasks for Terraform** extension (`sethbacon.pipeline-tasks-terraform`), a fork of Microsoft DevLabs' `azure-pipelines-terraform`.

## Attribution

Forked from [azure-pipelines-terraform](https://github.com/microsoft/azure-pipelines-terraform) by Microsoft DevLabs, licensed under MIT. The original Microsoft copyright notice is retained in `LICENSE`.

## Commit convention

All commits and PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
type: short description (50 chars max)
```

| Type       | When to use                                     |
| ---------- | ----------------------------------------------- |
| `feat`     | New Terraform command, provider, or auth scheme |
| `fix`      | Bug fix                                         |
| `docs`     | Documentation only                              |
| `refactor` | Restructure without changing behavior           |
| `perf`     | Performance improvement                         |
| `test`     | Adding or fixing tests                          |
| `ci`       | CI/CD workflow changes                          |
| `chore`    | Housekeeping                                    |
| `deps`     | Dependency updates                              |
| `security` | Security fix or hardening                       |

The PR title is what ends up in the changelog — write it as a clear, reader-facing statement.

## Prerequisites

- Node.js 24 (Active LTS — matches CI)
- npm 10+
- GitHub CLI (`gh`) — optional, useful for creating PRs

TypeScript (`tsc`) and `tfx-cli` are installed as dev dependencies; no global installation needed.

## Initial Setup

```bash
# Clone the fork
git clone https://github.com/sethbacon/azure-pipelines-terraform
cd azure-pipelines-terraform

# Install dependencies for TerraformTaskV5
cd Tasks/TerraformTask/TerraformTaskV5
npm install --include=dev

# Install dependencies for TerraformInstallerV1
cd ../../../Tasks/TerraformInstaller/TerraformInstallerV1
npm install --include=dev

# Install dependencies for TerraformProviderMirrorV1
cd ../../../Tasks/TerraformProviderMirror/TerraformProviderMirrorV1
npm install --include=dev
```

## Development workflow

1. Create a branch from `main`: `git checkout -b feat/my-feature`
2. Make your changes.
3. Run the local quality gate:

   ```bash
   # From the task directory you changed
   npm run compile   # zero TypeScript errors required
   npm test          # all tests must pass
   ```

4. Open a PR to `main` with a conventional-commit title.
5. CI runs automatically: version consistency check → build + test (Ubuntu + Windows × Node 24) → type-check tab → actionlint.
6. Squash-merge when CI passes and the PR is approved; the branch is deleted automatically.

## Testing

### TerraformTaskV5

```bash
cd Tasks/TerraformTask/TerraformTaskV5
npm test
```

This runs: `npm run compile:all && mocha --timeout 10000 --require ts-node/register Tests/L0.ts`

where `compile:all` = `compile` (`tsc -b tsconfig.json`) + `compile:tests` (`tsc -p tsconfig.tests.json`)

### TerraformInstallerV1

```bash
cd Tasks/TerraformInstaller/TerraformInstallerV1
npm run compile
npm test
```

### TerraformProviderMirrorV1

```bash
cd Tasks/TerraformProviderMirror/TerraformProviderMirrorV1
npm run compile
npm test
```

### TerraformDocsInstallerV1

```bash
cd Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1
npm run compile
npm test
```

### TerraformDocsV1

```bash
cd Tasks/TerraformDocs/TerraformDocsV1
npm run compile
npm test
```

### Test structure

Test files come in pairs under `Tests/`:

- `<Name>.ts` — mock runner setup and task input configuration
- `<Name>L0.ts` — mocha test using `MockTestRunner`

Tests are organized by command x provider: `InitTests/`, `PlanTests/`, `ApplyTests/`, `DestroyTests/`, etc.

When adding new commands or providers, add corresponding test pairs.

### Writing new tests

Use the helper pattern for all new tests:

**L0 file** (`<Name>L0.ts`): use `runCommand()` from `test-l0-helpers.ts`:

```typescript
import { TerraformCommandHandlerAWS } from './../../src/aws-terraform-command-handler';
import { runCommand } from '../test-l0-helpers';

runCommand(new TerraformCommandHandlerAWS(), 'plan', 'AWSPlanSuccessL0');
```

For failure tests, pass `false` as the fourth argument:

```typescript
runCommand(new TerraformCommandHandlerAWS(), 'init', 'AWSInitFailL0', false);
```

**Mock-setup file** (`<Name>.ts`): configure inputs, env vars, and mock answers, then call `tr.run()`.

**L0.ts registration**: add an `it()` block in the main `Tests/L0.ts` file near the other tests for the same command.

## Terraform Plan Tab (build-results-tab)

The extension contributes a **Terraform Plan** tab to the Azure DevOps build results page. The tab reads pipeline attachments named `terraform-plan-results` published by the `plan` command (when `publishPlanResults: true`) and renders the captured `terraform plan` output with ANSI color translated to HTML.

### Source layout

```text
src/tab/
├── tabContent.tsx      # React entry point; registers the tab via SDK
├── tabContent.css      # Tab styling
├── index.html          # HTML shell loaded by the ADO iframe
└── tsconfig.json       # TypeScript config used by webpack
```

The tab is bundled by `webpack.config.js` (at the repo root) alongside packaging of the manifest, images, and compiled task JS into `build/`.

### Build flow

From the repo root:

```bash
npm install --include=dev            # installs tfx-cli, webpack, ts-loader, glob-exec
npm run build:release                # clean → deps → compile tasks → prune dev deps → webpack
```

`build:release` does four things in order:

1. `clean` — removes `build/`.
2. `deps` — runs `npm install` in each task subdirectory.
3. `compile` — `tsc -b` each task's `tsconfig.json`.
4. `deps:prune` — removes dev dependencies from each task (trims the `.vsix`).
5. `webpack` — bundles `src/tab/tabContent.tsx` → `build/tab/tabContent.js`, copies the manifest, images, `overview.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, and `Tasks/` directory (excluding Tests/TS sources) into `build/`.

### Inspecting a dev build locally

Webpack emits to `build/tab/`. You can open `build/tab/tabContent.js` to confirm the bundle was generated, but the tab only renders inside the Azure DevOps iframe — there is currently no static browser harness. To exercise the tab in a real ADO org:

1. `configs/self.json` — see the **Personal Dev Publishing** section above for the schema. The file is gitignored.
2. `npm run build:release` then `npm run package:self` from the repo root — produces a private `.vsix` prefixed with your publisher.
3. Upload the `.vsix` to your publisher page as a **Private** extension and share it with a test Azure DevOps organization.
4. Install the shared extension into your test project.
5. Run a pipeline that uses `PipelineTerraformTask@5` with `command: plan` and `publishPlanResults: true`.
6. Open the build results page — the **Terraform Plan** tab appears alongside **Summary** / **Tests**. Iterate by rebuilding the `.vsix`, bumping the version in `configs/self.json`, and re-uploading.

### Contribution points (manifest)

The tab is declared in `azure-devops-extension.json` as a `ms.vss-build-web.build-results-tab` contribution and pulls its bundle from `tab/tabContent.js` (relative to the packaged extension root, which matches webpack's output layout).

### When editing the tab

- Run `npm run webpack` for fast iteration (skips re-running task compilation). Errors surface immediately in the webpack output.
- The bundle uses **React 18** with the `createRoot` API in `tabContent.tsx`.
- The tab uses `dangerouslySetInnerHTML` to render ANSI-converted HTML. Any change to `ansiToHtml` must keep opening/closing `<span>` tags balanced. A state-machine rewrite of the converter is the planned hardening here.
- There is no Jest harness in `src/tab/` yet (planned). Until then, end-to-end verification requires a private publish.

## Release process

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
| -------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `AZDO_PUBLISH_CLIENT_ID`   | Variable | Client ID of the Entra app whose federated credential publishes to the Marketplace |
| `AZDO_PUBLISH_TENANT_ID`   | Variable | Entra tenant ID for the publish login                                              |
| `RELEASE_DISPATCH_APP_ID`  | Variable | GitHub App client ID for release-please                                            |
| `RELEASE_DISPATCH_APP_KEY` | Secret   | GitHub App private key for release-please                                          |

The Marketplace publish uses **GitHub OIDC federated to Microsoft Entra** — there is no stored Marketplace PAT. The `release.yml` publish job runs under the `marketplace` environment with `id-token: write`, signs in via `azure/login` using `AZDO_PUBLISH_CLIENT_ID`/`AZDO_PUBLISH_TENANT_ID`, exchanges the OIDC token for a short-lived Entra access token, and passes it to `tfx extension publish`. The Entra app must have a federated credential whose subject is `repo:sethbacon/azure-pipelines-terraform:environment:marketplace`.

The `marketplace` environment (Settings → Environments) must have at least one required reviewer so every VS Marketplace publish gets human approval.

## Personal Dev Publishing

To test a private build in your own Azure DevOps org:

1. Navigate to the root folder of the repo
2. Create `configs/self.json` (this file is gitignored):

   ```json
   {
     "id": "pipeline-tasks-terraform-dev",
     "name": "Pipeline Tasks for Terraform (Dev)",
     "public": false,
     "publisher": "<your-publisher-id>",
     "version": "0.0.1"
   }
   ```

3. Run the build:

   ```bash
   npm install --include=dev
   npm run build:release
   npm run package:self
   ```

4. A `.vsix` file will be generated prefixed with your publisher name
5. Navigate to: `https://marketplace.visualstudio.com/manage/publishers/<your-publisher>`
6. Select `New extension` → `Azure DevOps`, drag and drop the `.vsix`, set visibility to **Private**
7. Share the extension with your Azure DevOps org via `...` → `Share/Unshare` → `+ Organization`
8. Install the extension in your org and test

## Publisher Information

- **Publisher ID:** `sethbacon`
- **Extension ID:** `pipeline-tasks-terraform`
- **Extension name:** `Pipeline Tasks for Terraform`
- **Marketplace URL:** `https://marketplace.visualstudio.com/items?itemName=sethbacon.pipeline-tasks-terraform`

The name complies with HashiCorp's trademark policy: nominative fair use of "Terraform" to accurately describe the extension's function, without implying official affiliation.
