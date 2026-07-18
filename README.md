# Pipeline Tasks for Terraform

[![CI](https://github.com/sethbacon/azure-pipelines-terraform/actions/workflows/unit-test.yml/badge.svg)](https://github.com/sethbacon/azure-pipelines-terraform/actions/workflows/unit-test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An Azure DevOps extension for installing and running Terraform in build and release pipelines, supporting Azure, AWS, GCP, and OCI.

This is a fork of [microsoft/azure-pipelines-terraform](https://github.com/microsoft/azure-pipelines-terraform) (originally `ms-devlabs.custom-terraform-tasks`), published as **`sethbacon.pipeline-tasks-terraform`**. It adds new commands, backend/provider decoupling, Workload Identity Federation for AWS, GCP, and OCI, flexible installer download sources, a structured Terraform results tab (Plan/Apply/State pivots, redacted), SARIF output for the policy-check and drift-report tasks, and security hardening. It is designed to be installed **side-by-side** with the Microsoft DevLabs extension — it uses a distinct extension ID and distinct service connection type names.

---

## Tasks

### `PipelineTerraformInstaller@1` — Terraform Tool Installer

Installs a specific version of Terraform on the build agent.

| Input                       | Default     | Description                                                                                                                                                                                 |
| --------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `binary`                    | `terraform` | Which IaC binary to install: `terraform` (HashiCorp) or `tofu` (OpenTofu).                                                                                                                   |
| `terraformVersion`          | `latest`    | Version to install, e.g. `1.9.0`. `latest` resolves to the current latest release. **Supply-chain note:** the downloaded release is still GPG/cosign/checksum-verified either way, but `latest`'s version *number* is only as trustworthy as the version oracle it's resolved from (HashiCorp's checkpoint API, or the GitHub releases API for OpenTofu) — a compromised or on-path-manipulated oracle could steer an install to an older, validly-signed-but-vulnerable release. Pinning an explicit version is the supply-chain-hardened choice. Resolution fails closed (throws) rather than falling back to a stale cached version if the oracle is unreachable.                                                                                                          |
| `downloadSource`            | `hashicorp` | Where to download Terraform from. See [Download Sources](#download-sources) below.                                                                                                          |
| `registryUrl`               | —           | Base HTTPS URL of a terraform-registry-backend instance. Required when `downloadSource=registry`.                                                                                           |
| `registryMirrorName`        | `terraform` | Mirror name configured in the registry. Used when `downloadSource=registry`.                                                                                                                |
| `mirrorBaseUrl`             | —           | Base HTTPS URL of a custom mirror that replicates the HashiCorp path structure. Required when `downloadSource=mirror`.                                                                      |
| `registryAllowedHosts`      | —           | Optional comma/newline-separated allowlist of hostnames the registry's pre-signed `download_url` may use (e.g. `*.s3.amazonaws.com`). Empty (default) trusts the host the registry returns. |
| `requireGpgSignature`       | `true`      | For `downloadSource=hashicorp`: fail if the HashiCorp GPG signature cannot be verified.                                                                                                     |
| `requireCosignVerification` | `true`      | For OpenTofu (`binary=tofu`): fail if cosign/Sigstore verification cannot be performed.                                                                                                     |
| `requireChecksum`           | `true`      | For `registry`/`mirror` sources: fail if no SHA256 checksum is available (defaults to true; fail-closed).                                                                                   |

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

#### Core inputs

| Input              | Default                            | Description                                                                                                                                        |
| ------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`          | `azurerm`                          | Cloud provider used in the Terraform configuration: `azurerm`, `aws`, `gcp`, or `oci`. Selects the provider auth handler for all commands except `init` (which uses `backendType`). |
| `binaryName`        | `terraform`                        | `terraform` or `tofu` (OpenTofu). The selected binary must already be on `PATH` (run `PipelineTerraformInstaller@1` first).                          |
| `command`           | `init`                              | The Terraform command to run. See the command table above.                                                                                          |
| `backendType`       | `azurerm`                          | State backend for `init` only: `azurerm`, `s3`, `gcs`, `oci`, `hcp`, `generic`, or `local`. Decoupled from `provider` — see [Backend Types](#backend-types). |
| `workingDirectory`  | `$(System.DefaultWorkingDirectory)` | Directory containing the Terraform configuration files.                                                                                              |
| `commandOptions`    | —                                   | Additional raw arguments appended to the command, e.g. `-out=tfplan`.                                                                                |

#### Command-specific inputs

| Input                | Applies to                                     | Default     | Description                                                                                                                                                                                                                                    |
| --------------------- | ----------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publishPlanResults`  | `plan`                                          | —           | Name for a plan published as a raw (ANSI-colored) attachment to the **Terraform** results tab (e.g. `production`). Leave empty to disable. Independent of `publishPlanSummary` below — either, both, or neither may be enabled.               |
| `publishPlanSummary`  | `plan`, `destroy`                               | —           | Name for a **structured, redacted** JSON summary of the plan (resource changes, outputs, drift) published to the **Terraform** results tab's Plan pivot. Leave empty to disable. Adds `-out=<tempfile>` to the plan and runs `terraform show -json` on it to build the summary; every sensitive value renders as `(sensitive)`. On `destroy`, the summary is built from the destroy's own plan the same way (Terraform computes and saves one before applying) and the tab labels it **Destroy**; destroy still auto-approves and still fails the task on a non-zero exit. Redaction relies on Terraform correctly marking values `sensitive` (`after_sensitive`/`sensitive_values`) — see [SECURITY.md](SECURITY.md). |
| `publishStateResults` | `show`                                          | —           | Name for a **structured, redacted** JSON inventory of the current Terraform state (managed resources, data sources, outputs — no change actions) published to the **Terraform** results tab's State pivot. Leave empty to disable. Runs its own `terraform show -json` of the current state (independent of this step's `commandOptions`/output settings); every sensitive value (per each resource's `sensitive_values`) renders as `(sensitive)`. Only applies to a state show — if `commandOptions` names a saved plan file (this step is showing a plan file, not current state), this input has no effect. |
| `secureVarsFile`      | `plan`, `apply`, `destroy`, `import`, `refresh` | —           | A `.tfvars` file from the ADO Secure Files library, downloaded to a temp path and passed as `-var-file`, then deleted after execution.                                                                                                        |
| `terraformVariables`  | `plan`, `apply`, `destroy`, `import`, `refresh` | —           | Newline-separated `key=value` pairs, each passed as `-var`. Not for secrets — command-line `-var` values can be visible in process listings/logs; use `secureVarsFile` or `TF_VAR_` pipeline secret variables instead.                       |
| `replaceAddress`      | `plan`, `apply`                                 | —           | Forces replacement of a resource address via `-replace=ADDRESS` (Terraform 1.0+).                                                                                                                                                             |
| `importAddress`       | `import` (required)                             | —           | Resource address to import into, e.g. `aws_instance.web`.                                                                                                                                                                                      |
| `importId`            | `import` (required)                             | —           | Provider-specific ID of the resource to import.                                                                                                                                                                                                 |
| `lockId`              | `forceunlock` (required)                        | —           | Lock ID shown in the error message when acquiring the state lock failed.                                                                                                                                                                       |
| `refreshOnly`         | `plan`, `apply`                                 | `false`     | Run in refresh-only mode — reconciles state against real infrastructure without proposing changes.                                                                                                                                            |
| `lockfileReadonly`    | `init`                                          | `false`     | Sets `-lockfile=readonly` to prevent Terraform from updating `.terraform.lock.hcl`. Recommended for CI.                                                                                                                                        |
| `parallelism`         | `plan`, `apply`, `destroy`, `refresh`           | —           | Limits concurrent operations via `-parallelism=N`.                                                                                                                                                                                             |
| `varFile`             | `plan`, `apply`, `destroy`, `import`, `refresh` | —           | Newline-separated `.tfvars` paths (relative to `workingDirectory`), each passed as `-var-file=<path>`.                                                                                                                                        |
| `targetResources`     | `plan`, `apply`, `destroy`, `refresh`           | —           | Newline-separated resource addresses, each passed as `-target=<address>`.                                                                                                                                                                      |
| `testJunitXmlPath`    | `test`                                          | —           | Path to write JUnit XML results via `-junit-xml=PATH` (Terraform 1.6+). Publish it with `PublishTestResults@2` for the ADO **Tests** tab.                                                                                                     |
| `testFilter`          | `test`                                          | —           | Restricts `terraform test` to files matching this `-filter=TESTFILE`.                                                                                                                                                                          |
| `workspaceSubCommand` | `workspace` (required)                          | —           | `new`, `select`, `list`, `delete`, or `show`.                                                                                                                                                                                                   |
| `workspaceName`       | `workspace`                                     | —           | Workspace to create, select, or delete.                                                                                                                                                                                                         |
| `stateSubCommand`     | `state` (required)                              | —           | `list`, `pull`, `push`, `mv`, `rm`, `show`, or `replace-provider`.                                                                                                                                                                              |
| `stateAddress`        | `state`                                         | —           | Resource address(es)/arguments for the state sub-command (e.g. `SOURCE DESTINATION` for `mv`).                                                                                                                                                |
| `fmtCheck`            | `fmt`                                           | `true`      | Runs `terraform fmt -check` and fails if files need reformatting.                                                                                                                                                                              |
| `fmtRecursive`        | `fmt`                                           | `true`      | Runs `terraform fmt -recursive`.                                                                                                                                                                                                                |
| `fmtDiff`             | `fmt`                                           | `false`     | Runs `terraform fmt -diff` to display formatting changes.                                                                                                                                                                                       |
| `outputTo`            | `show`, `custom` (required)                     | `console`   | `file` or `console`.                                                                                                                                                                                                                            |
| `customCommand`       | `custom` (required)                             | —           | The raw Terraform command to execute.                                                                                                                                                                                                           |
| `outputFormat`        | `show` (required)                               | `default`   | `json` or `default`.                                                                                                                                                                                                                             |
| `filename`            | `show`/`custom` when `outputTo = file` (required) | —         | Path (relative to `workingDirectory`) to write the command output to.                                                                                                                                                                          |
| `cleanupOutputFile`   | `output`                                        | `false`     | Deletes the `output`-command's JSON file (every output's real value, **including any marked `sensitive`**) when the step finishes. **Retained by default** so downstream steps can read it via the `jsonOutputVariablesPath` output variable — enable this if a step only needs the auto-set `TF_OUT_*` pipeline variables (see below) and not the file itself, especially on a self-hosted agent whose working directory persists between jobs. |
| `failOnSensitiveOutputs` | `output`, `show`                             | `false`     | Fails the task (instead of only warning) when an `output`/`show` JSON output file would retain cleartext `sensitive = true` outputs on disk; the file is deleted at the end of the step on failure. Depends on the module declaring its outputs `sensitive` — same limitation as the `TF_OUT_*` masking described below. |
| `publishApplyResults` | `apply`                                        | —           | Name for a **structured, redacted** JSON summary of the apply (per-resource status/timing, outputs, diagnostics) published to the **Terraform** results tab's Apply pivot. Leave empty to disable. Runs apply with `-json` instead of Terraform's normal human-readable output; each event's own human-readable message is still echoed to the console so the live log is unaffected. Apply still fails the task on a non-zero exit exactly as when this is disabled. |
| `includeDiagnosticDetail` | `apply`                                     | `false`     | Include the longer `detail` field of each apply diagnostic (error/warning) in the summary published by `publishApplyResults`, in addition to the `summary` field. `detail` is freeform provider text with more residual leak risk than `summary` (best-effort scrub only); has no effect unless `includeDiagnostics` is also set to `true`. |
| `includeDiagnostics`  | `apply`                                        | `false`     | Include apply diagnostics (`summary`, and with `includeDiagnosticDetail`, `detail`) in the summary published by `publishApplyResults`. Diagnostics are freeform provider text scrubbed only best-effort (high-entropy/PEM heuristic — the task does **not** feed its `setSecret`-registered values into this scrub; see [SECURITY.md](SECURITY.md)), so a short provider-echoed secret can slip through into the build-read-wide attachment. **Omitted by default (safe default)** — the outcome and per-resource status are always published, and full error text always stays in the agent-masked live log. Set to `true` to opt in, accepting the documented best-effort-scrub residual. Has no effect unless `publishApplyResults` is also set. |

#### Provider authentication inputs

Shown on all commands except `init`/`validate`/`workspace`/`state`/`fmt`/`get`/`forceunlock`, and `test` (where the service connection is optional). See [Providers](#providers) and the WIF setup guides.

| Input                                       | Provider   | Default             | Description                                                                                                                     |
| --------------------------------------------- | ---------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `environmentServiceNameAzureRM`             | Azure      | — (required)         | Azure Resource Manager service connection.                                                                                       |
| `environmentAzureRmOverrideSubscriptionID`  | Azure      | —                    | Overrides `ARM_SUBSCRIPTION_ID`; defaults to the service connection's subscription.                                              |
| `environmentAzureRmUseIdTokenGeneration`    | Azure      | `false`              | Use ID token generation as a fallback for older AzureRM provider versions.                                                       |
| `runAzLogin`                                | Azure      | `false`              | Run `az login` with the service connection credentials before the Terraform command (for `local-exec`/CLI-based auth). **Security-sensitive** — see the `runAzLogin` help text and [SECURITY.md](SECURITY.md) for the argv-visibility caveat. |
| `environmentServiceNameAWS`                 | AWS        | — (required)         | Pipeline AWS for Terraform service connection.                                                                                    |
| `environmentAuthSchemeAWS`                  | AWS        | `ServiceConnection`  | `ServiceConnection` (static credentials) or `WorkloadIdentityFederation`.                                                        |
| `awsRoleArn`                                 | AWS        | — (required for WIF) | IAM role ARN to assume via OIDC.                                                                                                  |
| `awsRegion`                                  | AWS        | — (required for WIF) | AWS region for the provider.                                                                                                      |
| `awsSessionName`                             | AWS        | `AzureDevOps-Terraform` | Assumed-role session name.                                                                                                     |
| `environmentServiceNameGCP`                 | GCP        | — (required)         | Pipeline GCP for Terraform service connection.                                                                                    |
| `environmentAuthSchemeGCP`                  | GCP        | `ServiceConnection`  | `ServiceConnection` (service account key) or `WorkloadIdentityFederation`.                                                       |
| `gcpProjectNumber`                           | GCP        | — (required for WIF) | Numeric GCP project number hosting the Workload Identity Pool.                                                                    |
| `gcpWorkloadIdentityPoolId`                  | GCP        | — (required for WIF) | Workload Identity Pool ID.                                                                                                        |
| `gcpWorkloadIdentityProviderId`              | GCP        | — (required for WIF) | OIDC provider ID within the pool.                                                                                                  |
| `gcpServiceAccountEmail`                     | GCP        | — (required for WIF) | Service account to impersonate.                                                                                                   |
| `environmentServiceNameOCI`                 | OCI        | — (required)         | Pipeline OCI for Terraform service connection.                                                                                    |
| `environmentAuthSchemeOCI`                  | OCI        | `ServiceConnection`  | `ServiceConnection` (API key) or `WorkloadIdentityFederation`. See the [OCI WIF Setup Guide](docs/setup/oci-wif-setup.md).       |
| `ociWifTenancyOcid`                          | OCI        | — (required for WIF) | OCID of the OCI tenancy.                                                                                                          |
| `ociWifRegion`                               | OCI        | — (required for WIF) | OCI region identifier.                                                                                                             |
| `ociWifIdentityDomainUrl`                    | OCI        | — (required for WIF) | URL of the OCI Identity Domain configured for OIDC federation.                                                                    |
| `ociWifClientId`                             | OCI        | — (required for WIF) | Client ID of the Identity Domains application configured to accept OIDC tokens from Azure DevOps.                                |

#### Backend configuration inputs (`init` only)

Shown when `command = init`. The `azurerm`/`s3`/`gcs`/`oci` field groups are shown based on the selected `provider` (not `backendType`); the `hcp` and `generic` groups are shown based on `backendType` — see [Backend Types](#backend-types).

| Input                                       | Backend   | Default | Description                                                                                                                  |
| --------------------------------------------- | --------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `backendServiceArm`                          | azurerm   | — (required) | Azure Resource Manager service connection for the backend.                                                              |
| `backendAzureRmUseEntraIdForAuthentication`  | azurerm   | `true`  | Sets Terraform's `use_azuread_auth` for the azurerm backend.                                                                |
| `backendAzureRmUseCliFlagsForAuthentication` | azurerm   | `false` | Use CLI flags (`client_id`, `ado_pipeline_service_connection_id`, `use_oidc`) so the backend can use a separate service connection from the provider. |
| `backendAzureRmUseIdTokenGeneration`         | azurerm   | `false` | ID token generation fallback for older azurerm backend versions.                                                            |
| `backendAzureRmOverrideSubscriptionID`       | azurerm   | —       | Subscription containing the storage account (only needed for URI lookup).                                                  |
| `backendAzureRmResourceGroupName`            | azurerm   | —       | Resource group containing the storage account (only needed for URI lookup).                                                |
| `backendAzureRmStorageAccountName`           | azurerm   | — (required) | Storage account holding the Blob container.                                                                            |
| `backendAzureRmContainerName`                | azurerm   | — (required) | Blob container name.                                                                                                    |
| `backendAzureRmKey`                          | azurerm   | — (required) | Path to the state file inside the container.                                                                            |
| `backendServiceAWS`                          | s3        | — (required) | AWS service connection for the backend.                                                                                 |
| `backendAuthSchemeAWS`                       | s3        | `ServiceConnection` | `ServiceConnection` (static credentials) or `WorkloadIdentityFederation`.                                        |
| `backendAWSBucketName`                       | s3        | — (required) | S3 bucket for the state file.                                                                                           |
| `backendAWSKey`                              | s3        | — (required) | Path to the state file inside the bucket.                                                                               |
| `backendAWSRoleArn`                          | s3        | — (required for WIF) | IAM role ARN to assume via OIDC for backend access.                                                             |
| `backendAWSRegion`                           | s3        | — (required for WIF) | AWS region of the S3 bucket.                                                                                     |
| `backendAWSSessionName`                      | s3        | `AzureDevOps-Terraform-Backend` | Assumed-role session name.                                                                            |
| `backendServiceGCP`                          | gcs       | — (required) | GCP service connection for the backend.                                                                                 |
| `backendAuthSchemeGCP`                       | gcs       | `ServiceConnection` | `ServiceConnection` (service account key) or `WorkloadIdentityFederation`.                                       |
| `backendGCPBucketName`                       | gcs       | — (required) | GCS bucket for the state file.                                                                                          |
| `backendGCPPrefix`                           | gcs       | —       | Relative path/prefix inside the bucket for the state object.                                                                |
| `backendGCPProjectNumber`                    | gcs       | — (required for WIF) | GCP project number hosting the Workload Identity Pool.                                                          |
| `backendGCPWorkloadIdentityPoolId`           | gcs       | — (required for WIF) | Workload Identity Pool ID.                                                                                       |
| `backendGCPWorkloadIdentityProviderId`       | gcs       | — (required for WIF) | OIDC provider ID within the pool.                                                                                |
| `backendGCPServiceAccountEmail`              | gcs       | — (required for WIF) | Service account to impersonate for backend access.                                                              |
| `backendServiceOCI`                          | oci       | — (required) | OCI service connection for the backend.                                                                                 |
| `backendOCIPar`                              | oci       | —       | OCI Object Storage pre-authenticated request (PAR) URL for the state file. Its `/p/<token>/` path segment is a bearer credential — treat as a secret variable. See [Security](SECURITY.md#oci-backend-par-residual-risk-bearer-credential-persists-in-a-generated-tf-file) for the config-file persistence residual. |
| `backendOCIConfigGenerate`                   | oci       | `yes`   | Generates the `backend "http"` Terraform config from `backendOCIPar` at runtime; set `no` if the backend block is already in your `.tf` files. |
| `backendHCPToken`                            | hcp       | — (required) | HCP Terraform / Terraform Cloud API token. Sets `TF_TOKEN_app_terraform_io`.                                        |
| `backendHCPOrganization`                     | hcp       | —       | HCP organization name; falls back to the `cloud{}` block in `.tf` files if unset. Sets `TF_CLOUD_ORGANIZATION`.             |
| `backendHCPWorkspace`                        | hcp       | —       | HCP workspace name; falls back to the `cloud{}` block in `.tf` files if unset. Sets `TF_WORKSPACE`.                         |
| `backendConfigFile`                          | generic   | —       | Path to a `.tfbackend` file, passed as `-backend-config=<file>`.                                                            |
| `backendConfigArgs`                          | generic   | —       | Newline-separated `key=value` pairs, each passed as a separate `-backend-config` flag.                                      |

Backend inputs are also required on non-`init` state-accessing commands when the detected backend differs from `provider` — see [Cross-cloud state backends](docs/yaml-examples.md#cross-cloud-state-backends).

**Output variables:**

| Variable                    | Description                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `jsonPlanFilePath`           | Path to the `plan` command's JSON plan file (`terraform show -json` equivalent input for policy tooling). Set only when `command = plan`. |
| `jsonOutputVariablesPath`    | Path to the `output` command's JSON file. Set only when `command = output`. See `cleanupOutputFile` above.                              |
| `changesPresent`             | Boolean — whether the `plan` found changes to apply.                                                                                     |
| `destroyChangesPresent`      | Boolean — whether the plan contains resource deletions. Set when `command = show`, `outputTo = file`, `outputFormat = json`.             |
| `showFilePath`               | Path to the `show` command's output file. Set only when `command = show` and `outputTo = file`.                                          |
| `customFilePath`             | Path to the `custom` command's output file. Set only when `command = custom` and `outputTo = file`.                                      |
| `TF_OUT_<name>`              | On `command = output`, every Terraform output is auto-set as a pipeline variable named `TF_OUT_<output name>`. **The variable is masked as secret only when the module declares that output `sensitive = true`** in its own Terraform configuration — an output a module author forgot to mark `sensitive` is written as an unmasked pipeline variable, even though `terraform output -json` itself always emits every value (including sensitive ones) in cleartext. Values that fail a length/printable-ASCII sanity check are skipped (with a task warning) rather than set. Do not rely on `TF_OUT_*` masking as the sole safeguard for a module whose `sensitive` annotations you don't fully trust. |

#### Structured Terraform results tab

Setting `publishPlanSummary`, `publishApplyResults`, and/or `publishStateResults` (in addition to, or instead of, the legacy `publishPlanResults`) publishes a **structured, redacted JSON summary** to the pipeline results **Terraform** tab, which has three pivots:

- **Plan** — an overview list of every published plan for the run (name + add/change/destroy/replace counts and drift badge), a summary header, a grouped/filterable resource list, and a per-resource attribute diff (before → after). A destroy plan (`publishPlanSummary` on `command = destroy`) reuses this same pivot — it is a plan whose changes are all deletes — and is marked with a **Destroy** badge in both the overview row and the detail header.
- **Apply** — an overview list of every published apply for the run, a per-resource status/timing timeline, an outputs panel, and a diagnostics panel (errors/warnings).
- **State** — an overview list of every published state inventory for the run (name + resource/data-source counts), a summary header, and a filterable, type-grouped list of the current state's resources (address, type, provider) with an expandable current-attribute-value table per resource. Unlike Plan/Apply, a state resource carries only its **current** values — no change action, no before/after.

Every pivot also shows a **raw fallback**: legacy `publishPlanResults` attachments (and any digest the tab cannot parse) still render as ANSI-colored text, unchanged.

**Redaction.** Every value in the structured summary has already been redacted by the task before it is attached — a sensitive value (per Terraform's own `after_sensitive`/`before_sensitive`/`sensitive_values`/`outputs[].sensitive` marks) renders as `(sensitive)`, and a not-yet-known value renders as `(known after apply)`. The tab itself never receives the underlying value. The State summary is redacted the same way, against each resource's own `sensitive_values` (state has no before/after or unknown values, so only the sensitive mask applies). See [SECURITY.md](SECURITY.md) for the residual risks this depends on.

**Same-run only.** The tab only loads attachments from the current pipeline run (build ID) — it does not correlate or display a plan/apply summary from a different run, and there is no cross-run plan↔apply pairing.

For a step-by-step walkthrough of enabling structured results and reading each tab section, see [docs/structured-results.md](docs/structured-results.md).

---

### `PipelineTerraformModulePublish@1` — Module Publisher

Publishes a module version to HCP Terraform / Terraform Enterprise or a private Terraform registry (`terraform-registry-backend`) from a release pipeline.

| Input             | Default                    | Description                                                                                                                                                                                                                                                                    |
| ----------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `registryType`    | `private`                  | `private` (terraform-registry-backend) or `hcp` (HCP Terraform / TFE).                                                                                                                                                                                                         |
| `namespace`       | —                          | Module namespace.                                                                                                                                                                                                                                                              |
| `name`            | —                          | Module name.                                                                                                                                                                                                                                                                   |
| `provider`        | —                          | Provider / target system the module is for.                                                                                                                                                                                                                                    |
| `version`         | —                          | Semantic version to publish.                                                                                                                                                                                                                                                   |
| `registryUrl`     | —                          | Base HTTPS URL of the private registry. Required when `registryType=private`.                                                                                                                                                                                                  |
| `apiKey`          | —                          | Private-registry API key. Treat as a secret variable.                                                                                                                                                                                                                          |
| `skipTlsVerify`   | `false`                    | **Security-sensitive.** Disables TLS certificate validation for the private-registry connection while the `apiKey` bearer is transmitted — with verification off, `apiKey` is a bearer credential capturable by anyone on-path between the agent and the registry. Prefer installing the private CA into the agent's trust store via `NODE_EXTRA_CA_CERTS` instead of disabling verification; use `skipTlsVerify` only when that isn't possible for an internal registry behind a private CA the agent does not trust. |
| `scmProviderId`   | —                          | Optional (private). UUID of a configured SCM provider connection in the registry. Set together with `repositoryOwner` and `repositoryName` to auto-create and SCM-link a module that does not yet exist, instead of failing.                                                   |
| `repositoryOwner` | —                          | Optional (private, auto-create). SCM-link repository owner. For Azure DevOps this is the **project name**; for GitHub/GitLab the org or user.                                                                                                                                  |
| `repositoryName`  | —                          | Optional (private, auto-create). SCM-link source repository name.                                                                                                                                                                                                              |
| `defaultBranch`   | `main`                     | Optional (private, auto-create). Default branch recorded on the SCM link.                                                                                                                                                                                                      |
| `tagPattern`      | `v*`                       | Optional (private, auto-create). Glob matched against git tags to import versions.                                                                                                                                                                                             |
| `hcpAddress`      | `https://app.terraform.io` | HCP Terraform / TFE address. Used when `registryType=hcp`.                                                                                                                                                                                                                     |
| `hcpToken`        | —                          | HCP API token. Treat as a secret variable. Used when `registryType=hcp`.                                                                                                                                                                                                       |
| `waitForPublish`  | `true`                     | Poll until the version is available before completing.                                                                                                                                                                                                                         |
| `timeoutSeconds`  | `180`                      | Wall-clock bound for `waitForPublish`.                                                                                                                                                                                                                                         |

HCP VCS-backed publishing also accepts `vcsRepoIdentifier`, `vcsBranch`, `vcsOauthTokenId`, and `commitSha`.

For a private registry, a brand-new module normally has to be registered and SCM-linked once before its first release. Supplying `scmProviderId`, `repositoryOwner`, and `repositoryName` makes the task do that automatically on a `404`: it creates the module record, links it to its SCM repository, then triggers the tag sync. The API key must have `modules:publish` and `modules:write` scopes. Omit these inputs to keep the pre-register-first behavior.

---

### `PipelinePolicyAgentInstaller@1` — Policy Agent Installer

Installs a policy engine — **OPA** (sha256-verified binary from the `open-policy-agent/opa` GitHub releases) or **Sentinel** (GPG-signed zip from `releases.hashicorp.com`) — and prepends it to the `PATH`.

| Input                  | Default    | Description                                                                                                 |
| ---------------------- | ---------- | ----------------------------------------------------------------------------------------------------------- |
| `policyAgent`          | `opa`      | `opa` or `sentinel`.                                                                                        |
| `version`              | `latest`   | Version to install. `latest` resolves via the GitHub releases (OPA) or checkpoint (Sentinel) API. **Supply-chain note:** the download is still verified (GPG for Sentinel, checksum for OPA) either way, but `latest`'s version *number* is only as trustworthy as that oracle; pinning an explicit version is the supply-chain-hardened choice. Fails closed rather than falling back to a stale version if the oracle is unreachable. |
| `downloadSource`       | `official` | `official`, `registry` (terraform-registry-backend), or `mirror` (custom HTTPS mirror).                     |
| `registryUrl`          | —          | Base HTTPS URL of a terraform-registry-backend instance. Required when `downloadSource=registry`.           |
| `registryMirrorName`   | `opa`      | Mirror name configured in the registry (e.g. `opa` or `sentinel`). Used when `downloadSource=registry`.     |
| `registryAllowedHosts` | —          | Optional allowlist of hostnames the registry's `download_url` may use. Used when `downloadSource=registry`. |
| `mirrorBaseUrl`        | —          | Base HTTPS URL of a custom mirror that replicates the official release path structure. Required when `downloadSource=mirror`. |
| `requireGpgSignature`  | `true`     | Sentinel only. Fail if a Sentinel GPG signature is unavailable.                                             |
| `requireChecksum`      | `true`     | Fail if a SHA256 checksum is unavailable.                                                                   |

**Output variables:** `policyAgentLocation`, `policyAgentDownloadedFrom`. OPA ships `amd64`/`arm64` only.

---

### `PipelineTerraformPolicyCheck@1` — Policy Check

Evaluates **OPA** or **Sentinel** policies against Terraform plan JSON (`terraform show -json` output) and gates the pipeline on the result.

> **Note:** Sentinel here runs as a standalone CLI, not inside HCP Terraform/Terraform Enterprise. Policies see the **raw** `terraform show -json` document, not HCP Terraform's `tfplan/v2` mock, and `enforcement_level` is applied by this task (see `defaultEnforcementLevel`/`overrideSoftMandatory` below), not natively enforced by the CLI. An existing HCP Terraform Sentinel policy set will likely need adapting before it works here — see [docs/troubleshooting.md](docs/troubleshooting.md#sentinel-policies-written-for-hcp-terraform-dont-work).

| Input                     | Default          | Description                                                                                               |
| ------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------- |
| `engine`                  | `opa`            | `opa` or `sentinel`.                                                                                      |
| `inputFile`               | —                | Path to the plan JSON to evaluate.                                                                        |
| `policyAgentPath`         | —                | Optional explicit path to the `opa`/`sentinel` binary. Defaults to the binary on `PATH`.                  |
| `policySource`            | `path`           | `path` (local directory) or `gitUrl` (HTTPS shallow clone / ref checkout).                                 |
| `policyPath`              | —                | Policy directory when `policySource=path`.                                                                |
| `policyRepoUrl`           | —                | Policy repo URL when `policySource=gitUrl`. Pairs with `policyRepoRef`/`policyRepoSubdir`/`policyRepoToken`. |
| `decisionPath`            | `terraform/deny` | OPA decision path to query.                                                                               |
| `failMode`                | `nonEmpty`       | OPA gate: fail when the decision is `nonEmpty` or `defined`.                                              |
| `defaultEnforcementLevel` | `soft-mandatory` | Sentinel enforcement level (`advisory`/`soft-mandatory`/`hard-mandatory`).                                |
| `overrideSoftMandatory`   | `false`          | Sentinel only. When enabled, a `soft-mandatory` policy failure warns instead of failing the task.          |
| `sentinelImportName`      | `tfplan`         | Sentinel only. Name of the static import that exposes the plan JSON to policies (`import "<name>"`).      |
| `sentinelConfigPath`      | —                | Sentinel only. Use an existing `sentinel.hcl` instead of generating one; the task then gates purely on the exit code. |
| `traceOutput`             | `false`          | Sentinel only. Run `sentinel apply -trace` for verbose debugging output.                                  |
| `publishTestResults`      | `true`           | Publish a JUnit results file to the pipeline **Tests** tab.                                                |
| `sarifPath`               | —                | Optional explicit path for the SARIF report, used when `sarifOutput=true`. When empty, a file is written to the agent temp directory. |

**Output variables:** `policyResult`, `violationCount`, `resultsFilePath`, and `sarifFilePath` (when `sarifOutput` is enabled).

Set `sarifOutput: true` to also emit a SARIF 2.1.0 report of policy violations (path via the `sarifFilePath` output) for code-scanning / security dashboards — see the [SARIF example](docs/yaml-examples.md#emit-a-sarif-report).

---

### `PipelineTerraformDriftReport@1` — Drift Report

Parses a Terraform/OpenTofu plan JSON into drift counts plus a changed-resource summary, and optionally POSTs the summary to a [Terraform State Manager](https://github.com/sethbacon/terraform-state-manager) (TSM) drift callback.

| Input                     | Default                           | Description                                                                   |
| ------------------------- | --------------------------------- | ----------------------------------------------------------------------------- |
| `planJsonFile`            | —                                 | Path to the plan JSON to analyse.                                             |
| `includeModuleProvenance` | `true`                            | Include module source provenance from the module manifest.                    |
| `moduleManifest`          | `.terraform/modules/modules.json` | Module manifest path used for provenance.                                     |
| `failOnDrift`             | `false`                           | Fail the task when drift is detected.                                         |
| `detail`                  | —                                 | Free-text run label forwarded as the callback `detail` field (e.g. `$(Build.BuildId)`). |
| `callbackUrl`             | —                                 | TSM drift-callback URL. Must be HTTPS.                                        |
| `callbackToken`           | —                                 | TSM callback bearer token. Treat as a secret variable.                        |
| `rejectUnauthorized`      | `true`                            | Verify the callback endpoint's TLS certificate (leave enabled in production). If the endpoint uses a private CA, prefer installing that CA into the agent's trust store via `NODE_EXTRA_CA_CERTS` over disabling verification — with verification off, `callbackToken` is a bearer credential capturable by anyone on-path between the agent and TSM. |
| `failOnCallbackError`     | `true`                            | Fail the task when the TSM callback returns a non-2xx response. Disable to log a warning and continue instead — e.g. so a flaky/overloaded TSM backend doesn't fail the pipeline when the local drift analysis (already written to the summary file) succeeded. |
| `sarifPath`               | —                                 | Optional explicit path for the SARIF report, used when `sarifOutput=true`. When empty, a file is written to the agent temp directory. |
| `cleanupSummaryFile`      | `false`                           | Delete the JSON summary file (written to the agent temp directory) when the task finishes. Retained by default so downstream steps can read it via `summaryFilePath`; enable to remove it immediately after the callback, e.g. on a self-hosted agent whose temp directory isn't wiped between jobs and where the summary may contain sensitive plan values. |

Set `sarifOutput: true` to also emit a SARIF 2.1.0 drift report (path via the `sarifFilePath` output) for SARIF-aware tooling — see the [SARIF example](docs/yaml-examples.md#emit-a-sarif-report-1).

**Output variables:**

| Variable          | Description                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `driftDetected`   | `true` when any non-no-op, non-read change was planned.                                             |
| `addedCount`      | Count of resources whose plan contains a create.                                                    |
| `changedCount`    | Count of resources whose plan contains an update.                                                   |
| `destroyedCount`  | Count of resources whose plan contains a delete.                                                    |
| `summaryFilePath` | Path to the JSON report written to the agent temp directory (the exact callback body). Removed at task end when `cleanupSummaryFile` is enabled. |
| `sarifFilePath`   | Path to the SARIF 2.1.0 report. Set only when `sarifOutput` is enabled.                              |

---

### `PipelineTerraformDocsInstaller@1` — terraform-docs Installer

Installs a specific version of [terraform-docs](https://terraform-docs.io) on the build agent and prepends it to the `PATH`.

| Input                  | Default          | Description                                                                                                          |
| ---------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `version`              | `latest`         | Version to install, e.g. `0.20.0`. `latest` resolves to the current latest release. **Supply-chain note:** the download is still checksum-verified either way, but `latest`'s version *number* is only as trustworthy as the GitHub releases API it's resolved from; pinning an explicit version is the supply-chain-hardened choice. Fails closed rather than falling back to a stale version if the API is unreachable. |
| `downloadSource`       | `official`       | Where to download terraform-docs from: `official` (GitHub releases), `registry`, or `mirror`.                        |
| `registryUrl`          | —                | Base HTTPS URL of a terraform-registry-backend instance. Required when `downloadSource=registry`.                    |
| `registryMirrorName`   | `terraform-docs` | Mirror name configured in the registry. Used when `downloadSource=registry`.                                         |
| `mirrorBaseUrl`        | —                | Base HTTPS URL of a custom mirror that replicates the release path structure. Required when `downloadSource=mirror`. |
| `registryAllowedHosts` | —                | Optional allowlist of hostnames the registry's `download_url` may use. Used when `downloadSource=registry`.          |
| `requireChecksum`      | `true`           | Fail if a SHA256 checksum is not available for the requested version/platform.                                       |

**Output variables:**

| Variable                      | Description                                                            |
| ----------------------------- | ---------------------------------------------------------------------- |
| `terraformDocsLocation`       | Path to the installed `terraform-docs` binary.                         |
| `terraformDocsDownloadedFrom` | Source used: `official`, `registry:<url>`, `mirror:<url>`, or `cache`. |

Downloads are verified against the published `terraform-docs-v<version>.sha256sum` file over HTTPS. terraform-docs does not publish a GPG/cosign signature, so — as with OPA — integrity is anchored to the GitHub release origin.

### `PipelineTerraformDocs@1` — terraform-docs

Generates documentation for a Terraform module using terraform-docs. Requires terraform-docs on the `PATH` (run `PipelineTerraformDocsInstaller@1` first).

| Input            | Default          | Description                                                                                                       |
| ---------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `formatter`      | `markdown-table` | Output format: markdown table/document, json, yaml, toml, pretty, asciidoc table/document, or tfvars hcl/json.    |
| `modulePath`     | `.`              | Directory containing the module to document.                                                                      |
| `outputFile`     | —                | File (relative to the module directory) to write documentation to, e.g. `README.md`. Empty writes to the console. |
| `outputMode`     | `inject`         | How to write the output file: `inject` (between markers) or `replace` (whole file).                               |
| `outputCheck`    | `false`          | Fail the task if the output file is out of date instead of writing it (CI gate for stale docs).                   |
| `configFile`     | —                | Path to a terraform-docs configuration file (e.g. `.terraform-docs.yml`).                                         |
| `sortBy`         | `default`        | Sort inputs/outputs by `name`, `required`, or `type`.                                                             |
| `recursive`      | `false`          | Recurse into submodules.                                                                                          |
| `recursivePath`  | `modules`        | Submodule directory to recurse into when `recursive` is enabled.                                                  |
| `additionalArgs` | —                | Additional arguments passed verbatim to terraform-docs.                                                           |

**Output variables:**

| Variable            | Description                                                                   |
| ------------------- | ----------------------------------------------------------------------------- |
| `generatedFilePath` | Path to the generated documentation file, when an output file was configured. |

### `Markdown2Html@1` — Markdown to HTML Converter

Converts Markdown files to a single styled HTML document (via markdown-it with highlight.js syntax highlighting) — typically the module docs produced by `PipelineTerraformDocs@1` — ready to publish as a ServiceNow knowledge base article. Pure local processing; no network access.

| Input         | Default                   | Description                                                                                                                 |
| ------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `mode`        | —                         | `filelist` (combine an explicit list of files) or `frontMatter` (a primary file whose YAML front-matter declares includes). |
| `primaryFile` | —                         | Primary Markdown file whose front-matter drives composition. Required when `mode=frontMatter`.                              |
| `inputFiles`  | —                         | Newline- or comma-separated Markdown paths to convert and combine. Required when `mode=filelist`.                           |
| `outputFile`  | —                         | Path to write the generated HTML file.                                                                                      |
| `title`       | `Combined Markdown Files` | Title for the generated HTML document.                                                                                      |
| `sections`    | `false`                   | Add each file's name as a section heading.                                                                                  |
| `dividers`    | `false`                   | Add horizontal rules between files.                                                                                         |
| `debug`       | `false`                   | Print additional debug information during conversion.                                                                      |

**Output variables:**

| Variable       | Description                               |
| -------------- | ----------------------------------------- |
| `htmlFilePath` | Absolute path to the generated HTML file. |

### `PublishKbArticle@1` — Publish KB Article to ServiceNow

Creates or updates a ServiceNow knowledge base article from an HTML file. Idempotent: a stable `sourceKey` (or a `kb-key:` front-matter field) correlates re-runs to the same article. Optionally auto-creates categories/subcategories and uploads relative `<img>` images as attachments. Authenticates via a `ServiceNowKb` service connection (OAuth client credentials or basic) or inline credentials. See the [ServiceNow Setup Guide](docs/setup/servicenow-setup.md) for the minimal ServiceNow roles/ACLs this integration needs.

| Input               | Default | Description                                                                                                      |
| ------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `serviceConnection` | —       | A `ServiceNowKb` service connection. If unset, provide `instance` + credentials inline.                          |
| `instance`          | —       | ServiceNow instance name (e.g. `mycompany` for `mycompany.service-now.com`). Required when no connection is set. |
| `authType`          | `oauth` | `oauth` (client credentials) or `basic`, when using inline credentials.                                          |
| `clientId`          | —       | OAuth client application ID. Used when `authType=oauth` and no service connection is set.                        |
| `clientSecret`      | —       | OAuth client application secret. Used when `authType=oauth` and no service connection is set. Treat as a secret variable. |
| `username`          | —       | ServiceNow username for basic authentication. Used when `authType=basic` and no service connection is set.       |
| `password`          | —       | ServiceNow password for basic authentication. Used when `authType=basic` and no service connection is set. Treat as a secret variable. |
| `kbId`              | —       | Knowledge base `sys_id`. Use `list` to print available knowledge bases.                                          |
| `title`             | —       | Article title (`short_description`). Required when creating a new article.                                       |
| `htmlFile`          | —       | Path to the HTML file whose contents become the article body.                                                    |
| `author`            | —       | ServiceNow username of the article author. Required when creating.                                               |
| `category`          | —       | Category name (auto-created if missing). Prefix with `sys_id:` for a raw sys_id.                                 |
| `workflowState`     | `draft` | Target state: `draft`, `review`, or `publish`.                                                                   |
| `sourceKey`         | —       | Stable correlation key for idempotent create/update.                                                             |
| `uploadImages`      | `false` | Upload relative `<img>` images as attachments and rewrite their `src`.                                           |
| `dryRun`            | `false` | Convert, validate, and log the planned action without writing to ServiceNow (useful on PR builds).               |

Advanced inputs (`articleId`, `subcategory`, `readKeyFrom`, `emitManifest`, `imageBaseDir`, `force`, `skipJsonLookup`) are documented in the task's help text.

**Output variables:**

| Variable          | Description                                        |
| ----------------- | -------------------------------------------------- |
| `kbArticleId`     | `sys_id` of the created or updated article.        |
| `kbArticleNumber` | Article number (e.g. `KB0001234`).                 |
| `kbWorkflowState` | Workflow state of the article after the task runs. |

All ServiceNow requests are sent over HTTPS only (the task refuses to transmit credentials over a non-HTTPS URL); the OAuth token and password are masked in logs via `setSecret`.

### End-to-end: document a module and publish it to ServiceNow

`PipelineTerraformDocs@1` → `Markdown2Html@1` → `PublishKbArticle@1`:

```yaml
- task: PipelineTerraformDocsInstaller@1
- task: PipelineTerraformDocs@1
  inputs:
    modulePath: "."
    outputFile: "MODULE.md"
    outputMode: replace
- task: Markdown2Html@1
  inputs:
    mode: filelist
    inputFiles: "MODULE.md"
    outputFile: "$(Build.ArtifactStagingDirectory)/module.html"
    title: "My Terraform Module"
- task: PublishKbArticle@1
  inputs:
    serviceConnection: "my-servicenow"
    kbId: "$(kbSysId)"
    title: "My Terraform Module"
    htmlFile: "$(Build.ArtifactStagingDirectory)/module.html"
    author: "svc-docs"
    sourceKey: "my-terraform-module"
    workflowState: publish
    dryRun: ${{ ne(variables['Build.SourceBranch'], 'refs/heads/main') }}
```

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

**Cross-cloud credentials aren't just an `init`-time concern.** When the backend
detected from the initialized working directory differs from the `provider`
input, the task automatically supplies that backend's credentials (as
environment variables) on every state-accessing command — `plan`, `apply`,
`destroy`, `refresh`, `import`, `output`, `state`, `workspace`, and
`forceunlock`. Add the matching backend inputs (`backendServiceArm`, `backendServiceAWS`,
`backendServiceGCP`, `backendHCP*`, ...) to **each** of those steps, not only
`init` — see [Cross-cloud state backends](docs/yaml-examples.md#cross-cloud-state-backends)
for complete examples. A step missing the required backend inputs fails fast
with an actionable error naming the detected backend, the provider, and the command.

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

> **OpenTofu note:** the "for Terraform" display names above are a naming carryover, not a functional restriction — all three connection types work identically whether the step installs `binary: terraform` or `binary: tofu` (see `PipelineTerraformInstaller@1`'s `binary` input). An OpenTofu-only pipeline can create and use these connections exactly as documented.

---

## Workload Identity Federation

AWS, GCP, and OCI support Workload Identity Federation — no static credentials are stored in the service connection. Azure DevOps issues an OIDC token that is exchanged for temporary cloud credentials at runtime.

- [AWS WIF Setup Guide](docs/setup/aws-wif-setup.md)
- [GCP WIF Setup Guide](docs/setup/gcp-wif-setup.md)
- [OCI WIF Setup Guide](docs/setup/oci-wif-setup.md)

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

### OCI WIF — quick reference

```yaml
- task: PipelineTerraformTask@5
  inputs:
    provider: oci
    command: plan
    environmentServiceNameOCI: my-oci-service-connection
    environmentAuthSchemeOCI: WorkloadIdentityFederation
    ociWifTenancyOcid: ocid1.tenancy.oc1..aaaaaaaa...
    ociWifRegion: us-ashburn-1
    ociWifIdentityDomainUrl: https://idcs-abc123.identity.oraclecloud.com
    ociWifClientId: my-identity-domain-app-client-id
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
| Policy agent installer (OPA / Sentinel)        | Not available                                                  | `PipelinePolicyAgentInstaller@1`                                      |
| Policy evaluation (plan-JSON gate)             | Not available                                                  | `PipelineTerraformPolicyCheck@1`                                      |
| Drift reporting                                | Not available                                                  | `PipelineTerraformDriftReport@1`                                      |
| Module publishing (HCP / private registry)     | Not available                                                  | `PipelineTerraformModulePublish@1`                                    |
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

> **Cross-cloud state:** the "Not required" commands above assume the state
> backend is on the *same* cloud as `provider`. If the backend detected from
> the working directory is on a *different* cloud (e.g. an `azurerm` backend
> with `provider: aws`), that backend's service connection inputs are still
> required on `state`, `workspace`, and `forceunlock` — see
> [Cross-cloud state backends](docs/yaml-examples.md#cross-cloud-state-backends).

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

Tasks run on Windows, macOS, and Linux build agents using Node 24. Every task also declares a `Node20_1` execution fallback, so older on-prem/air-gapped agents that lack the Node 24 handler still pick up the task instead of failing to find one — Node 24 remains the preferred, actively-targeted runtime.

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
