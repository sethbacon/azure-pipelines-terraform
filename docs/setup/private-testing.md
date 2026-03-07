# Private Testing in Azure DevOps

This guide covers how to build, publish, and test the extension privately in your own Azure DevOps organization before releasing publicly.

## Publisher Registration (one-time)

**Domain verification is not required.** You only need a Microsoft account.

1. Navigate to: `https://marketplace.visualstudio.com/manage/createpublisher`
2. Sign in with a Microsoft account (personal or work)
3. Enter publisher ID: `sethbacon`
4. Accept the Marketplace Publisher Agreement
5. Click **Create**

## Get a Marketplace PAT (one-time)

This PAT is used both for the automated release workflow and for manual publishing via CLI.

1. Go to `https://marketplace.visualstudio.com` and sign in
2. Click your profile icon → **Security**
3. Click **New Token**
4. Set **Organization** to `All accessible organizations`
5. Set **Scopes** → select **Marketplace** → check **Publish**
6. Copy the token — you will not see it again

This is the same token stored as the `TFX_PAT` GitHub Actions secret.

## Build and Package (each dev cycle)

From the repo root:

```bash
npm install --include=dev
npm run build:release
npm run package:dev
```

This produces a `.vsix` file named `sethbacon.pipeline-tasks-terraform-dev-<version>.vsix`.

The dev package uses [configs/dev.json](../../configs/dev.json):

- **Extension ID:** `pipeline-tasks-terraform-dev` (different from the public ID)
- **Name:** `Pipeline Tasks for Terraform (Dev)`
- **Visibility:** Private

Using a separate extension ID means the dev and public extensions coexist independently in your org — you can have both installed at the same time if needed.

## Publish Privately

### Option A: Upload via web UI

1. Navigate to: `https://marketplace.visualstudio.com/manage/publishers/sethbacon`
2. Click **New extension** → **Azure DevOps**
3. Drag and drop the `.vsix` file
4. Confirm visibility is **Private**
5. Click **Upload**

For subsequent updates, click `...` next to the extension → **Update** → upload the new `.vsix`.

### Option B: Publish via CLI

```bash
# First publish
npx tfx-cli extension publish \
  --vsix sethbacon.pipeline-tasks-terraform-dev-*.vsix \
  --token <your-marketplace-PAT>

# Update (subsequent publishes auto-increment the version with --rev-version, or just re-upload)
npx tfx-cli extension publish \
  --vsix sethbacon.pipeline-tasks-terraform-dev-*.vsix \
  --token <your-marketplace-PAT>
```

## Share with Your Azure DevOps Organization

Private extensions must be explicitly shared before they can be installed.

1. On the publisher page, click `...` next to the dev extension → **Share/Unshare**
2. Click **+ Organization**
3. Enter your Azure DevOps organization name (the part after `dev.azure.com/`)
4. Click **Share**

## Install in Your Organization

1. Go to your Azure DevOps organization
2. Navigate to: `https://dev.azure.com/<your-org>/_settings/extensions`
3. Click **Browse marketplace**
4. Search for `Pipeline Tasks for Terraform (Dev)` — it will appear because it is shared with your org
5. Click **Get it free** → **Install**

Alternatively, install directly from the publisher portal:
`https://marketplace.visualstudio.com/items?itemName=sethbacon.pipeline-tasks-terraform-dev`

## Verify the Installation

In a pipeline, reference the task by its version:

```yaml
- task: TerraformTaskV5@5
  inputs:
    provider: 'azurerm'
    command: 'validate'
    workingDirectory: '$(System.DefaultWorkingDirectory)'
```

The task picker in the Azure DevOps UI will show the dev extension alongside any other installed versions.

## Cleanup

When done testing, you can uninstall the dev extension from your org without affecting the public extension:

1. Go to `https://dev.azure.com/<your-org>/_settings/extensions`
2. Find `Pipeline Tasks for Terraform (Dev)` → **Uninstall**
