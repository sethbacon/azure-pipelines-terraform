# Contributing

This document describes the development process for the **Pipeline Tasks for Terraform** extension (`sethbacon.pipeline-tasks-terraform`), a fork of Microsoft DevLabs' `azure-pipelines-terraform`.

## Attribution

Forked from [azure-pipelines-terraform](https://github.com/microsoft/azure-pipelines-terraform) by Microsoft DevLabs, licensed under MIT. The original Microsoft copyright notice is retained in `LICENSE`.

## Prerequisites

- Node.js 18+ (LTS recommended; Node 18 is what CI uses)
- npm 9+
- GitHub CLI (`gh`) — optional, useful for creating PRs

TypeScript (`tsc`) and `tfx-cli` are installed as dev dependencies; no global installation needed.

## Initial Setup

```bash
# Clone the fork
git clone https://github.com/sethbacon/azure-pipelines-terraform
cd azure-pipelines-terraform

# Set up development branch tracking
git checkout development
git pull origin development

# Install dependencies for TerraformTaskV5
cd Tasks/TerraformTask/TerraformTaskV5
npm install --include=dev

# Install dependencies for TerraformInstallerV1
cd ../../../Tasks/TerraformInstaller/TerraformInstallerV1
npm install --include=dev
```

## Branch Strategy

- `main` — production-ready; tagged releases only; never force-pushed directly
- `development` — integration branch; all feature and fix PRs target this branch
- `feature/<description>` — created from `development`; deleted after merge
- `fix/<description>` — bug fix branches from `development`

**Never commit directly to `main`.** The only path to `main` is a PR from `development`.

## Commit Convention

Format: `type: short description` (50 chars max for title line)

Types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`

Include a body with the issue reference:

```text
feat: add registry download strategy to terraform installer

Closes #12
```

## Workflow for Each Change

1. Open a GitHub issue before writing code
2. Create a branch from `development`:

   ```bash
   git checkout development
   git pull origin development
   git checkout -b feature/<description>
   ```

3. Make your changes
4. Run the local quality gate:

   ```bash
   # From the task directory you changed
   npm run compile   # zero TypeScript errors required
   npm test          # all tests must pass
   ```

5. Rebase on `origin/development` before pushing:

   ```bash
   git rebase origin/development
   git push origin feature/<description>
   ```

6. Open a PR to `development` — include a `## Changelog` section in the PR body
7. Squash-merge when approved; delete the branch after merge

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

## Release Process

Releases are triggered by pushing a semver tag to `main`. The automated workflow handles packaging and publishing.

**Steps:**

1. Merge all intended changes to `development` via squash-merge PRs
2. Update `CHANGELOG.md` on `development` (collect entries from PR bodies)
3. Open a PR from `development` to `main` — title: `chore: release vX.Y.Z`
4. Squash-merge the PR
5. Tag the merge commit and push:

   ```bash
   git fetch origin
   git tag vX.Y.Z origin/main
   git push origin vX.Y.Z
   ```

6. The `.github/workflows/release.yml` workflow triggers automatically:
   - Verifies the tag is reachable from `main`
   - Runs CI (build + tests)
   - Builds the release bundle
   - Packages the `.vsix`
   - Publishes to the VS Marketplace (`sethbacon.pipeline-tasks-terraform`)
   - Creates a GitHub Release with the `.vsix` attached

**Required secret:** `TFX_PAT` must be set in repository Settings → Secrets → Actions. This is a VS Marketplace Personal Access Token with `Marketplace (publish)` scope for the `sethbacon` publisher.

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
