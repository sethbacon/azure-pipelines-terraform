# Pipeline Tasks for Terraform

Install Terraform and run Terraform commands in Azure Pipelines. Supports Azure (AzureRM), AWS, GCP, and OCI providers with Workload Identity Federation (OIDC) authentication.

This extension provides:

- **PipelineTerraformInstaller** -- Install a specific version of Terraform on the pipeline agent
- **PipelineTerraformTask** -- Execute Terraform commands with provider authentication and backend state management
- Service connections for AWS, GCP, and OCI accounts

Runs on **Windows**, **Linux**, and **macOS** agents.

## Key Features

- **Providers**: Azure (AzureRM), AWS, GCP, OCI
- **Commands**: init, validate, plan, apply, destroy, show, output, workspace, state, fmt, test, get, and custom (any Terraform CLI command)
- **Backend types**: azurerm, s3, gcs, oci, HCP Terraform Cloud, generic (any backend via config file), local
- **Workload Identity Federation (OIDC)** for Azure, AWS, and GCP
- **Flexible installer**: Download Terraform from HashiCorp releases, a private registry, or a custom mirror with SHA256 verification
- **`-replace` flag** support on plan and apply (modern replacement for the deprecated `taint` command)
- **Detailed exit code** on plan with `changesPresent` output variable for conditional apply

## Quick Start

### Install Terraform

```yaml
- task: PipelineTerraformInstaller@1
  displayName: 'Install Terraform'
  inputs:
    terraformVersion: 'latest'
```

To pin a specific version:

```yaml
- task: PipelineTerraformInstaller@1
  displayName: 'Install Terraform 1.11.3'
  inputs:
    terraformVersion: '1.11.3'
```

### Init, Plan, and Apply with AzureRM (Workload Identity Federation)

```yaml
- task: PipelineTerraformInstaller@1
  displayName: 'Install Terraform'
  inputs:
    terraformVersion: 'latest'

- task: PipelineTerraformTask@5
  displayName: 'Terraform Init'
  inputs:
    provider: 'azurerm'
    command: 'init'
    backendServiceArm: 'your-service-connection'
    backendAzureRmStorageAccountName: 'yourstorageaccount'
    backendAzureRmContainerName: 'tfstate'
    backendAzureRmKey: 'terraform.tfstate'

- task: PipelineTerraformTask@5
  name: terraformPlan
  displayName: 'Terraform Plan'
  inputs:
    provider: 'azurerm'
    command: 'plan'
    commandOptions: '-out tfplan'
    environmentServiceNameAzureRM: 'your-service-connection'

- task: PipelineTerraformTask@5
  displayName: 'Terraform Apply'
  condition: and(succeeded(), eq(variables['terraformPlan.changesPresent'], 'true'))
  inputs:
    provider: 'azurerm'
    command: 'apply'
    commandOptions: 'tfplan'
    environmentServiceNameAzureRM: 'your-service-connection'
```

## Authentication Methods

| Provider        | Method                       | Notes                                                                                       |
| --------------- | ---------------------------- | ------------------------------------------------------------------------------------------- |
| Azure (AzureRM) | Workload Identity Federation | Preferred. OIDC-based, no stored secrets.                                                   |
| Azure (AzureRM) | Managed Service Identity     | For self-hosted agents with MSI.                                                            |
| Azure (AzureRM) | Service Principal            | Client ID + secret. Deprecated; use WIF instead.                                            |
| AWS             | Service Connection           | Access key ID + secret access key via AWS service connection.                               |
| AWS             | Workload Identity Federation | OIDC token exchange via `AWS_WEB_IDENTITY_TOKEN_FILE`. Requires IAM role with trust policy. |
| GCP             | Service Connection           | Service account JSON key via GCP service connection.                                        |
| GCP             | Workload Identity Federation | OIDC token exchange via external account credentials. Requires Workload Identity Pool.      |
| OCI             | Service Connection           | Private key + user/tenancy OCIDs via OCI service connection.                                |

## Backend Types

The `backendType` input on `init` selects the state backend independently of the deployment provider.

| Backend Type | Description                                                   |
| ------------ | ------------------------------------------------------------- |
| `azurerm`    | Azure Blob Storage                                            |
| `s3`         | AWS S3                                                        |
| `gcs`        | Google Cloud Storage                                          |
| `oci`        | Oracle Cloud Infrastructure Object Storage (PAR URL)          |
| `hcp`        | HCP Terraform Cloud (organization + workspace)                |
| `generic`    | Any backend via `-backend-config` file or key=value arguments |
| `local`      | Local state file (no remote backend)                          |

If `backendType` is not specified, it defaults to `azurerm`. For backward compatibility, if `backendType` is not set in a pre-existing pipeline, it falls back to the value of `provider`.

## Output Variables

| Variable                  | Set by   | Description                                                                                                                     |
| ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `changesPresent`          | `plan`   | `true` when the plan detects infrastructure changes (exit code 2 with `-detailed-exitcode`). Use in `condition:` to gate apply. |
| `jsonOutputVariablesPath` | `output` | File path to the JSON output of `terraform output -json`.                                                                       |
| `showFilePath`            | `show`   | File path when `outputTo` is set to `file`.                                                                                     |
| `customFilePath`          | `custom` | File path when `outputTo` is set to `file`.                                                                                     |

Reference output variables using the task `name` prefix: `$(taskName.changesPresent)`.

## Links

- **Source code**: [github.com/sethbacon/azure-pipelines-terraform](https://github.com/sethbacon/azure-pipelines-terraform)
- **Contributing**: See [CONTRIBUTING.md](https://github.com/sethbacon/azure-pipelines-terraform/blob/main/CONTRIBUTING.md)
- **Changelog**: See [CHANGELOG.md](https://github.com/sethbacon/azure-pipelines-terraform/blob/main/CHANGELOG.md)
