# Pipeline Tasks for Terraform

[![CI](https://github.com/sethbacon/azure-pipelines-terraform/actions/workflows/unit-test.yml/badge.svg)](https://github.com/sethbacon/azure-pipelines-terraform/actions/workflows/unit-test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An Azure DevOps extension for installing and running Terraform in build and release pipelines, supporting Azure, AWS, GCP, and OCI.

This is a fork of [microsoft/azure-pipelines-terraform](https://github.com/microsoft/azure-pipelines-terraform) (originally `ms-devlabs.custom-terraform-tasks`), published as **`sethbacon.pipeline-tasks-terraform`**. It adds new commands, backend/provider decoupling, Workload Identity Federation for AWS and GCP, flexible installer download sources, and security hardening. It is designed to be installed **side-by-side** with the Microsoft DevLabs extension — it uses a distinct extension ID and distinct service connection type names.

---

## Tasks

### `PipelineTerraformInstaller@1` — Terraform Tool Installer

Installs a specific version of Terraform on the build agent.

| Input                | Default     | Description                                                                                                            |
| -------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| `terraformVersion`   | `latest`    | Version to install, e.g. `1.9.0`. `latest` resolves to the current latest release.                                     |
| `downloadSource`     | `hashicorp` | Where to download Terraform from. See [Download Sources](#download-sources) below.                                     |
| `registryUrl`        | —           | Base HTTPS URL of a terraform-registry-backend instance. Required when `downloadSource=registry`.                      |
| `registryMirrorName` | `terraform` | Mirror name configured in the registry. Used when `downloadSource=registry`.                                           |
| `mirrorBaseUrl`      | —           | Base HTTPS URL of a custom mirror that replicates the HashiCorp path structure. Required when `downloadSource=mirror`. |

**Output variables:**

| Variable                  | Description                                                    |
| ------------------------- | -------------------------------------------------------------- |
| `terraformLocation`       | Path to the installed `terraform` binary.                      |
| `terraformDownloadedFrom` | Source used: `hashicorp`, `registry:<url>`, or `mirror:<url>`. |

#### Download Sources

| `downloadSource` | Description                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hashicorp`      | Official HashiCorp releases at `releases.hashicorp.com` (default).                                                                                       |
| `registry`       | Private [terraform-registry-backend](https://github.com/sethbacon/terraform-registry-backend) instance. Downloads include SHA256 integrity verification. |
| `mirror`         | Custom mirror URL that mirrors the HashiCorp release path structure. HTTPS required.                                                                     |

---

### `PipelineTerraformTask@5` — Terraform

Runs Terraform commands. Supports 16 commands:

| Command       | Description                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `init`        | Initialize a working directory. Configure backend with `backendType`.                          |
| `validate`    | Validate configuration files.                                                                  |
| `plan`        | Generate an execution plan. Use `replaceAddress` for `-replace=ADDRESS`.                       |
| `apply`       | Apply changes.                                                                                 |
| `destroy`     | Destroy infrastructure.                                                                        |
| `show`        | Show the current state or a saved plan.                                                        |
| `output`      | Read output values from state.                                                                 |
| `workspace`   | Manage workspaces (`new`, `select`, `list`, `delete`, `show`).                                 |
| `state`       | Advanced state management (`list`, `pull`, `push`, `mv`, `rm`, `show`).                        |
| `fmt`         | Reformat configuration files. Use `fmtCheck` to fail on unformatted files.                     |
| `test`        | Run module tests (Terraform 1.6+).                                                             |
| `get`         | Download and install modules.                                                                  |
| `import`      | Import existing infrastructure into state. Takes `importAddress` and `importId` inputs.        |
| `forceunlock` | Forcibly release a stuck state lock. Takes a `lockId` input.                                   |
| `refresh`     | Reconcile state with real-world resources. Supports `varFile`, `targetResources`, parallelism. |
| `custom`      | Run any Terraform command via `customCommand` input.                                           |

---

## Providers

| Provider | `provider` value | Service Connection Type                                      | Auth Methods                                     |
| -------- | ---------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| Azure    | `azurerm`        | Azure Resource Manager (built-in)                            | Service Principal, Managed Identity, WIF         |
| AWS      | `aws`            | Pipeline AWS for Terraform (`PTTAWSServiceEndpoint`)         | Static credentials, Workload Identity Federation |
| GCP      | `gcp`            | Pipeline GCP for Terraform (`PTTGoogleCloudServiceEndpoint`) | Static credentials, Workload Identity Federation |
| OCI      | `oci`            | Pipeline OCI for Terraform (`PTTOCIServiceEndpoint`)         | API key credentials (WIF not yet supported)      |

---

## Backend Types

The `backendType` input on the `init` command **decouples the Terraform state backend from the deployment provider**. This means you can, for example, store state in Azure Blob Storage while deploying to AWS, or use HCP Terraform Cloud with any provider.

If `backendType` is not set, it defaults to the value of the `provider` input (preserving the original behaviour).

| `backendType` | State Backend        | Notes                                                                                            |
| ------------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| `azurerm`     | Azure Blob Storage   | Uses `backendServiceArm` service connection.                                                     |
| `s3`          | AWS S3               | Uses `backendServiceAWS` service connection.                                                     |
| `gcs`         | Google Cloud Storage | Uses `backendServiceGCP` service connection.                                                     |
| `oci`         | OCI Object Storage   | Uses `backendServiceOCI` service connection.                                                     |
| `hcp`         | HCP Terraform Cloud  | Requires `backendHCPToken`, `backendHCPOrganization`, `backendHCPWorkspace`.                     |
| `generic`     | Any backend          | Pass a `.tfbackend` file via `backendConfigFile` and/or key=value pairs via `backendConfigArgs`. |
| `local`       | Local filesystem     | No remote state.                                                                                 |

---

## Service Connections

This extension registers its own service connection types so it can be installed alongside `ms-devlabs.custom-terraform-tasks` without conflicts.

| Connection | Internal Type Name              | Display Name               |
| ---------- | ------------------------------- | -------------------------- |
| AWS        | `PTTAWSServiceEndpoint`         | Pipeline AWS for Terraform |
| GCP        | `PTTGoogleCloudServiceEndpoint` | Pipeline GCP for Terraform |
| OCI        | `PTTOCIServiceEndpoint`         | Pipeline OCI for Terraform |

Azure uses the standard **Azure Resource Manager** service connection built into Azure DevOps.

> **Note:** These are different from the service connection types registered by the Microsoft DevLabs extension (`AWSServiceEndpoint`, `GoogleCloudServiceEndpoint`, `OCIServiceEndpoint`). If you are migrating from the MS DevLabs extension, you will need to create new service connections using the Pipeline types above.

---

## Workload Identity Federation

AWS and GCP support Workload Identity Federation — no static credentials are stored in the service connection. Azure DevOps issues an OIDC token that is exchanged for temporary cloud credentials at runtime.

- [AWS WIF Setup Guide](docs/setup/aws-wif-setup.md)
- [GCP WIF Setup Guide](docs/setup/gcp-wif-setup.md)

### AWS WIF — quick reference

```yaml
- task: PipelineTerraformTask@5
  inputs:
    provider: aws
    command: plan
    environmentServiceNameAWS: my-aws-service-connection
    environmentAuthSchemeAWS: WorkloadIdentityFederation
    awsRoleArn: arn:aws:iam::123456789012:role/TerraformRole
    awsRegion: us-east-1
    awsSessionName: terraform-pipeline
```

### GCP WIF — quick reference

```yaml
- task: PipelineTerraformTask@5
  inputs:
    provider: gcp
    command: plan
    environmentServiceNameGCP: my-gcp-service-connection
    environmentAuthSchemeGCP: WorkloadIdentityFederation
    gcpProjectNumber: "123456789"
    gcpWorkloadIdentityPoolId: azure-devops-pool
    gcpWorkloadIdentityProviderId: azure-devops-provider
    gcpServiceAccountEmail: terraform@my-project.iam.gserviceaccount.com
```

---

## Differences from Microsoft DevLabs Extension

|                                                | Microsoft DevLabs (`ms-devlabs.custom-terraform-tasks`)        | This fork (`sethbacon.pipeline-tasks-terraform`)                      |
| ---------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------- |
| Publisher                                      | `ms-devlabs`                                                   | `sethbacon`                                                           |
| Extension ID                                   | `custom-terraform-tasks`                                       | `pipeline-tasks-terraform`                                            |
| Terraform task name                            | `TerraformTaskV4` (YAML)                                       | `PipelineTerraformTask@5`                                             |
| Installer task name                            | `TerraformInstallerV0` (YAML)                                  | `PipelineTerraformInstaller@1`                                        |
| Commands                                       | 8 (init, validate, plan, apply, destroy, show, output, custom) | 16 — adds workspace, state, fmt, test, get, refresh, import, unlock   |
| `-replace` flag                                | Not available                                                  | `replaceAddress` input on `plan`                                      |
| Backend/provider coupling                      | Backend always matches provider                                | `backendType` input decouples them                                    |
| HCP Terraform Cloud backend                    | Not supported                                                  | Supported via `backendType: hcp`                                      |
| Generic backend                                | Not supported                                                  | Supported via `backendType: generic`                                  |
| Local backend                                  | Not supported                                                  | Supported via `backendType: local`                                    |
| AWS auth                                       | Static credentials only                                        | Static credentials + Workload Identity Federation                     |
| GCP auth                                       | Static credentials only                                        | Static credentials + Workload Identity Federation                     |
| Installer download                             | HashiCorp only                                                 | HashiCorp, private registry (with SHA256 verification), custom mirror |
| AWS service connection type                    | `AWSServiceEndpoint`                                           | `PTTAWSServiceEndpoint`                                               |
| GCP service connection type                    | `GoogleCloudServiceEndpoint`                                   | `PTTGoogleCloudServiceEndpoint`                                       |
| OCI service connection type                    | `OCIServiceEndpoint`                                           | `PTTOCIServiceEndpoint`                                               |
| Azure backend resource group/storage dropdowns | Dynamic API lookups                                            | Free-text strings                                                     |
| Side-by-side install                           | N/A                                                            | Yes — distinct extension ID and service connection types              |

---

## Agent Compatibility

Tasks run on Windows, macOS, and Linux build agents using Node 20.

---

## Migrating from Microsoft DevLabs

See [docs/migration-from-ms-devlabs.md](docs/migration-from-ms-devlabs.md) for a step-by-step guide: task renames, service connection type changes, and side-by-side install instructions.

---

## Troubleshooting

See [docs/troubleshooting.md](docs/troubleshooting.md) for solutions to common issues with authentication, backend configuration, installer errors, and agent setup.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch strategy, commit conventions, local development setup, and the release process.

See [CHANGELOG.md](CHANGELOG.md) for the full history of changes since the fork.

---

## License

MIT. Originally authored by [Microsoft Corporation](https://github.com/microsoft/azure-pipelines-terraform). Fork maintained by [sethbacon](https://github.com/sethbacon).
