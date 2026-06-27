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

### `PipelineTerraformProviderMirror@1` — Provider Mirror Configuration

Configures Terraform to download providers from a network mirror instead of the public registry. Generates a `.terraformrc` file and sets `TF_CLI_CONFIG_FILE` for subsequent tasks.

| Input                   | Default | Description                                                                                        |
| ----------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `mirrorUrl`             | —       | Base HTTPS URL of the network mirror for provider downloads.                                       |
| `allowDirectFallback`   | `true`  | Allow Terraform to fall back to direct registry download if the mirror doesn't have a provider.    |
| `directExcludePatterns` | —       | Provider patterns to exclude from direct download (one per line). Forces these through the mirror. |
| `directIncludePatterns` | —       | Provider patterns to include for direct download (one per line). Only these can bypass the mirror. |

**Output variables:**

| Variable         | Description                                         |
| ---------------- | --------------------------------------------------- |
| `configFilePath` | Path to the generated `.terraformrc` configuration. |

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
| `test`        | Run module tests (Terraform 1.6+). Service connection is optional (see below).                 |
| `get`         | Download and install modules.                                                                  |
| `import`      | Import existing infrastructure into state. Takes `importAddress` and `importId` inputs.        |
| `forceunlock` | Forcibly release a stuck state lock. Takes a `lockId` input.                                   |
| `refresh`     | Reconcile state with real-world resources. Supports `varFile`, `targetResources`, parallelism. |
| `custom`      | Run any Terraform command via `customCommand` input.                                           |

---

### `PipelineTerraformModulePublish@1` — Module Publisher

Publishes a module version to HCP Terraform / Terraform Enterprise or a private Terraform registry (`terraform-registry-backend`) from a release pipeline.

| Input              | Default                  | Description                                                                                  |
| ------------------ | ------------------------ | -------------------------------------------------------------------------------------------- |
| `registryType`     | `private`                | `private` (terraform-registry-backend) or `hcp` (HCP Terraform / TFE).                       |
| `namespace`        | —                        | Module namespace.                                                                            |
| `name`             | —                        | Module name.                                                                                 |
| `provider`         | —                        | Provider / target system the module is for.                                                  |
| `version`          | —                        | Semantic version to publish.                                                                 |
| `registryUrl`      | —                        | Base HTTPS URL of the private registry. Required when `registryType=private`.                |
| `apiKey`           | —                        | Private-registry API key. Treat as a secret variable.                                        |
| `hcpAddress`       | `https://app.terraform.io` | HCP Terraform / TFE address. Used when `registryType=hcp`.                                  |
| `hcpToken`         | —                        | HCP API token. Treat as a secret variable. Used when `registryType=hcp`.                      |
| `waitForPublish`   | `true`                   | Poll until the version is available before completing.                                        |
| `timeoutSeconds`   | `180`                    | Wall-clock bound for `waitForPublish`.                                                        |

HCP VCS-backed publishing also accepts `vcsRepoIdentifier`, `vcsBranch`, `vcsOauthTokenId`, and `commitSha`.

---

### `PipelinePolicyAgentInstaller@1` — Policy Agent Installer

Installs a policy engine — **OPA** (sha256-verified binary from the `open-policy-agent/opa` GitHub releases) or **Sentinel** (GPG-signed zip from `releases.hashicorp.com`) — and prepends it to the `PATH`.

| Input                 | Default    | Description                                                                                      |
| --------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| `policyAgent`         | `opa`      | `opa` or `sentinel`.                                                                              |
| `version`             | `latest`   | Version to install. `latest` resolves via the GitHub releases (OPA) or checkpoint (Sentinel) API. |
| `downloadSource`      | `official` | `official`, `registry` (terraform-registry-backend), or `mirror` (custom HTTPS mirror).          |
| `requireGpgSignature` | `true`     | Fail if a Sentinel GPG signature is unavailable.                                                  |
| `requireChecksum`     | `true`     | Fail if a SHA256 checksum is unavailable.                                                         |

**Output variables:** `policyAgentLocation`, `policyAgentDownloadedFrom`. OPA ships `amd64`/`arm64` only.

---

### `PipelineTerraformPolicyCheck@1` — Policy Check

Evaluates **OPA** or **Sentinel** policies against Terraform plan JSON (`terraform show -json` output) and gates the pipeline on the result.

| Input                     | Default          | Description                                                                                   |
| ------------------------- | ---------------- | --------------------------------------------------------------------------------------------- |
| `engine`                  | `opa`            | `opa` or `sentinel`.                                                                           |
| `inputFile`               | —                | Path to the plan JSON to evaluate.                                                             |
| `policySource`            | `path`           | `path` (local directory) or `git` (HTTPS shallow clone / ref checkout).                        |
| `policyPath`              | —                | Policy directory when `policySource=path`.                                                     |
| `policyRepoUrl`           | —                | Policy repo URL when `policySource=git`. Pairs with `policyRepoRef`/`policyRepoSubdir`/`policyRepoToken`. |
| `decisionPath`            | `terraform/deny` | OPA decision path to query.                                                                    |
| `failMode`                | `nonEmpty`       | OPA gate: fail when the decision is `nonEmpty` or `defined`.                                    |
| `defaultEnforcementLevel` | `soft-mandatory` | Sentinel enforcement level (`advisory`/`soft-mandatory`/`hard-mandatory`).                     |
| `publishTestResults`      | `true`           | Publish a JUnit results file to the pipeline **Tests** tab.                                     |

**Output variables:** `policyResult`, `violationCount`, `resultsFilePath`.

---

### `PipelineTerraformDriftReport@1` — Drift Report

Parses a Terraform/OpenTofu plan JSON into drift counts plus a changed-resource summary, and optionally POSTs the summary to a [Terraform State Manager](https://github.com/sethbacon/terraform-state-manager) (TSM) drift callback.

| Input                | Default                              | Description                                                                  |
| -------------------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| `planJsonFile`       | —                                    | Path to the plan JSON to analyse.                                            |
| `includeModuleProvenance` | `true`                          | Include module source provenance from the module manifest.                  |
| `moduleManifest`     | `.terraform/modules/modules.json`    | Module manifest path used for provenance.                                    |
| `failOnDrift`        | `false`                              | Fail the task when drift is detected.                                        |
| `callbackUrl`        | —                                    | TSM drift-callback URL. Must be HTTPS.                                       |
| `callbackToken`      | —                                    | TSM callback bearer token. Treat as a secret variable.                       |
| `rejectUnauthorized` | `true`                               | Verify the callback endpoint's TLS certificate (leave enabled in production). |

---

## Providers

| Provider | `provider` value | Service Connection Type                                      | Auth Methods                                      |
| -------- | ---------------- | ------------------------------------------------------------ | ------------------------------------------------- |
| Azure    | `azurerm`        | Azure Resource Manager (built-in)                            | Service Principal, Managed Identity, WIF          |
| AWS      | `aws`            | Pipeline AWS for Terraform (`PTTAWSServiceEndpoint`)         | Static credentials, Workload Identity Federation  |
| GCP      | `gcp`            | Pipeline GCP for Terraform (`PTTGoogleCloudServiceEndpoint`) | Static credentials, Workload Identity Federation  |
| OCI      | `oci`            | Pipeline OCI for Terraform (`PTTOCIServiceEndpoint`)         | API key credentials, Workload Identity Federation |

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
| Provider mirror task                           | Not available                                                  | `PipelineTerraformProviderMirror@1`                                   |
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

## Service Connection Requirements by Command

Most commands that interact with cloud resources require a provider service connection. The following commands **do not** require one:

| Command       | Service Connection | Notes                                                                                                                                                                                                                   |
| ------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`        | Backend only       | Uses the backend service connection (e.g. `backendServiceArm`), not the provider connection. `backendType: local` needs no connection at all.                                                                           |
| `validate`    | Not required       | Validates configuration syntax and internal consistency.                                                                                                                                                                |
| `fmt`         | Not required       | Checks or applies formatting.                                                                                                                                                                                           |
| `get`         | Not required       | Downloads modules referenced in configuration.                                                                                                                                                                          |
| `workspace`   | Not required       | Manages local workspace state.                                                                                                                                                                                          |
| `state`       | Not required       | Local state operations.                                                                                                                                                                                                 |
| `forceunlock` | Not required       | Releases a stuck state lock.                                                                                                                                                                                            |
| `test`        | **Optional**       | Unit/validation tests run without auth. Integration tests that provision real resources (test files with `run` blocks using `command = apply`) need a service connection — provide it in YAML and the task will use it. |

All other commands (`plan`, `apply`, `destroy`, `show`, `output`, `import`, `refresh`, `custom`) require a provider service connection.

### Running `terraform test` without a service connection

```yaml
# Unit/validation tests — no service connection needed
- task: PipelineTerraformTask@5
  displayName: 'Terraform Test'
  inputs:
    provider: aws          # still required (selects handler)
    command: test
```

### Running `terraform test` with a service connection

```yaml
# Integration tests that provision real resources
- task: PipelineTerraformTask@5
  displayName: 'Terraform Test (integration)'
  inputs:
    provider: aws
    command: test
    environmentServiceNameAWS: my-aws-connection
```

---

## Agent Compatibility

Tasks run on Windows, macOS, and Linux build agents using Node 24.

---

## Migrating from Microsoft DevLabs

See [docs/migration-from-ms-devlabs.md](docs/migration-from-ms-devlabs.md) for a step-by-step guide: task renames, service connection type changes, and side-by-side install instructions.

---

## Examples

See [docs/yaml-examples.md](docs/yaml-examples.md) for YAML examples covering every task and command, including cross-cloud scenarios (AzureRM state with AWS/GCP resources, HCP Terraform backend with AzureRM resources).

---

## Troubleshooting

See [docs/troubleshooting.md](docs/troubleshooting.md) for solutions to common issues with authentication, backend configuration, installer errors, and agent setup.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch strategy, commit conventions, local development setup, and the release process.

See [CHANGELOG.md](CHANGELOG.md) for the full history of changes since the fork.

---

## Trademarks

Terraform is a registered trademark of HashiCorp. OpenTofu is a trademark of the Linux Foundation. This extension is an independent, community-maintained fork and is **not** affiliated with, endorsed by, or sponsored by HashiCorp or the Linux Foundation. Product names are used under nominative fair use solely to describe compatibility.

---

## License

MIT. Originally authored by [Microsoft Corporation](https://github.com/microsoft/azure-pipelines-terraform). Fork maintained by [sethbacon](https://github.com/sethbacon).
