# Pipeline Tasks for Terraform

Install Terraform and run Terraform commands in Azure Pipelines. Supports Azure (AzureRM), AWS, GCP, and OCI providers with Workload Identity Federation (OIDC) authentication.

This is a fork of Microsoft's `ms-devlabs.custom-terraform-tasks` extension, published under a distinct extension ID and service connection types so it can be installed **side by side** with the original — no need to remove the Microsoft DevLabs extension to try this one. Beyond the original's feature set, it adds new commands, backend/provider decoupling, Workload Identity Federation for Azure, AWS, GCP, and OCI, flexible installer download sources, a structured Terraform results tab (Plan/Apply/State pivots, redacted), SARIF output for policy-check and drift-report, and security hardening. Teams migrating fully from the Microsoft DevLabs extension can follow the [step-by-step migration guide](https://github.com/sethbacon/azure-pipelines-terraform/blob/main/docs/migration-from-ms-devlabs.md).

This extension provides:

- **PipelineTerraformInstaller** -- Install a specific version of Terraform on the pipeline agent
- **PipelineTerraformProviderMirror** -- Configure Terraform to download providers from a network mirror instead of the public registry
- **PipelineTerraformTask** -- Execute Terraform commands with provider authentication and backend state management
- **PipelineTerraformModulePublish** -- Publish a module version to HCP Terraform or a private Terraform registry
- **PipelinePolicyAgentInstaller** -- Install a policy engine (OPA or Sentinel) on the pipeline agent
- **PipelineTerraformPolicyCheck** -- Evaluate OPA or Sentinel policies against Terraform plan JSON
- **PipelineTerraformDriftReport** -- Summarise plan-detected drift and optionally report it to Terraform State Manager
- **PipelineTerraformDocsInstaller** -- Install a specific version of terraform-docs on the pipeline agent
- **PipelineTerraformDocs** -- Generate Terraform module documentation with terraform-docs
- **Markdown2Html** -- Convert Markdown files to HTML for publishing as ServiceNow knowledge base articles
- **PublishKbArticle** -- Publish or update a knowledge base article in ServiceNow
- Service connections for AWS, GCP, and OCI accounts

Runs on **Windows**, **Linux**, and **macOS** agents.

## Key Features

- **Providers**: Azure (AzureRM), AWS, GCP, OCI
- **Commands**: init, validate, plan, apply, destroy, show, output, workspace, state, fmt, test, get, import, forceunlock, refresh, and custom (any Terraform CLI command)
- **Backend types**: azurerm, s3, gcs, oci, HCP Terraform Cloud, generic (any backend via config file), local
- **Workload Identity Federation (OIDC)** for Azure, AWS, GCP, and OCI
- **Flexible installer**: Download Terraform from HashiCorp releases, a private registry, or a custom mirror with SHA256 verification
- **Provider network mirroring**: Route provider downloads through a private mirror for air-gapped environments, caching, or compliance
- **Module publishing**: Publish module versions to HCP Terraform or a private registry (terraform-registry-backend) from a release pipeline
- **Documentation generation**: Install terraform-docs and generate — or `--output-check`-gate — Terraform module documentation in a pipeline
- **Documentation publishing**: Convert Markdown docs to HTML and publish them as ServiceNow knowledge base articles (idempotent create/update, image attachments) directly from a pipeline
- **`-replace` flag** support on plan and apply (modern replacement for the deprecated `taint` command)
- **Detailed exit code** on plan with `changesPresent` output variable for conditional apply
- **Terraform results tab**: a build-results tab with Plan/Apply/State pivots renders structured, redacted plan/apply/state summaries — sensitive values render as `(sensitive)` — alongside the legacy raw ANSI plan view
- **SARIF output**: PolicyCheck and DriftReport can emit a SARIF report for code-scanning / security dashboards
- **Optional service connection for `test`**: run unit tests without provider auth, or provide a service connection for integration tests that provision real resources

> **Download verification trust model:** Terraform and Sentinel downloads are verified against a GPG-signed `SHA256SUMS` (HashiCorp's pinned key); OpenTofu uses cosign keyless verification. OPA and terraform-docs publish no signature, so they are verified by their GitHub-release SHA256 checksum (same-origin — transport integrity, not independent authenticity), enforced fail-closed by default. See [SECURITY.md](SECURITY.md).

## Quick Start

### Install Terraform

Pin an explicit version for reproducible, supply-chain-hardened builds (recommended):

```yaml
- task: PipelineTerraformInstaller@1
  displayName: 'Install Terraform 1.11.3'
  inputs:
    terraformVersion: '1.11.3'
```

Or use `latest` to resolve the newest release at run time (convenient, but the resolved version *number* is only as trustworthy as the release oracle it comes from):

```yaml
- task: PipelineTerraformInstaller@1
  displayName: 'Install Terraform'
  inputs:
    terraformVersion: 'latest'
```

### Init, Plan, and Apply with AzureRM (Workload Identity Federation)

```yaml
- task: PipelineTerraformInstaller@1
  displayName: 'Install Terraform 1.11.3'
  inputs:
    terraformVersion: '1.11.3'

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

| Provider        | Method                       | Notes                                                                                                                                      |
| --------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Azure (AzureRM) | Workload Identity Federation | Preferred. OIDC-based, no stored secrets.                                                                                                  |
| Azure (AzureRM) | Managed Service Identity     | For self-hosted agents with MSI.                                                                                                           |
| Azure (AzureRM) | Service Principal            | Client ID + secret. Deprecated; use WIF instead.                                                                                           |
| AWS             | Service Connection           | Access key ID + secret access key via AWS service connection.                                                                              |
| AWS             | Workload Identity Federation | OIDC token exchange via `AWS_WEB_IDENTITY_TOKEN_FILE`. Requires IAM role with trust policy.                                                |
| GCP             | Service Connection           | Service account JSON key via GCP service connection.                                                                                       |
| GCP             | Workload Identity Federation | OIDC token exchange via external account credentials. Requires Workload Identity Pool.                                                     |
| OCI             | Service Connection           | Private key + user/tenancy OCIDs via OCI service connection.                                                                               |
| OCI             | Workload Identity Federation | OIDC token exchanged for a temporary User Principal Session Token (UPST) via OCI Identity Domains. Requires an Identity Propagation Trust. |

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

If `backendType` is not set, it defaults to the value of the `provider` input, preserving the original behaviour where the state backend matched the deployment provider.

## Output Variables

| Variable                  | Set by   | Description                                                                                                                                                            |
| ------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `changesPresent`          | `plan`   | `true` when the plan detects infrastructure changes (exit code 2 with `-detailed-exitcode`). Use in `condition:` to gate apply.                                        |
| `jsonPlanFilePath`        | `plan`   | File path to the plan's JSON output (`terraform show -json` equivalent), a policy-as-code integration hook for OPA/Sentinel-style tooling.                             |
| `jsonOutputVariablesPath` | `output` | File path to the JSON output of `terraform output -json`.                                                                                                              |
| `destroyChangesPresent`   | `show`   | `true` when a JSON `show` of a plan file contains resource deletions.                                                                                                  |
| `showFilePath`            | `show`   | File path when `outputTo` is set to `file`.                                                                                                                            |
| `customFilePath`          | `custom` | File path when `outputTo` is set to `file`.                                                                                                                            |
| `TF_OUT_<name>`           | `output` | Every Terraform output is auto-set as a pipeline variable named `TF_OUT_<output name>`, masked as secret only when the module declares that output `sensitive = true`. |

Reference output variables using the task `name` prefix: `$(taskName.changesPresent)`.

## Links

- **Source code**: [github.com/sethbacon/azure-pipelines-terraform](https://github.com/sethbacon/azure-pipelines-terraform)
- **Examples**: See [docs/yaml-examples.md](https://github.com/sethbacon/azure-pipelines-terraform/blob/main/docs/yaml-examples.md)
- **Contributing**: See [CONTRIBUTING.md](https://github.com/sethbacon/azure-pipelines-terraform/blob/main/CONTRIBUTING.md)
- **Changelog**: See [CHANGELOG.md](https://github.com/sethbacon/azure-pipelines-terraform/blob/main/CHANGELOG.md)

## Trademarks

Terraform is a registered trademark of HashiCorp. OpenTofu is a trademark of the Linux Foundation. This extension is an independent, community-maintained fork of [microsoft/azure-pipelines-terraform](https://github.com/microsoft/azure-pipelines-terraform) and is **not** affiliated with, endorsed by, or sponsored by HashiCorp, the Linux Foundation, or Microsoft. Amazon Web Services, Google Cloud, Oracle Cloud Infrastructure, and ServiceNow are trademarks of their respective owners; this project is not affiliated with, endorsed by, or sponsored by any of them. Product names are used under nominative fair use solely to describe compatibility.
