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
```

Each task under `Tasks/` is an independent npm package — install dependencies in
the task directory you're changing before running `npm test` there for the
first time:

```bash
cd Tasks/<TaskName>/<TaskName>V<N>
npm install --include=dev
```

See the [Testing](#testing) section below for the full list of the 11 task
directories and their per-task test commands.

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

## Error messages

Two throw styles coexist across the tasks: `throw new Error(tasks.loc('Key', ...))` against a string defined in the task's `resources.resjson`, and a raw template-literal `throw new Error(\`...\`)`. Follow the predominant existing usage: use `tasks.loc()` for actionable, user-facing errors — invalid/missing input, a rejected value, a security-validation failure — where the message is fixed wording an operator needs to act on. Use a raw template literal when the error is wrapping a lower-level or technical detail that only makes sense interpolated inline — a caught exception's own `message`, an external tool's exit code or stdout/stderr, a dynamic path or URL under discussion. When in doubt, prefer `tasks.loc()` for anything a pipeline author will read and need to fix.

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

### PolicyAgentInstallerV1

```bash
cd Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1
npm run compile
npm test
```

### TerraformPolicyCheckV1

```bash
cd Tasks/TerraformPolicyCheck/TerraformPolicyCheckV1
npm run compile
npm test
```

### TerraformDriftReportV1

```bash
cd Tasks/TerraformDriftReport/TerraformDriftReportV1
npm run compile
npm test
```

### TerraformModulePublishV1

```bash
cd Tasks/TerraformModulePublish/TerraformModulePublishV1
npm run compile
npm test
```

### Markdown2HtmlV1

```bash
cd Tasks/Markdown2Html/Markdown2HtmlV1
npm run compile
npm test
```

### PublishKbArticleV1

```bash
cd Tasks/PublishKbArticle/PublishKbArticleV1
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

### Retry/backoff helper parity

Three tasks each implement their own bounded exponential-backoff HTTP retry helper, independently of one another and outside `scripts/check-shared-modules.js`'s automated byte-identity enforcement:

- `Tasks/TerraformModulePublish/TerraformModulePublishV1/src/http.ts` — `retryHttp()` (the reference implementation the other two mirror)
- `Tasks/TerraformDriftReport/TerraformDriftReportV1/src/callback.ts` — `postJsonWithRetry()`
- `Tasks/PublishKbArticle/PublishKbArticleV1/src/servicenow-http.ts` — `withRetry()`

All three share the same `{ retries?, baseDelayMs?, log? }` options shape and `baseDelayMs * 2 ** attempt` backoff. **When hardening the retry/backoff behavior (timeout, backoff formula, retry predicate, etc.) in any one of these, review the other two in the same change** and update them together if the hardening applies equally.

`callback.ts`'s `postJsonWithRetry()` deliberately diverges from the other two: it never retries after a *received* HTTP response, including a 5xx, and only retries transport-level failures. This is intentional, not an oversight — `TerraformDriftReport`'s TSM callback token is one-shot, so retrying after the server has already seen (and possibly consumed) the token risks a spurious duplicate-submission error on the retry rather than a real recovery. Keep this divergence when syncing the other two helpers' behavior into `callback.ts`.

## Terraform results tab (build-results-tab)

The extension contributes a **Terraform** tab (displayed name; the manifest's contribution id is `terraform-plan-tab`) to the Azure DevOps build results page, with Plan/Apply/State pivots. It reads the structured `terraform-plan-summary`/`terraform-apply-summary`/`terraform-state-summary` attachments plus the legacy `terraform-plan-results` (raw ANSI, `publishPlanResults: true`) as a fallback view.

### Source layout

```text
src/tab/
├── tabContent.tsx           # React entry point; registers the tab via SDK; Plan/Apply/State pivots
├── tabContent.css           # Tab styling
├── digest-model.ts          # Safe parse/validate of a fetched digest attachment into typed objects
├── digest-schema.ts         # Digest TypeScript shape — byte-identical copy of the task's src/results/digest-schema.ts
├── caps.ts                  # Size/DoS caps — byte-identical copy of the task's src/results/caps.ts
├── ansi-to-html.ts          # SGR-to-HTML converter used only by the raw fallback view
├── components/              # Presentational components (SummaryHeader, ResourceList, ResourceDiff, ApplyTimeline, OutputsPanel, DiagnosticsPanel, OverviewList, StateInventory, RawView)
├── security-tripwires.test.ts # CI-enforced static guard — see "When editing the tab" below
├── index.html               # HTML shell loaded by the ADO iframe
└── tsconfig.json            # TypeScript config used by webpack
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
6. Open the build results page — the **Terraform** tab appears alongside **Summary** / **Tests**. Iterate by rebuilding the `.vsix`, bumping the version in `configs/self.json`, and re-uploading.

### Contribution points (manifest)

The tab is declared in `azure-devops-extension.json` as a `ms.vss-build-web.build-results-tab` contribution and pulls its bundle from `tab/tabContent.js` (relative to the packaged extension root, which matches webpack's output layout).

### When editing the tab

- Run `npm run webpack` for fast iteration (skips re-running task compilation). Errors surface immediately in the webpack output.
- The bundle uses **React 18** with the `createRoot` API in `tabContent.tsx`.
- The tab uses `dangerouslySetInnerHTML` to render ANSI-converted HTML. Any change to `ansiToHtml` must keep opening/closing `<span>` tags balanced. A state-machine rewrite of the converter is the planned hardening here.
- `security-tripwires.test.ts` is a CI-enforced static guard: it fails the build if `dangerouslySetInnerHTML` JSX usage appears anywhere under `src/tab/` outside its two allowlisted files (`components/RawView.tsx`, `ansi-to-html.ts`), and separately if any file introduces a `fetch`/`XMLHttpRequest`/`WebSocket` call other than `tabContent.tsx`'s known ADO-attachment fetches. Keep both allowlists in sync with any legitimate change to where these sinks live.
- `src/tab/` has a Jest harness (`jest.config.js` at the repo root) — run it with `npm run test:tab`. It covers `ansi-to-html.test.ts` and `tabContent.test.tsx` (loading/error/empty states, multi-plan select, oversize-plan download link, `loadPlans` edge cases) and enforces coverage thresholds (statements 80%, branches 78%, functions 60%, lines 80%; see `jest.config.js` for the rationale behind those numbers). Run it alongside `npm run webpack` when changing the tab. It does not cover the module-level SDK bootstrap block (`SDK.ready().then(...)`) — that needs a real DOM/ADO iframe, so end-to-end verification of that wiring still requires a private publish.

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
   - `Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/task.json` — if TerraformDocsInstallerV1 changed
   - `Tasks/TerraformDocs/TerraformDocsV1/task.json` — if TerraformDocsV1 changed
   - `Tasks/Markdown2Html/Markdown2HtmlV1/task.json` — if Markdown2HtmlV1 changed
   - `Tasks/PublishKbArticle/PublishKbArticleV1/task.json` — if PublishKbArticleV1 changed

   Increment `Minor` by 1, leave `Patch` at 0.

   **Security rule (mandatory):** for any release, every task whose code was touched by a
   **security** issue in at least one of the release's PRs **must** have its `Minor` bumped in
   that release — never ship a security fix while agents keep serving the cached old code. When
   unsure whether a change qualifies, bump it.

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
