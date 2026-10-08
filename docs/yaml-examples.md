# Azure Pipelines Terraform Extension — YAML Examples

## Task Reference

- [`PipelineTerraformInstaller@1`](#pipelineterraforminstaller1) — Install Terraform or OpenTofu
- [`PipelineTerraformProviderMirror@1`](#pipelineterraformprovidermirror1) — Configure provider network mirror
- [`PipelineTerraformTask@5`](#pipelineterraformtask5) — Run Terraform commands (init, plan, apply, destroy, etc.)
  - [Azure](#azure-azurerm), [AWS](#aws), [GCP](#gcp), [OCI](#oci) — init, plan, apply and destroy for each provider, including Workload Identity Federation
  - [OpenTofu](#opentofu) — run `tofu` instead of `terraform`
  - [Additional commands](#additional-commands) — validate, fmt, get, output, show, workspace, state, refresh, import, forceunlock, custom, test
  - [Variables and var files](#variables-and-var-files) — inline variables, var files, secure var files
  - [HCP Terraform / Terraform Cloud backend](#hcp-terraform--terraform-cloud-backend), [generic and local backends](#generic-and-local-backends)
  - [Full pipeline example (AzureRM)](#full-pipeline-example-azurerm)
- [Cross-cloud state backends](#cross-cloud-state-backends) — AzureRM state with AWS/GCP resources; HCP Terraform with AzureRM resources
- [Policy as code](#policy-as-code) — Install OPA/Sentinel and evaluate policies against plan JSON, with an optional SARIF report
  - [`PipelinePolicyAgentInstaller@1`](#pipelinepolicyagentinstaller1) — Install OPA or Sentinel from the official release, a private registry or a mirror
  - [`PipelineTerraformPolicyCheck@1`](#pipelineterraformpolicycheck1) — Evaluate OPA or Sentinel policies against plan JSON
- [`PipelineTerraformDriftReport@1`](#pipelineterraformdriftreport1) — Summarise plan drift, optional SARIF report + TSM callback
- [`PipelineTerraformModulePublish@1`](#pipelineterraformmodulepublish1) — Publish a module version to HCP Terraform or a private registry
- [`PipelineTerraformDocsInstaller@1`](#pipelineterraformdocsinstaller1) — Install terraform-docs
- [`PipelineTerraformDocs@1`](#pipelineterraformdocs1) — Generate Terraform module documentation with terraform-docs
- [`Markdown2Html@1`](#markdown2html1) — Convert Markdown docs to a single styled HTML file (deprecated; moving to `PipelineMarkdown2Html`)
- [`PublishKbArticle@1`](#publishkbarticle1) — Create or update a ServiceNow knowledge base article (deprecated; moving to `PipelinePublishKbArticle`)
- [End-to-end: docs to ServiceNow KB](#end-to-end-docs-to-servicenow-kb) — terraform-docs → Markdown2Html → PublishKbArticle

---

## PipelineTerraformInstaller@1

Install a specific version of Terraform or OpenTofu on the pipeline agent.

### Install latest Terraform

```yaml
- task: PipelineTerraformInstaller@1
  displayName: 'Install Terraform (latest)'
  inputs:
    binary: 'terraform'
    terraformVersion: 'latest'
```

### Install a pinned Terraform version

```yaml
- task: PipelineTerraformInstaller@1
  displayName: 'Install Terraform 1.11.3'
  inputs:
    binary: 'terraform'
    terraformVersion: '1.11.3'
```

### Download from HashiCorp releases with signature verification

`downloadSource` defaults to `hashicorp` (releases.hashicorp.com) and `requireGpgSignature` defaults to `true`; both are shown for clarity. The install fails when the signature of the release's `SHA256SUMS` file is unavailable or does not verify.

```yaml
- task: PipelineTerraformInstaller@1
  displayName: 'Install Terraform 1.11.3 (HashiCorp releases)'
  inputs:
    binary: 'terraform'
    terraformVersion: '1.11.3'
    downloadSource: 'hashicorp'
    requireGpgSignature: true
```

### Install OpenTofu

```yaml
- task: PipelineTerraformInstaller@1
  displayName: 'Install OpenTofu 1.9.0'
  inputs:
    binary: 'tofu'
    terraformVersion: '1.9.0'
```

With the default `downloadSource: 'hashicorp'` OpenTofu is downloaded from its GitHub release, and the release's `SHA256SUMS` signature is verified with cosign (`requireCosignVerification`, default `true`). To install it from your own source instead, see [Download OpenTofu from a private registry backend](#download-opentofu-from-a-private-registry-backend) and [Download OpenTofu from an internal mirror](#download-opentofu-from-an-internal-mirror).

### Verify OpenTofu with the task's own cosign

`managed` (the default) downloads a pinned cosign release, verifies it against a SHA256 shipped with the task, and runs only that copy; the agent's `PATH` is never consulted.

```yaml
- task: PipelineTerraformInstaller@1
  displayName: 'Install OpenTofu 1.9.0 (managed cosign)'
  inputs:
    binary: 'tofu'
    terraformVersion: '1.9.0'
    requireCosignVerification: true
    cosignSource: 'managed'
```

### Verify OpenTofu with a cosign provided by the agent

`ambient` runs the `cosign` found on `PATH`, for agent images that bake it in or air-gapped agents. That binary is not integrity-verified unless `cosignSha256` pins its SHA256; with the pin, a mismatch fails the install. Set `requireCosignVerification: false` only to fall back to checksum-only verification.

```yaml
- task: PipelineTerraformInstaller@1
  displayName: 'Install OpenTofu 1.9.0 (agent-provided cosign)'
  inputs:
    binary: 'tofu'
    terraformVersion: '1.9.0'
    cosignSource: 'ambient'
    cosignSha256: '$(COSIGN_BINARY_SHA256)'
```

### Download from a custom mirror

```yaml
- task: PipelineTerraformInstaller@1
  displayName: 'Install Terraform from mirror'
  inputs:
    binary: 'terraform'
    terraformVersion: '1.11.3'
    downloadSource: 'mirror'
    mirrorBaseUrl: 'https://mirror.example.com/terraform'
    requireChecksum: true
```

### Download from an internal mirror on a private address

When `mirrorAllowedHosts` is empty (the default), a mirror host that is a private or link-local address is refused. List the host to allow a legitimate internal mirror.

```yaml
- task: PipelineTerraformInstaller@1
  displayName: 'Install Terraform from internal mirror'
  inputs:
    binary: 'terraform'
    terraformVersion: '1.11.3'
    downloadSource: 'mirror'
    mirrorBaseUrl: 'https://mirror.internal.example.com/hashicorp/terraform'
    mirrorAllowedHosts: 'mirror.internal.example.com'
```

### Download from a mirror that does not serve signature files

Disable `requireGpgSignature` only for a mirror that does not serve `.sig` files, and keep `requireChecksum` on so the download is still checked against `SHA256SUMS`.

```yaml
- task: PipelineTerraformInstaller@1
  displayName: 'Install Terraform from mirror (no signature files)'
  inputs:
    binary: 'terraform'
    terraformVersion: '1.11.3'
    downloadSource: 'mirror'
    mirrorBaseUrl: 'https://mirror.example.com/terraform'
    requireGpgSignature: false
    requireChecksum: true
```

### Download from a private registry backend

```yaml
- task: PipelineTerraformInstaller@1
  displayName: 'Install Terraform from private registry'
  inputs:
    binary: 'terraform'
    terraformVersion: '1.11.3'
    downloadSource: 'registry'
    registryUrl: 'https://registry.example.com'
    registryMirrorName: 'internal'
    # Optional: pin the hosts the install may contact (the registry and its storage).
    registryAllowedHosts: 'registry.example.com, *.blob.core.windows.net'
```

`registryAllowedHosts` (comma- or newline-separated, `*.` wildcards allowed) pins every host the install contacts: the registry itself, the `download_url` it returns, any `shasums_url` and `shasums_signature_url` it advertises, and every redirect on the way. List the registry host as well as the storage host. While the list is empty, a host that is, or resolves to, a private or link-local address is refused and any other host is accepted.

### Download OpenTofu from a private registry backend

`downloadSource: 'registry'` serves OpenTofu as well as Terraform, and `terraformVersion: 'latest'` then resolves through the registry rather than the GitHub releases API. `registryMirrorName` defaults to `terraform`, which names a Terraform mirror, so set it to the name of your OpenTofu mirror configuration.

```yaml
- task: PipelineTerraformInstaller@1
  displayName: 'Install OpenTofu 1.9.0 from private registry'
  inputs:
    binary: 'tofu'
    terraformVersion: '1.9.0'
    downloadSource: 'registry'
    registryUrl: 'https://registry.example.com'
    registryMirrorName: 'opentofu'
    registryAllowedHosts: 'registry.example.com, *.blob.core.windows.net'
```

When the registry advertises the version's `SHA256SUMS` and its signature (terraform-registry-backend stores the `.gpgsig` OpenTofu publishes with each release), the task verifies that signature against the OpenTofu release key embedded in the task and takes the checksum from the verified `SHA256SUMS`. A signature that does not verify fails the install, and `requireGpgSignature` (default `true`) also fails it when the advertised signature cannot be fetched. When the registry advertises no signature, the trust anchor is the `sha256` the registry returns, and the task warns about that on every install. The cosign inputs do not apply to this path. `requireChecksum` (default `true`) fails the install when the registry returns no `sha256`.

### Download OpenTofu from an internal mirror

The mirror serves OpenTofu's release layout without the `v` prefix: `<mirrorBaseUrl>/<version>/tofu_<version>_<os>_<arch>.zip`, with `tofu_<version>_SHA256SUMS` and its cosign signature (`.sig`) and certificate (`.pem`) beside it. The `SHA256SUMS` signature is verified with cosign exactly as for the GitHub release, and `requireGpgSignature` does not apply to an OpenTofu mirror. Pin `terraformVersion`: with a mirror, `latest` is still resolved from the GitHub releases API.

The managed cosign is itself downloaded from github.com. An agent that cannot reach it uses its own cosign, as below, or sets `requireCosignVerification: false` to fall back to checksum-only verification.

```yaml
- task: PipelineTerraformInstaller@1
  displayName: 'Install OpenTofu 1.9.0 from internal mirror'
  inputs:
    binary: 'tofu'
    terraformVersion: '1.9.0'
    downloadSource: 'mirror'
    mirrorBaseUrl: 'https://mirror.internal.example.com/opentofu'
    mirrorAllowedHosts: 'mirror.internal.example.com'
    cosignSource: 'ambient'
    cosignSha256: '$(COSIGN_BINARY_SHA256)'
```

### Re-verify the tool cache on a shared agent

A cached binary that carries no local integrity marker is re-downloaded and re-verified before use whenever `requireChecksum` is on, and an unreachable source only produces a warning. `requireOnlineReverification` turns that warning into a failure. `forceOnlineReverification` goes further: every cache hit is re-downloaded and compared byte for byte with the cached copy, even when its marker is valid. Both default to `false`, which keeps offline and air-gapped cache reuse working.

```yaml
- task: PipelineTerraformInstaller@1
  displayName: 'Install Terraform 1.11.3 (verify the tool cache)'
  inputs:
    binary: 'terraform'
    terraformVersion: '1.11.3'
    requireChecksum: true
    requireOnlineReverification: true
    forceOnlineReverification: true
```

### Use the installed binary's location

Give the step a `name` to read its output variables. `terraformLocation` is the full path of the installed binary (its directory is also prepended to `PATH`). `terraformDownloadedFrom` is `hashicorp`, `opentofu`, `registry:<url>`, `mirror:<url>` or `cache`.

```yaml
- task: PipelineTerraformInstaller@1
  name: tfinstall
  displayName: 'Install Terraform 1.11.3'
  inputs:
    binary: 'terraform'
    terraformVersion: '1.11.3'

- script: |
    echo "Installed: $(tfinstall.terraformLocation)"
    echo "Source: $(tfinstall.terraformDownloadedFrom)"
  displayName: 'Show where Terraform came from'
```

---

## PipelineTerraformProviderMirror@1

Write a `.terraformrc` that routes provider downloads through a network mirror. Run this before `terraform init`.

The mirror is the only source for the providers it serves. Terraform merges the version lists of every installation method that matches a provider and then requires the first matching method to supply the newest version; a network mirror's 404 for a version it never listed stops `terraform init` rather than falling back. So the task never lets `direct` match a provider the mirror matches: `direct` covers only the providers that `mirrorExcludePatterns` and `mirrorIncludePatterns` leave outside the mirror.

### Basic mirror

Every provider comes from the mirror, and only the versions the mirror lists can be selected. A version the origin registry has published but the mirror has not yet synced or approved is simply not offered, so builds keep using the newest version the mirror does have.

```yaml
- task: PipelineTerraformProviderMirror@1
  displayName: 'Configure provider mirror'
  inputs:
    mirrorUrl: 'https://registry.example.com/terraform/providers'
```

`allowDirectFallback` defaults to `true`, but with no mirror patterns there is nothing outside the mirror for it to apply to, so the generated file is the same as with `false`. Set it to `false` anyway where the mirror enforces network isolation or an approved-provider list: a later edit that adds a mirror pattern then cannot open direct internet egress.

```yaml
- task: PipelineTerraformProviderMirror@1
  displayName: 'Configure provider mirror (no direct download, whatever the patterns)'
  inputs:
    mirrorUrl: 'https://registry.example.com/terraform/providers'
    allowDirectFallback: false
```

### Mirror with some providers installed directly

List the providers the mirror should not serve. They are installed from the origin registry; everything else stays on the mirror.

```yaml
- task: PipelineTerraformProviderMirror@1
  displayName: 'Configure provider mirror (two providers direct)'
  inputs:
    mirrorUrl: 'https://registry.example.com/terraform/providers'
    mirrorExcludePatterns: |
      registry.terraform.io/hashicorp/random
      registry.terraform.io/hashicorp/time
```

### Mirror with restricted direct download

`directIncludePatterns` and `directExcludePatterns` narrow what may be downloaded directly; they never take a provider away from the mirror. Here the mirror serves two namespaces, the `acme` namespace may be downloaded directly except for one provider in it, and any other provider has no source at all, so a configuration that asks for one fails at `init`.

```yaml
- task: PipelineTerraformProviderMirror@1
  displayName: 'Configure provider mirror (restricted direct download)'
  inputs:
    mirrorUrl: 'https://registry.example.com/terraform/providers'
    mirrorIncludePatterns: |
      registry.terraform.io/company-internal/*
      registry.terraform.io/hashicorp/*
    directIncludePatterns: |
      registry.terraform.io/acme/*
    directExcludePatterns: |
      registry.terraform.io/acme/experimental
```

A `directIncludePatterns` entry for a provider the mirror still serves has no effect, and the task warns about it: the mirror stays that provider's only source until it is also listed in `mirrorExcludePatterns`.

### Use the mirror for selected providers only

`mirrorIncludePatterns` limits the mirror to the matching providers; every other provider is installed directly, and the generated `direct` block excludes the mirror's providers so the two never overlap. That needs `allowDirectFallback: true` (the default), because with `false` the other providers would have no installation method at all.

The task writes the CLI configuration to a `.terraformrc` in the agent temp directory (owner-only permissions), points `TF_CLI_CONFIG_FILE` at it for the rest of the job, and exposes its path as the `configFilePath` output variable. Give the step a `name` to read it.

```yaml
- task: PipelineTerraformProviderMirror@1
  name: providerMirror
  displayName: 'Configure provider mirror (selected providers)'
  inputs:
    mirrorUrl: 'https://registry.example.com/terraform/providers'
    allowDirectFallback: true
    mirrorIncludePatterns: |
      registry.terraform.io/hashicorp/*

- script: echo "CLI configuration written to $(providerMirror.configFilePath)"
  displayName: 'Show the CLI configuration path'
```

### A caching mirror that fetches any version on request

Some mirrors are pull-through caches: their version list lags behind the origin registry, but they fetch any upstream version when asked for it. For those, `allowDirectForMirroredProviders` writes a `direct` block that overlaps the mirror, so that Terraform learns the newest version from the origin registry and the mirror supplies it. Do not use it with a mirror that publishes versions on its own schedule or behind an approval: `terraform init` then fails whenever the origin registry is ahead of the mirror. The task warns on every run while it is set.

```yaml
- task: PipelineTerraformProviderMirror@1
  displayName: 'Configure provider mirror (pull-through cache)'
  inputs:
    mirrorUrl: 'https://registry.example.com/terraform/providers'
    allowDirectForMirroredProviders: true
```

---

## PipelineTerraformTask@5

Execute Terraform commands. Most pipelines combine `init` → `plan` → `apply`.

---

### Azure (azurerm)

#### Init with AzureRM backend

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Init'
  inputs:
    provider: 'azurerm'
    command: 'init'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
    backendServiceArm: 'my-azure-service-connection'
    backendAzureRmStorageAccountName: 'mytfstateaccount'
    backendAzureRmContainerName: 'tfstate'
    backendAzureRmKey: 'prod.terraform.tfstate'
```

#### Init with the state storage account in another subscription

`backendAzureRmResourceGroupName` writes the storage account's resource group into the backend configuration. `backendAzureRmOverrideSubscriptionID` replaces the service connection's subscription for the storage account lookup; the subscription is only written to the backend configuration together with a resource group.

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Init (state in another subscription)'
  inputs:
    provider: 'azurerm'
    command: 'init'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
    backendServiceArm: 'my-azure-service-connection'
    backendAzureRmResourceGroupName: 'rg-tfstate'
    backendAzureRmOverrideSubscriptionID: '00000000-0000-0000-0000-000000000000'
    backendAzureRmStorageAccountName: 'mytfstateaccount'
    backendAzureRmContainerName: 'tfstate'
    backendAzureRmKey: 'prod.terraform.tfstate'
```

#### Init with a single-use OIDC token for the backend

With a Workload Identity Federation service connection, the default is to export the pipeline's refreshable OIDC token to Terraform for the whole run. `backendAzureRmUseIdTokenGeneration: true` generates a single-use, narrower-scoped `ARM_OIDC_TOKEN` up front instead, which is the safer choice when the configuration runs untrusted or third-party modules on shared agents. See [Token modes and exposure](setup/azure-wif-setup.md#token-modes-and-exposure).

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Init (single-use token)'
  inputs:
    provider: 'azurerm'
    command: 'init'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
    backendServiceArm: 'my-azure-service-connection'
    backendAzureRmStorageAccountName: 'mytfstateaccount'
    backendAzureRmContainerName: 'tfstate'
    backendAzureRmKey: 'prod.terraform.tfstate'
    backendAzureRmUseIdTokenGeneration: true
```

#### Plan (AzureRM)

```yaml
- task: PipelineTerraformTask@5
  name: terraformPlan
  displayName: 'Terraform Plan'
  inputs:
    provider: 'azurerm'
    command: 'plan'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
    commandOptions: '-out=tfplan'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
    publishPlanResults: 'MyPlan'
```

#### Plan with a structured summary (Terraform tab)

`publishPlanSummary` publishes a redacted, structured JSON summary of the plan (resource changes, outputs, drift) to the **Terraform** tab, independently of `publishPlanResults`; enable either, both or neither. The task builds it from `terraform show -json` of the saved plan and adds `-out=<tempfile>` itself unless `commandOptions` already names a plan file. Every sensitive value renders as `(sensitive)`, but that redaction depends on the module and its providers marking values `sensitive`.

```yaml
- task: PipelineTerraformTask@5
  name: terraformPlan
  displayName: 'Terraform Plan (structured summary)'
  inputs:
    provider: 'azurerm'
    command: 'plan'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
    commandOptions: '-out=tfplan'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
    publishPlanSummary: 'MyPlan'
```

#### Plan with targets, a forced replacement and limits

`targetResources` takes one address per line, each passed as `-target=<address>`. `replaceAddress` is passed as `-replace=<address>` (Terraform 1.0 or later) and `parallelism` as `-parallelism=<n>`. `commandTimeoutMinutes` ends the Terraform process when it runs longer than that many minutes and fails the step; the default `0` sets no limit, and the limit applies to every command the task runs.

`targetResources` and `parallelism` also apply to `apply`, `destroy` and `refresh`, and `replaceAddress` also to `apply`. When an `apply` step applies a saved plan, set `targetResources` and `replaceAddress` on the plan step instead: Terraform rejects planning options together with a saved plan.

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Plan (targeted)'
  inputs:
    provider: 'azurerm'
    command: 'plan'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
    commandOptions: '-out=tfplan'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
    targetResources: |
      azurerm_resource_group.main
      module.network
    replaceAddress: 'azurerm_linux_virtual_machine.app'
    parallelism: '4'
    commandTimeoutMinutes: '30'
```

#### Refresh-only plan (drift detection)

`refreshOnly: true` runs Terraform in refresh-only mode: it compares the state with the real infrastructure and reports drift without proposing any resource change. It is available on `plan` and `apply`.

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Plan (refresh only)'
  inputs:
    provider: 'azurerm'
    command: 'plan'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
    refreshOnly: true
```

#### Plan in another subscription, with `az login` and a single-use token

- `environmentAzureRmOverrideSubscriptionID` replaces the service connection's subscription as the provider's target (`ARM_SUBSCRIPTION_ID`).
- `runAzLogin: true` signs the Azure CLI in with the service connection first, for `local-exec` provisioners, `external` data sources and modules that use CLI authentication (for example `azapi`). It needs the Azure CLI on the agent, and on a shared agent the federated token or client secret is briefly visible in the `az login` process arguments; see [SECURITY.md](../SECURITY.md).
- `environmentAzureRmUseIdTokenGeneration: true` generates a single-use, narrower-scoped `ARM_OIDC_TOKEN` up front instead of exporting the pipeline's refreshable OIDC token for the whole run. Prefer it when the configuration runs untrusted or third-party modules; the input's help warns that it may cause unexpected timeouts. See [Token modes and exposure](setup/azure-wif-setup.md#token-modes-and-exposure).

```yaml
- task: PipelineTerraformTask@5
  name: terraformPlan
  displayName: 'Terraform Plan (other subscription)'
  inputs:
    provider: 'azurerm'
    command: 'plan'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
    commandOptions: '-out=tfplan'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
    environmentAzureRmOverrideSubscriptionID: '11111111-1111-1111-1111-111111111111'
    environmentAzureRmUseIdTokenGeneration: true
    runAzLogin: true
```

#### Apply (only when changes present)

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Apply'
  condition: and(succeeded(), eq(variables['terraformPlan.changesPresent'], 'true'))
  inputs:
    provider: 'azurerm'
    command: 'apply'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
    commandOptions: 'tfplan'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
```

#### Apply with a structured summary (Terraform tab)

`publishApplyResults` publishes a redacted, structured JSON summary (per-resource
status and timing, outputs) to the **Terraform** tab's Apply pivot, alongside the
plain apply. The task runs `apply` with `-json` for this and still echoes each
event's message to the live log.

Provider diagnostics are freeform text that a provider can build from user or
resource input, so the summary leaves them out unless you opt in with
`includeDiagnostics` (default `false`). The apply outcome and per-resource status
are always published, and the full error text stays in the secret-masked job log.
`includeDiagnosticDetail` (default `false`) only adds each diagnostic's longer
`detail` once `includeDiagnostics` is on; neither input does anything without
`publishApplyResults`. See [SECURITY.md](../SECURITY.md) for the residual risk.

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Apply'
  condition: and(succeeded(), eq(variables['terraformPlan.changesPresent'], 'true'))
  inputs:
    provider: 'azurerm'
    command: 'apply'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
    commandOptions: 'tfplan'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
    publishApplyResults: 'MyApply'
    includeDiagnostics: false        # default; no provider diagnostics in the summary
    includeDiagnosticDetail: false   # default
```

#### Apply summary with provider diagnostics

Opt in only when everyone who can read the build results may see provider-authored error and warning text: the task scrubs that text on a best-effort basis, so a short secret that a provider echoes can still slip through. `includeDiagnostics: true` adds each diagnostic's `summary`, and `includeDiagnosticDetail: true` adds its `detail` as well.

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Apply (with diagnostics)'
  condition: and(succeeded(), eq(variables['terraformPlan.changesPresent'], 'true'))
  inputs:
    provider: 'azurerm'
    command: 'apply'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
    commandOptions: 'tfplan'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
    publishApplyResults: 'MyApply'
    includeDiagnostics: true
    includeDiagnosticDetail: true
```

#### Destroy (AzureRM)

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Destroy'
  inputs:
    provider: 'azurerm'
    command: 'destroy'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
```

#### Destroy with a structured summary

`publishPlanSummary` also works on `destroy`: the summary is built from the destroy's own plan and the tab labels it as a destroy. Destroy still auto-approves and still fails the step on a non-zero exit.

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Destroy (structured summary)'
  inputs:
    provider: 'azurerm'
    command: 'destroy'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
    publishPlanSummary: 'MyDestroy'
```

---

### AWS

Workload Identity Federation (`WorkloadIdentityFederation`) is the recommended scheme: it uses short-lived OIDC tokens, so there is no long-lived access key to leak or rotate. `ServiceConnection`, the default, uses the static credentials stored in the service connection and is kept for backward compatibility. The provider (`environmentAuthSchemeAWS`) and the S3 backend (`backendAuthSchemeAWS`) each choose their own scheme. See the [AWS WIF Setup Guide](setup/aws-wif-setup.md) for the one-time IAM configuration.

#### Init with S3 backend

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Init'
  inputs:
    provider: 'aws'
    command: 'init'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
    backendType: 's3'
    backendServiceAWS: 'my-aws-service-connection'
    backendAuthSchemeAWS: 'ServiceConnection'   # default; static credentials from the service connection
    backendAWSBucketName: 'my-tfstate-bucket'
    backendAWSKey: 'prod/terraform.tfstate'
```

#### Init with S3 backend (Workload Identity Federation)

The task requests an Azure DevOps OIDC token for the service connection and assumes `backendAWSRoleArn` with it; no static access key is involved. `backendAWSRegion` is the region of the bucket. `backendAWSSessionName` is optional: leave it out and the task derives a per-run name (`ado-tf-backend-<TeamProject>-<BuildId>`), and set it only when the role's trust policy pins `sts:RoleSessionName` (2-64 characters from `A-Za-z0-9_+=,.@-`). See [pinning the role session name](setup/aws-wif-setup.md#optional-pinning-the-role-session-name).

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Init (S3 backend, Workload Identity Federation)'
  inputs:
    provider: 'aws'
    command: 'init'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
    backendType: 's3'
    backendServiceAWS: 'my-aws-service-connection'
    backendAuthSchemeAWS: 'WorkloadIdentityFederation'
    backendAWSRoleArn: 'arn:aws:iam::123456789012:role/TerraformBackendRole'
    backendAWSRegion: 'us-east-1'
    backendAWSSessionName: 'ado-tf-backend-prod'
    backendAWSBucketName: 'my-tfstate-bucket'
    backendAWSKey: 'prod/terraform.tfstate'
```

#### Plan (AWS)

```yaml
- task: PipelineTerraformTask@5
  name: terraformPlan
  displayName: 'Terraform Plan'
  inputs:
    provider: 'aws'
    command: 'plan'
    commandOptions: '-out=tfplan'
    environmentServiceNameAWS: 'my-aws-service-connection'
    environmentAuthSchemeAWS: 'ServiceConnection'   # default; static credentials from the service connection
```

#### Plan (AWS, Workload Identity Federation)

The task assumes `awsRoleArn` with an Azure DevOps OIDC token for the service connection. `awsRegion` is the provider's region and is required with this scheme. `awsSessionName` is optional in the same way as `backendAWSSessionName` above; leave it out to get `ado-tf-<TeamProject>-<BuildId>`.

```yaml
- task: PipelineTerraformTask@5
  name: terraformPlan
  displayName: 'Terraform Plan (Workload Identity Federation)'
  inputs:
    provider: 'aws'
    command: 'plan'
    commandOptions: '-out=tfplan'
    environmentServiceNameAWS: 'my-aws-service-connection'
    environmentAuthSchemeAWS: 'WorkloadIdentityFederation'
    awsRoleArn: 'arn:aws:iam::123456789012:role/TerraformDeployRole'
    awsRegion: 'us-east-1'
    awsSessionName: 'ado-tf-prod'
```

#### Apply (AWS)

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Apply'
  condition: and(succeeded(), eq(variables['terraformPlan.changesPresent'], 'true'))
  inputs:
    provider: 'aws'
    command: 'apply'
    commandOptions: 'tfplan'
    environmentServiceNameAWS: 'my-aws-service-connection'
```

---

### GCP

As with AWS, Workload Identity Federation is the recommended scheme: it uses short-lived OIDC tokens, so there is no long-lived service account key to leak or rotate. `ServiceConnection`, the default, uses the service account key stored in the service connection and is kept for backward compatibility. The provider (`environmentAuthSchemeGCP`) and the GCS backend (`backendAuthSchemeGCP`) each choose their own scheme. See the [GCP WIF Setup Guide](setup/gcp-wif-setup.md) for the one-time pool and provider configuration.

#### Init with GCS backend

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Init'
  inputs:
    provider: 'gcp'
    command: 'init'
    backendType: 'gcs'
    backendServiceGCP: 'my-gcp-service-connection'
    backendAuthSchemeGCP: 'ServiceConnection'   # default; service account key from the service connection
    backendGCPBucketName: 'my-tfstate-bucket'
    backendGCPPrefix: 'prod'
```

#### Init with GCS backend (Workload Identity Federation)

The task builds external-account credentials from an Azure DevOps OIDC token, the workload identity pool and provider, and the service account; Terraform exchanges them for a short-lived access token, so no key file is involved. `backendGCPProjectNumber` is the numeric number of the project that hosts the pool.

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Init (GCS backend, Workload Identity Federation)'
  inputs:
    provider: 'gcp'
    command: 'init'
    backendType: 'gcs'
    backendServiceGCP: 'my-gcp-service-connection'
    backendAuthSchemeGCP: 'WorkloadIdentityFederation'
    backendGCPProjectNumber: '123456789012'
    backendGCPWorkloadIdentityPoolId: 'azure-devops-pool'
    backendGCPWorkloadIdentityProviderId: 'azure-devops-provider'
    backendGCPServiceAccountEmail: 'terraform-deployer@my-project.iam.gserviceaccount.com'
    backendGCPBucketName: 'my-tfstate-bucket'
    backendGCPPrefix: 'prod'
```

#### Plan (GCP)

```yaml
- task: PipelineTerraformTask@5
  name: terraformPlan
  displayName: 'Terraform Plan'
  inputs:
    provider: 'gcp'
    command: 'plan'
    commandOptions: '-out=tfplan'
    environmentServiceNameGCP: 'my-gcp-service-connection'
    environmentAuthSchemeGCP: 'ServiceConnection'   # default; service account key from the service connection
```

#### Plan (GCP, Workload Identity Federation)

`gcpProjectId` sets `GOOGLE_PROJECT`, the project the Google provider uses by default. When it is empty, the project number from `gcpProjectNumber` is used instead, which is a different identifier, so set it.

```yaml
- task: PipelineTerraformTask@5
  name: terraformPlan
  displayName: 'Terraform Plan (Workload Identity Federation)'
  inputs:
    provider: 'gcp'
    command: 'plan'
    commandOptions: '-out=tfplan'
    environmentServiceNameGCP: 'my-gcp-service-connection'
    environmentAuthSchemeGCP: 'WorkloadIdentityFederation'
    gcpProjectNumber: '123456789012'
    gcpProjectId: 'my-project'
    gcpWorkloadIdentityPoolId: 'azure-devops-pool'
    gcpWorkloadIdentityProviderId: 'azure-devops-provider'
    gcpServiceAccountEmail: 'terraform-deployer@my-project.iam.gserviceaccount.com'
```

---

### OCI

#### Init with OCI backend

The OCI backend is an HTTP backend that points at an Object Storage pre-authenticated request (PAR). With `backendOCIConfigGenerate: 'yes'` the task writes the `backend "http"` block from `backendOCIPar` into a `config-<uuid>.tf` file in the working directory, then overwrites and deletes that file when the step ends. The PAR URL is a bearer credential, so keep it in a secret variable.

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Init'
  inputs:
    provider: 'oci'
    command: 'init'
    backendType: 'oci'
    backendServiceOCI: 'my-oci-service-connection'
    backendOCIConfigGenerate: 'yes'   # default; the task generates the backend block
    backendOCIPar: '$(ociBackendPar)'   # secret variable; the /p/<token>/ segment is a bearer credential
```

#### Init with the OCI backend declared in the configuration

Use `backendOCIConfigGenerate: 'no'` when the configuration's own `.tf` files already declare the backend. The task then writes nothing and does not need `backendOCIPar`.

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Init (backend declared in the configuration)'
  inputs:
    provider: 'oci'
    command: 'init'
    backendType: 'oci'
    backendServiceOCI: 'my-oci-service-connection'
    backendOCIConfigGenerate: 'no'
```

#### Plan (OCI)

```yaml
- task: PipelineTerraformTask@5
  name: terraformPlan
  displayName: 'Terraform Plan'
  inputs:
    provider: 'oci'
    command: 'plan'
    commandOptions: '-out=tfplan'
    environmentServiceNameOCI: 'my-oci-service-connection'
    environmentAuthSchemeOCI: 'ServiceConnection'   # default; API key from the service connection
```

#### Plan (OCI, Workload Identity Federation)

See the [OCI WIF Setup Guide](setup/oci-wif-setup.md) for the one-time Identity Domain configuration this requires.

```yaml
- task: PipelineTerraformTask@5
  name: terraformPlan
  displayName: 'Terraform Plan'
  inputs:
    provider: 'oci'
    command: 'plan'
    commandOptions: '-out=tfplan'
    environmentServiceNameOCI: 'my-oci-service-connection'
    environmentAuthSchemeOCI: 'WorkloadIdentityFederation'
    ociWifTenancyOcid: 'ocid1.tenancy.oc1..aaaaaaaa...'
    ociWifRegion: 'us-ashburn-1'
    ociWifIdentityDomainUrl: 'https://idcs-abc123.identity.oraclecloud.com'
    ociWifClientId: 'my-identity-domain-app-client-id'
```

#### Apply (OCI), scrubbing the cached backend PAR

`terraform init` copies the PAR URL into `.terraform/terraform.tfstate` in the working directory. The task leaves that cache alone by default because later steps need it. `cleanupOCIBackendCache: true` overwrites and deletes it when the step ends, so enable it only on the last step that touches state in that working directory, which is `apply` or `destroy` in most pipelines.

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Apply'
  condition: and(succeeded(), eq(variables['terraformPlan.changesPresent'], 'true'))
  inputs:
    provider: 'oci'
    command: 'apply'
    commandOptions: 'tfplan'
    environmentServiceNameOCI: 'my-oci-service-connection'
    cleanupOCIBackendCache: true
```

---

### OpenTofu

`binaryName: 'tofu'` makes the task run OpenTofu instead of Terraform. The binary must be installed on the agent and available on `PATH`, which `PipelineTerraformInstaller@1` with `binary: 'tofu'` takes care of. Set `binaryName` on every `PipelineTerraformTask@5` step that should use OpenTofu; the default is `terraform`.

```yaml
- task: PipelineTerraformInstaller@1
  displayName: 'Install OpenTofu 1.9.0'
  inputs:
    binary: 'tofu'
    terraformVersion: '1.9.0'

- task: PipelineTerraformTask@5
  displayName: 'OpenTofu Init'
  inputs:
    provider: 'azurerm'
    command: 'init'
    binaryName: 'tofu'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
    backendServiceArm: 'my-azure-service-connection'
    backendAzureRmStorageAccountName: 'mytfstateaccount'
    backendAzureRmContainerName: 'tfstate'
    backendAzureRmKey: 'prod.terraform.tfstate'

- task: PipelineTerraformTask@5
  name: tofuPlan
  displayName: 'OpenTofu Plan'
  inputs:
    provider: 'azurerm'
    command: 'plan'
    binaryName: 'tofu'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
    commandOptions: '-out=tfplan'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
```

---

### Additional commands

#### Validate

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Validate'
  inputs:
    provider: 'azurerm'
    command: 'validate'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
```

#### Format check

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Format Check'
  inputs:
    provider: 'azurerm'
    command: 'fmt'
    fmtCheck: true
    fmtRecursive: true
    fmtDiff: true
```

#### Download modules

`get` runs `terraform get` and takes no service connection. Extra flags such as `-update` go in `commandOptions`.

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Get'
  inputs:
    provider: 'azurerm'
    command: 'get'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
    commandOptions: '-update'
```

#### Init with a read-only lock file

`lockfileReadonly: true` passes `-lockfile=readonly`, so `init` never rewrites the dependency lock file (`.terraform.lock.hcl`). It is recommended for CI: commit the lock file, and `init` then fails, instead of updating the file, when the providers the configuration requires no longer match it.

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Init (read-only lock file)'
  inputs:
    provider: 'azurerm'
    command: 'init'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
    backendServiceArm: 'my-azure-service-connection'
    backendAzureRmStorageAccountName: 'mytfstateaccount'
    backendAzureRmContainerName: 'tfstate'
    backendAzureRmKey: 'prod.terraform.tfstate'
    lockfileReadonly: true
```

#### Output

`output` has no `outputTo` or `filename` input. It always writes every output, as JSON, to a file under the agent temp directory (`Agent.TempDirectory`) and exports the path as the `jsonOutputVariablesPath` output variable, so give the step a `name` and read the path from it. The task also sets a pipeline variable `TF_OUT_<output name>` for every output, which later steps read as `$(<step name>.TF_OUT_<output name>)`. It is masked as a secret only when the module declares that output `sensitive = true`.

```yaml
- task: PipelineTerraformTask@5
  name: tfoutput
  displayName: 'Terraform Output'
  inputs:
    provider: 'azurerm'
    command: 'output'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
    environmentServiceNameAzureRM: 'my-azure-service-connection'

- script: jq -r '.resource_group_name.value' "$(tfoutput.jsonOutputVariablesPath)"
  displayName: 'Read one output from the JSON file'
```

#### Output (delete the file, fail on sensitive outputs)

The JSON file holds every output's real value, including outputs marked `sensitive`. It stays in the agent temp directory until the job ends, except that a file containing a sensitive output is deleted at the end of the step (`cleanupOutputFileIfSensitive`, default `true`).

- `cleanupOutputFile: true` always deletes the file at the end of the step. Use it when the step only needs the `TF_OUT_<output name>` variables.
- `failOnSensitiveOutputs: true` fails the step, and deletes the file, when any output is `sensitive`. With `cleanupOutputFile: true` it only warns, because the file is deleted anyway.
- `cleanupOutputFileIfSensitive: false` keeps a file that contains sensitive outputs, in cleartext, until the job ends. Set it only when a later step in the same job must read a sensitive value from the file.

```yaml
- task: PipelineTerraformTask@5
  name: tfoutputVars
  displayName: 'Terraform Output (variables only)'
  inputs:
    provider: 'azurerm'
    command: 'output'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
    cleanupOutputFile: true

- task: PipelineTerraformTask@5
  name: tfoutputStrict
  displayName: 'Terraform Output (fail on sensitive outputs)'
  inputs:
    provider: 'azurerm'
    command: 'output'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
    failOnSensitiveOutputs: true

- task: PipelineTerraformTask@5
  name: tfoutputKeep
  displayName: 'Terraform Output (keep a file with sensitive outputs)'
  inputs:
    provider: 'azurerm'
    command: 'output'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
    cleanupOutputFileIfSensitive: false
```

#### Show a plan as JSON

`outputTo: 'file'` with `outputFormat: 'json'` writes the plan as JSON to `filename`, exports the file's path as `showFilePath`, and sets `destroyChangesPresent` to `true` (with a warning) when the plan deletes or replaces any resource. Give the step a `name` to read those variables.

The file can hold values Terraform marks `sensitive` in cleartext, so write it outside any directory that is published as an artifact, for example under `$(Agent.TempDirectory)`. When the plan contains sensitive values the task deletes the file at the end of the step (`cleanupShowFileIfSensitive`, default `true`), so a later step that reads `$(tfshow.showFilePath)` needs `cleanupShowFileIfSensitive: false`. The file is still deleted if the build is cancelled.

```yaml
- task: PipelineTerraformTask@5
  name: tfshow
  displayName: 'Terraform Show'
  inputs:
    provider: 'azurerm'
    command: 'show'
    commandOptions: 'tfplan'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
    outputTo: 'file'
    outputFormat: 'json'
    filename: '$(Agent.TempDirectory)/plan.json'
    cleanupShowFileIfSensitive: false

- script: jq -r '.resource_changes[] | select(.change.actions | index("delete")) | .address' "$(tfshow.showFilePath)"
  displayName: 'List resources that would be deleted'
  condition: eq(variables['tfshow.destroyChangesPresent'], 'true')
```

`failOnSensitiveOutputs: true` turns the warning about sensitive plan outputs into a failure and deletes the file first; sensitive resource attributes still only warn. It also applies to `outputTo: 'console'` with `outputFormat: 'json'`, where the step fails before anything is printed.

#### Show the current state

Without a plan file in `commandOptions`, `show` prints the current state. `publishStateResults` also attaches a redacted JSON inventory of the state (resources, data sources and outputs, with sensitive values shown as `(sensitive)`) to the Terraform tab of the pipeline run. It has no effect when `commandOptions` names a plan file.

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Show (state)'
  inputs:
    provider: 'azurerm'
    command: 'show'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
    outputTo: 'console'
    outputFormat: 'default'
    publishStateResults: 'production'
```

#### Workspace

`workspace`, `state` and `forceunlock` steps take no service connection input when the state backend is on the same cloud as `provider` (see the [service connection requirements](../README.md#service-connection-requirements-by-command)). A backend on a different cloud needs that backend's connection inputs on these steps; see [Cross-cloud state backends](#cross-cloud-state-backends).

`workspaceSubCommand` is `new`, `select`, `list`, `delete` or `show`; `list` and `show` need no `workspaceName`. `workspaceName` is passed to Terraform as one argument, so it cannot carry flags. `new` fails when the workspace already exists, and Terraform cannot delete the workspace that is currently selected, so select another one first.

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Workspace New'
  inputs:
    provider: 'azurerm'
    command: 'workspace'
    workspaceSubCommand: 'new'
    workspaceName: 'staging'

- task: PipelineTerraformTask@5
  displayName: 'Terraform Workspace Select'
  inputs:
    provider: 'azurerm'
    command: 'workspace'
    workspaceSubCommand: 'select'
    workspaceName: 'production'

- task: PipelineTerraformTask@5
  displayName: 'Terraform Workspace Delete'
  inputs:
    provider: 'azurerm'
    command: 'workspace'
    workspaceSubCommand: 'delete'
    workspaceName: 'staging'
```

#### State

`stateSubCommand` is `list`, `show`, `rm`, `mv`, `replace-provider`, `pull` or `push`. `stateAddress` is passed to Terraform as a single argument, so sub-commands that take two addresses (`mv`, `replace-provider`) take them in `commandOptions` instead. These sub-commands change the real state: add `-dry-run` to `commandOptions` to preview `mv` and `rm` first.

`pull` prints the whole state, including sensitive values, to the job log, and `push` overwrites the remote state with a local file (`stateAddress` is the path of that file), so neither has an example here.

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform State List'
  inputs:
    provider: 'azurerm'
    command: 'state'
    stateSubCommand: 'list'

- task: PipelineTerraformTask@5
  displayName: 'Terraform State Show'
  inputs:
    provider: 'azurerm'
    command: 'state'
    stateSubCommand: 'show'
    stateAddress: 'azurerm_resource_group.main'

- task: PipelineTerraformTask@5
  displayName: 'Terraform State Remove'
  inputs:
    provider: 'azurerm'
    command: 'state'
    stateSubCommand: 'rm'
    stateAddress: 'azurerm_storage_account.legacy'

- task: PipelineTerraformTask@5
  displayName: 'Terraform State Move'
  inputs:
    provider: 'azurerm'
    command: 'state'
    stateSubCommand: 'mv'
    commandOptions: 'azurerm_resource_group.old azurerm_resource_group.new'

- task: PipelineTerraformTask@5
  displayName: 'Terraform State Replace Provider'
  inputs:
    provider: 'azurerm'
    command: 'state'
    stateSubCommand: 'replace-provider'
    commandOptions: '-auto-approve registry.terraform.io/-/azurerm registry.terraform.io/hashicorp/azurerm'
```

#### Refresh

`refresh` updates the state to match the real infrastructure and needs the provider connection. Terraform deprecates `terraform refresh` in favour of a refresh-only plan and apply (`refreshOnly: true`), which lets you review the changes first.

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Refresh'
  inputs:
    provider: 'azurerm'
    command: 'refresh'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
    varFile: 'environments/prod.tfvars'
```

#### Import a resource

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Import'
  inputs:
    provider: 'azurerm'
    command: 'import'
    importAddress: 'azurerm_resource_group.main'
    importId: '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/my-rg'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
```

#### Force-unlock

`forceunlock` removes a stuck lock from the state; take the lock ID from the "Error acquiring the state lock" message. The task always passes `-force`, so Terraform does not prompt, and it logs a warning because other users or automation can acquire the lock afterwards. It takes no service connection when the state backend is on the same cloud as `provider`.

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Force Unlock'
  inputs:
    provider: 'azurerm'
    command: 'forceunlock'
    lockId: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
```

#### Custom command

`custom` runs any other Terraform command line, such as `providers lock`, and needs the provider connection.

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Custom Command'
  inputs:
    provider: 'azurerm'
    command: 'custom'
    customCommand: 'providers lock -platform=linux_amd64'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
```

#### Custom command (write the output to a file)

`outputTo: 'file'` writes the command's output to `filename` and exports its path as `customFilePath`. The output of `graph` holds no values, so publishing it is safe. For a command whose output can hold secrets, write the file outside any published directory, as in the `show` example above.

```yaml
- task: PipelineTerraformTask@5
  name: tfgraph
  displayName: 'Terraform Graph'
  inputs:
    provider: 'azurerm'
    command: 'custom'
    customCommand: 'graph'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
    outputTo: 'file'
    filename: '$(Build.ArtifactStagingDirectory)/graph.dot'

- task: PublishPipelineArtifact@1
  displayName: 'Publish the dependency graph'
  inputs:
    targetPath: '$(tfgraph.customFilePath)'
    artifact: 'terraform-graph'
```

#### Test

`terraform test` needs no service connection for unit tests. Add the provider connection for integration tests whose `run` blocks use `command = apply`. `testFilter` restricts the run to one test file. `testJunitXmlPath` writes a JUnit XML report (Terraform 1.6 or later) that `PublishTestResults@2` can publish to the pipeline's Tests tab.

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Test (unit)'
  inputs:
    provider: 'azurerm'
    command: 'test'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
    testFilter: 'tests/unit.tftest.hcl'

- task: PipelineTerraformTask@5
  displayName: 'Terraform Test (integration)'
  inputs:
    provider: 'azurerm'
    command: 'test'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
    testJunitXmlPath: '$(Agent.TempDirectory)/terraform-tests.xml'

- task: PublishTestResults@2
  displayName: 'Publish Terraform test results'
  condition: succeededOrFailed()
  inputs:
    testResultsFormat: 'JUnit'
    testResultsFiles: 'terraform-tests.xml'
    searchFolder: '$(Agent.TempDirectory)'
```

---

### Variables and var files

#### Inline variables

Each line becomes a separate `-var` flag, and lines that start with `#` are ignored. The values appear on the command line, so keep secrets out of this input: use a secure variables file (below) or a `TF_VAR_<name>` environment variable that the step maps from a secret variable.

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Plan'
  inputs:
    provider: 'azurerm'
    command: 'plan'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
    terraformVariables: |
      environment=production
      location=eastus
      instance_count=3
```

#### Var files

`varFile` takes one `.tfvars` path per line, relative to the working directory, and each becomes a `-var-file` flag. Variable values are read when the plan is created and are stored in the saved plan, so give them to `plan` and apply the saved plan without them: an `apply` of a saved plan may not carry `varFile`, `secureVarsFile` or `terraformVariables`.

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Plan'
  inputs:
    provider: 'azurerm'
    command: 'plan'
    commandOptions: '-out=tfplan'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
    varFile: |
      environments/prod.tfvars
      environments/prod-overrides.tfvars
```

#### Secure var file (from ADO Secure Files)

The file is downloaded from the Secure Files library to a temporary location, passed as `-var-file`, and deleted when the step ends. String values in it are registered with the log's secret masker; values shorter than four characters, and numbers and booleans, are not masked.

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Plan'
  inputs:
    provider: 'azurerm'
    command: 'plan'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
    secureVarsFile: 'prod-secrets.tfvars'
```

---

### HCP Terraform / Terraform Cloud backend

`backendHCPToken` is a secret, so pass a variable. `backendHCPOrganization` and `backendHCPWorkspace` are optional: when they are left out, Terraform reads them from the `cloud {}` block in the configuration. The task runs Terraform on the agent, so set the HCP workspace's execution mode to Local for the provider credentials of the pipeline to be used; with Remote execution the run happens on HCP Terraform with the credentials configured on the workspace.

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Init (HCP)'
  inputs:
    provider: 'azurerm'
    command: 'init'
    backendType: 'hcp'
    backendHCPToken: '$(HCP_TOKEN)'
    backendHCPOrganization: 'my-org'
    backendHCPWorkspace: 'my-workspace'
```

---

### Generic and local backends

`backendType: 'generic'` passes `backendConfigFile` and `backendConfigArgs` to `terraform init` as `-backend-config` options, which suits a backend that has no dedicated inputs, such as `http` or `pg`. The configuration must declare an empty block for that backend (for example `backend "http" {}`), and the values given here complete it. `backendConfigFile` is the path of a `.tfbackend` file, and every line of `backendConfigArgs` that is a `key=value` pair becomes its own flag; lines that start with `#` are ignored.

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Init (generic backend)'
  inputs:
    provider: 'azurerm'
    command: 'init'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
    backendType: 'generic'
    backendConfigFile: 'backends/prod.tfbackend'
    backendConfigArgs: |
      # one -backend-config flag per line
      address=https://tfstate.example.com/prod
      lock_address=https://tfstate.example.com/prod/lock
```

Terraform stores `-backend-config` values in plain text in `.terraform/terraform.tfstate` and in saved plan files, so do not put credentials in them. Supply credentials through environment variables on the step instead.

`backendType: 'local'` keeps the state in a file on the agent, so it needs no service connection and no backend inputs. The state does not outlive the agent; use it for throwaway or validation-only runs.

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Init (local backend)'
  inputs:
    provider: 'azurerm'
    command: 'init'
    workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
    backendType: 'local'
```

---

### Full pipeline example (AzureRM)

```yaml
stages:
  - stage: Deploy
    jobs:
      - job: Terraform
        pool:
          vmImage: 'ubuntu-latest'
        steps:
          - task: PipelineTerraformInstaller@1
            displayName: 'Install Terraform'
            inputs:
              binary: 'terraform'
              terraformVersion: 'latest'

          - task: PipelineTerraformTask@5
            displayName: 'Terraform Init'
            inputs:
              provider: 'azurerm'
              command: 'init'
              workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
              backendServiceArm: 'my-azure-service-connection'
              backendAzureRmStorageAccountName: 'mytfstateaccount'
              backendAzureRmContainerName: 'tfstate'
              backendAzureRmKey: 'prod.terraform.tfstate'

          - task: PipelineTerraformTask@5
            displayName: 'Terraform Validate'
            inputs:
              provider: 'azurerm'
              command: 'validate'
              workingDirectory: '$(System.DefaultWorkingDirectory)/infra'

          - task: PipelineTerraformTask@5
            name: terraformPlan
            displayName: 'Terraform Plan'
            inputs:
              provider: 'azurerm'
              command: 'plan'
              workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
              commandOptions: '-out=tfplan'
              environmentServiceNameAzureRM: 'my-azure-service-connection'
              publishPlanResults: 'MyPlan'

          - task: PipelineTerraformTask@5
            displayName: 'Terraform Apply'
            condition: and(succeeded(), eq(variables['terraformPlan.changesPresent'], 'true'))
            inputs:
              provider: 'azurerm'
              command: 'apply'
              workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
              commandOptions: 'tfplan'
              environmentServiceNameAzureRM: 'my-azure-service-connection'
```

---

## Cross-cloud state backends

These examples combine a remote state backend from one cloud with provider credentials for another.
The `provider` input controls which cloud authenticates for the Terraform *provider* (resources).
The `backendType` input (on `init`) controls which cloud stores *state*.

**Every state-accessing command needs backend credentials, not just `init`.** The
task detects the initialized backend from `.terraform/terraform.tfstate` and, when
it differs from the `provider` input, automatically supplies that backend's
credentials as environment variables on `plan`, `apply`, `destroy`, `refresh`,
`import`, `output`, `state`, `workspace`, and `forceunlock` — so add the backend
inputs (`backendServiceArm`/`backendAzureRm*`, `backendServiceAWS`/`backendAWS*`,
`backendServiceGCP`/`backendGCP*`, or `backendHCP*`) to **every** step below that
runs one of those commands, not just `init`. (`show` and `custom` are not
auto-injected — they commonly operate on a saved plan file or run backend-agnostic
commands like `terraform providers`, so requiring backend inputs there would be
confusing; add them manually if a particular `custom` command needs backend access.)

If a state-accessing step is missing the required backend inputs, the task fails
fast with an actionable error naming the detected backend, the provider, and the
command — instead of the opaque `Please run 'az login'`-style failure this gap
used to produce.

---

### AzureRM state backend + AWS resources

Store state in Azure Blob Storage while managing AWS infrastructure.

```yaml
steps:
  - task: PipelineTerraformInstaller@1
    displayName: 'Install Terraform'
    inputs:
      binary: 'terraform'
      terraformVersion: 'latest'

  - task: PipelineTerraformTask@5
    displayName: 'Terraform Init'
    inputs:
      provider: 'aws'
      command: 'init'
      workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
      backendType: 'azurerm'
      backendServiceArm: 'my-azure-service-connection'
      backendAzureRmStorageAccountName: 'mytfstateaccount'
      backendAzureRmContainerName: 'tfstate'
      backendAzureRmKey: 'aws-prod.terraform.tfstate'

  - task: PipelineTerraformTask@5
    name: terraformPlan
    displayName: 'Terraform Plan'
    inputs:
      provider: 'aws'
      command: 'plan'
      commandOptions: '-out=tfplan'
      environmentServiceNameAWS: 'my-aws-service-connection'
      publishPlanResults: 'AWSPlan'
      # Required because the state backend (azurerm) differs from the provider (aws) —
      # without these, plan fails trying to authenticate the azurerm backend.
      backendServiceArm: 'my-azure-service-connection'
      backendAzureRmStorageAccountName: 'mytfstateaccount'
      backendAzureRmContainerName: 'tfstate'
      backendAzureRmKey: 'aws-prod.terraform.tfstate'

  - task: PipelineTerraformTask@5
    displayName: 'Terraform Apply'
    condition: and(succeeded(), eq(variables['terraformPlan.changesPresent'], 'true'))
    inputs:
      provider: 'aws'
      command: 'apply'
      commandOptions: 'tfplan'
      environmentServiceNameAWS: 'my-aws-service-connection'
      # Same reasoning as the plan step above — apply also re-reads state.
      backendServiceArm: 'my-azure-service-connection'
      backendAzureRmStorageAccountName: 'mytfstateaccount'
      backendAzureRmContainerName: 'tfstate'
      backendAzureRmKey: 'aws-prod.terraform.tfstate'
```

---

### AzureRM state backend + GCP resources

Store state in Azure Blob Storage while managing GCP infrastructure.

```yaml
steps:
  - task: PipelineTerraformInstaller@1
    displayName: 'Install Terraform'
    inputs:
      binary: 'terraform'
      terraformVersion: 'latest'

  - task: PipelineTerraformTask@5
    displayName: 'Terraform Init'
    inputs:
      provider: 'gcp'
      command: 'init'
      workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
      backendType: 'azurerm'
      backendServiceArm: 'my-azure-service-connection'
      backendAzureRmStorageAccountName: 'mytfstateaccount'
      backendAzureRmContainerName: 'tfstate'
      backendAzureRmKey: 'gcp-prod.terraform.tfstate'

  - task: PipelineTerraformTask@5
    name: terraformPlan
    displayName: 'Terraform Plan'
    inputs:
      provider: 'gcp'
      command: 'plan'
      commandOptions: '-out=tfplan'
      environmentServiceNameGCP: 'my-gcp-service-connection'
      publishPlanResults: 'GCPPlan'
      # Required because the state backend (azurerm) differs from the provider (gcp).
      backendServiceArm: 'my-azure-service-connection'
      backendAzureRmStorageAccountName: 'mytfstateaccount'
      backendAzureRmContainerName: 'tfstate'
      backendAzureRmKey: 'gcp-prod.terraform.tfstate'

  - task: PipelineTerraformTask@5
    displayName: 'Terraform Apply'
    condition: and(succeeded(), eq(variables['terraformPlan.changesPresent'], 'true'))
    inputs:
      provider: 'gcp'
      command: 'apply'
      commandOptions: 'tfplan'
      environmentServiceNameGCP: 'my-gcp-service-connection'
      backendServiceArm: 'my-azure-service-connection'
      backendAzureRmStorageAccountName: 'mytfstateaccount'
      backendAzureRmContainerName: 'tfstate'
      backendAzureRmKey: 'gcp-prod.terraform.tfstate'
```

---

### HCP Terraform backend + AzureRM resources

Use HCP Terraform (Terraform Cloud) for state while authenticating to Azure for provider calls. The task runs Terraform on the agent, so set the HCP workspace's execution mode to Local; with Remote execution the run happens on HCP Terraform and the credentials from `environmentServiceNameAzureRM` are not used.

```yaml
steps:
  - task: PipelineTerraformInstaller@1
    displayName: 'Install Terraform'
    inputs:
      binary: 'terraform'
      terraformVersion: 'latest'

  - task: PipelineTerraformTask@5
    displayName: 'Terraform Init'
    inputs:
      provider: 'azurerm'
      command: 'init'
      workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
      backendType: 'hcp'
      backendHCPToken: '$(HCP_TOKEN)'
      backendHCPOrganization: 'my-org'
      backendHCPWorkspace: 'azure-prod'

  - task: PipelineTerraformTask@5
    name: terraformPlan
    displayName: 'Terraform Plan'
    inputs:
      provider: 'azurerm'
      command: 'plan'
      commandOptions: '-out=tfplan'
      environmentServiceNameAzureRM: 'my-azure-service-connection'
      publishPlanResults: 'AzurePlan'
      # Required because the state backend (hcp) differs from the provider (azurerm).
      backendHCPToken: '$(HCP_TOKEN)'
      backendHCPOrganization: 'my-org'
      backendHCPWorkspace: 'azure-prod'

  - task: PipelineTerraformTask@5
    displayName: 'Terraform Apply'
    condition: and(succeeded(), eq(variables['terraformPlan.changesPresent'], 'true'))
    inputs:
      provider: 'azurerm'
      command: 'apply'
      commandOptions: 'tfplan'
      environmentServiceNameAzureRM: 'my-azure-service-connection'
      backendHCPToken: '$(HCP_TOKEN)'
      backendHCPOrganization: 'my-org'
      backendHCPWorkspace: 'azure-prod'
```

---

### Separate backend and provider service connections (same cloud)

A common least-privilege split is one service connection with rights on the state
storage only, and a second with rights on the target subscription/account only —
both on the *same* cloud.

**This does not work the way the cross-cloud examples above do.** The `azurerm`
backend and the `azurerm` provider read the *same* `ARM_*` environment variables
(and likewise `s3`/`aws` share `AWS_*`), so a single `terraform` run can only
carry one identity in those variables — and it would be the provider's. Rather
than silently authenticating to your state storage as the wrong principal, the
task now fails the step with an error naming the inputs involved.

There are three ways to get the split you want.

#### Option 1 — bind the backend at `init` (azurerm, workload identity federation)

`backendAzureRmUseCliFlagsForAuthentication: true` makes `init` persist the
backend's own `client_id`/`use_oidc` into the backend config, so later commands
stop resolving the backend's identity from `ARM_*`:

```yaml
  - task: PipelineTerraformTask@5
    displayName: 'Terraform Init'
    inputs:
      provider: 'azurerm'
      command: 'init'
      workingDirectory: '$(System.DefaultWorkingDirectory)/infra'
      backendType: 'azurerm'
      backendServiceArm: 'SC-BACKEND'
      backendAzureRmUseCliFlagsForAuthentication: true
      backendAzureRmUseEntraIdForAuthentication: true
      backendAzureRmStorageAccountName: 'mytfstateaccount'
      backendAzureRmContainerName: 'tfstate'
      backendAzureRmKey: 'prod.terraform.tfstate'

  - task: PipelineTerraformTask@5
    displayName: 'Terraform Plan'
    inputs:
      provider: 'azurerm'
      command: 'plan'
      environmentServiceNameAzureRM: 'SC-PROVIDER'
```

#### Option 2 — configure the provider from input variables (any cloud, any scheme)

A `backend` block may never reference named values, but a `provider` block may —
and explicit provider arguments out-rank `ARM_*`. Inverting the split therefore
frees the environment variables for the backend:

```hcl
variable "provider_client_id" { type = string }
variable "provider_tenant_id" { type = string }
variable "provider_subscription_id" { type = string }

provider "azurerm" {
  features {}
  use_oidc        = true
  client_id       = var.provider_client_id
  tenant_id       = var.provider_tenant_id
  subscription_id = var.provider_subscription_id
}
```

```yaml
  - task: PipelineTerraformTask@5
    displayName: 'Terraform Plan'
    inputs:
      provider: 'azurerm'
      command: 'plan'
      commandOptions: >-
        -var=provider_client_id=$(PROVIDER_CLIENT_ID)
        -var=provider_tenant_id=$(PROVIDER_TENANT_ID)
        -var=provider_subscription_id=$(PROVIDER_SUBSCRIPTION_ID)
      environmentServiceNameAzureRM: 'SC-BACKEND'   # plan requires a provider connection; the same one as the backend
      backendServiceArm: 'SC-BACKEND'
      backendAzureRmUseEntraIdForAuthentication: true
      backendAzureRmStorageAccountName: 'mytfstateaccount'
      backendAzureRmContainerName: 'tfstate'
      backendAzureRmKey: 'prod.terraform.tfstate'
```

The step still names a provider connection because `plan` requires one. Using the
backend's own connection there keeps both identities identical, so the check that
rejects two different connections passes, and the explicit arguments in the
`provider` block take precedence over the `ARM_*` variables.

> **Do not pass a client secret this way.** Terraform records input variable
> values in the plan file, so a `-var=provider_client_secret=...` leaks into
> `tfplan` (and into the agent's command line). Use this pattern with workload
> identity federation or a managed identity, where the variables carry only
> non-secret identifiers.

#### Option 3 — use one service connection for both

Grant a single service connection rights on both the state storage and the
target subscription, and supply it as both `backendServiceArm` and
`environmentServiceNameAzureRM`. Simplest, at the cost of the least-privilege
split.

#### Where this restriction does *not* apply

`gcs` + `gcp` is exempt: the backend reads `GOOGLE_BACKEND_CREDENTIALS`, which
the provider never writes, so two service connections work with no extra
configuration — just add `backendServiceGCP` alongside `environmentServiceNameGCP`
on each state command.

---

## Policy as code

`PipelinePolicyAgentInstaller@1` installs OPA or Sentinel, and
`PipelineTerraformPolicyCheck@1` evaluates policies with it against Terraform plan
JSON. The natural chain is plan → show -json → policy check.

### PipelinePolicyAgentInstaller@1

Downloads OPA or Sentinel, verifies it, caches it in the agent tool cache and
prepends its directory to `PATH`, so later steps find it as `opa` or `sentinel`.
`policyAgent` picks the engine, `version` the release and `downloadSource` where
the download comes from.

#### Install a policy engine

`version: 'latest'` asks the public release API for the newest release when the
job runs (GitHub for OPA, the HashiCorp checkpoint API for Sentinel), so pin a
version for reproducible builds. Sentinel is verified against the GPG-signed
`SHA256SUMS` from releases.hashicorp.com, and `requireGpgSignature` (default
`true`) makes the install fail when the signature file is unavailable. That input
has no effect for OPA, which publishes no signature, or for the registry source.
OPA's `.sha256` file only proves the download arrived intact, not who published it.

```yaml
# OPA from GitHub releases (default)
- task: PipelinePolicyAgentInstaller@1
  inputs:
    policyAgent: 'opa'              # opa | sentinel
    version: 'latest'
    downloadSource: 'official'      # official | registry | mirror

# Sentinel from releases.hashicorp.com (GPG-verified), pinned
- task: PipelinePolicyAgentInstaller@1
  inputs:
    policyAgent: 'sentinel'
    version: '0.40.0'
    downloadSource: 'official'
```

#### Install from an internal mirror

A mirror serves the upstream file names under `<mirrorBaseUrl>/<version>/`: for
Sentinel the platform zip, `sentinel_<version>_SHA256SUMS` and its `.sig` file;
for OPA the `opa_<os>_<arch>` binary (with `.exe` on Windows) and its `.sha256`
file. `mirrorBaseUrl` must use `https://`. A mirror host that is, or resolves to,
a private or link-local address is refused unless `mirrorAllowedHosts` (comma- or
newline-separated) lists it; once that list is set, only the hosts on it are used.
`latest` is still resolved against the public release APIs when a mirror is used,
so pin `version` on agents that cannot reach them.

```yaml
- task: PipelinePolicyAgentInstaller@1
  inputs:
    policyAgent: 'sentinel'
    version: '0.40.0'
    downloadSource: 'mirror'
    mirrorBaseUrl: 'https://mirror.internal.example.com/sentinel'
    mirrorAllowedHosts: 'mirror.internal.example.com'
    requireGpgSignature: true       # default; fail when the mirror serves no SHA256SUMS.sig
    requireChecksum: true           # default; fail when the mirror serves no checksum file
```

`requireChecksum` (default `true`) makes a missing checksum file a failure. Set it
to `false` only for a mirror that publishes none (a Sentinel mirror then also needs
`requireGpgSignature: false`); the install then logs a warning and rests on HTTPS
alone.

#### Install from a private registry

The task asks the registry for
`<registryUrl>/terraform/binaries/<name>/versions/<version>/<os>/<arch>`, where
`<name>` is `registryMirrorName` (`opa` by default; set it to `sentinel` for
Sentinel). The answer holds an HTTPS `download_url` and the file's `sha256`, and
`latest` is resolved by the registry. That `sha256` is the only integrity check on
this path: no signature is verified, and with `requireChecksum` on, a registry
that returns no `sha256` fails the install.

By default the task refuses a registry or `download_url` host that is, or
resolves to, a private or link-local address, and accepts any other.
`registryAllowedHosts` (comma- or newline-separated, `*.` wildcards allowed) pins
the install to the hosts listed: the registry itself, the `download_url` it
returns and every redirect that download follows. List the registry host as well
as the storage host; a registry on a private address is allowed only by listing
it.

```yaml
- task: PipelinePolicyAgentInstaller@1
  inputs:
    policyAgent: 'opa'
    version: 'latest'
    downloadSource: 'registry'
    registryUrl: 'https://registry.example.com'
    registryMirrorName: 'opa'       # default; use 'sentinel' for Sentinel
    registryAllowedHosts: 'registry.example.com, *.s3.amazonaws.com'
```

#### Re-verify a cached policy engine

On a persistent self-hosted agent the tool cache outlives the job. A cached
binary that carries no local integrity marker is re-downloaded and re-verified
before use whenever `requireChecksum` is on, and an unreachable source only
produces a warning. `requireOnlineReverification` turns that warning into a
failure. `forceOnlineReverification` re-downloads every cache hit and compares it
byte for byte with the cached copy, even when its marker is valid. Both default to
`false`, which keeps offline and air-gapped cache reuse working.

```yaml
- task: PipelinePolicyAgentInstaller@1
  inputs:
    policyAgent: 'opa'
    version: '1.0.0'
    requireChecksum: true
    requireOnlineReverification: true
    forceOnlineReverification: true
```

#### Use the installed engine's location

Give the step a `name` to read its output variables. `policyAgentLocation` is the
full path of the installed binary (its directory is also prepended to `PATH`).
`policyAgentDownloadedFrom` is `official`, `registry:<url>`, `mirror:<url>` or
`cache`.

```yaml
- task: PipelinePolicyAgentInstaller@1
  name: policyInstall
  inputs:
    policyAgent: 'opa'
    version: '1.0.0'

- script: |
    echo "OPA binary: $(policyInstall.policyAgentLocation)"
    echo "Source: $(policyInstall.policyAgentDownloadedFrom)"
  displayName: 'Show where OPA came from'
```

### PipelineTerraformPolicyCheck@1

Evaluates policies against the JSON that `terraform show -json` prints for a saved
plan, so the steps before it are `plan` with `-out`, then `show` with
`outputFormat: 'json'`. `engine` selects `opa` or `sentinel`, and `policySource`
selects where the policies come from: a directory on the agent (`path`) or a git
repository (`gitUrl`). A violation fails the task, except where a Sentinel
enforcement level says otherwise. The task sets the output variables
`policyResult` (`passed` or `failed`), `violationCount` and `resultsFilePath`, and
by default publishes a JUnit report (`publishTestResults`) so outcomes appear in
the pipeline **Tests** tab.

The `show` step in these examples writes the plan under `$(Agent.TempDirectory)`
and sets `cleanupShowFileIfSensitive: false`. When the plan holds sensitive
values, the task otherwise deletes the `show` output file at the end of its step,
and the policy step would find `$(tfshow.showFilePath)` gone. The file can hold
those values in cleartext, so keep it out of any directory that is published as an
artifact. The agent normally clears its temp directory after each job; on a
self-hosted agent that does not, delete the file in a later step.

#### Evaluate OPA policies from a checked-out path

```yaml
- task: PipelineTerraformTask@5
  inputs:
    command: 'plan'
    provider: 'azurerm'
    environmentServiceNameAzureRM: 'my-azure-connection'
    commandOptions: '-out=tfplan'

- task: PipelineTerraformTask@5
  name: tfshow
  inputs:
    command: 'show'
    provider: 'azurerm'
    environmentServiceNameAzureRM: 'my-azure-connection'
    outputTo: 'file'
    outputFormat: 'json'
    filename: '$(Agent.TempDirectory)/plan.json'
    cleanupShowFileIfSensitive: false
    commandOptions: 'tfplan'

- task: PipelineTerraformPolicyCheck@1
  inputs:
    engine: 'opa'
    inputFile: '$(tfshow.showFilePath)'
    policySource: 'path'
    policyPath: '$(Build.SourcesDirectory)/policies'
    decisionPath: 'terraform/deny'
    failMode: 'nonEmpty'
    publishTestResults: true        # default; JUnit report in the Tests tab
```

`decisionPath` (default `terraform/deny`) is the rule the task queries with
`opa exec --decision`, so `terraform/deny` is `data.terraform.deny`. With
`failMode: 'nonEmpty'` (the default) the decision must be a set or array of
violation messages, or an object whose `true` or non-empty string values mark the
violations. Each violation fails the task and is reported as an error. Policies
evaluate the raw `terraform show -json` document as `input`.

#### Fail on a boolean decision

A rule that evaluates to a bare `true` or `false` does not fit the `nonEmpty`
shape, and the task stops with an error that points at `failMode: 'defined'`. With
`defined` the task fails when the decision is defined and is not `null` or
`false`, and passes when the rule is undefined. Any other defined value fails,
including an empty set, so keep `nonEmpty` for `deny` rules that collect messages.

```rego
package terraform

import rego.v1

deletes_resources if {
    some change in input.resource_changes
    "delete" in change.change.actions
}
```

```yaml
- task: PipelineTerraformPolicyCheck@1
  inputs:
    engine: 'opa'
    inputFile: '$(tfshow.showFilePath)'
    policySource: 'path'
    policyPath: '$(Build.SourcesDirectory)/policies'
    decisionPath: 'terraform/deletes_resources'
    failMode: 'defined'             # nonEmpty | defined
```

#### Use a specific engine binary

The task finds `opa` or `sentinel` on `PATH`, which is where
`PipelinePolicyAgentInstaller@1` puts it. `policyAgentPath` names the binary
instead, for example the one the installer reports in `policyAgentLocation`:

```yaml
- task: PipelinePolicyAgentInstaller@1
  name: policyInstall
  inputs:
    policyAgent: 'opa'
    version: '1.0.0'

- task: PipelineTerraformPolicyCheck@1
  inputs:
    engine: 'opa'
    policyAgentPath: '$(policyInstall.policyAgentLocation)'
    inputFile: '$(tfshow.showFilePath)'
    policySource: 'path'
    policyPath: '$(Build.SourcesDirectory)/policies'
```

#### Evaluate Sentinel policies with enforcement levels

```yaml
- task: PipelineTerraformPolicyCheck@1
  inputs:
    engine: 'sentinel'
    inputFile: '$(tfshow.showFilePath)'
    policySource: 'path'
    policyPath: '$(Build.SourcesDirectory)/sentinel-policies'
    defaultEnforcementLevel: 'soft-mandatory'   # advisory | soft-mandatory | hard-mandatory
    overrideSoftMandatory: false
    sentinelImportName: 'tfplan'
```

The task generates a `sentinel.hcl` that wires the plan JSON in as a static
import (`import "static" "tfplan" { source = "...", format = "json" }`) and lists
every `*.sentinel` policy at the chosen enforcement level. **Policies are
evaluated against the raw `terraform show -json` schema, not the TFC/TFE
`tfplan/v2` mock schema** — policies written for HCP Terraform need adaptation.
`sentinelImportName` (default `tfplan`) is the name of that static import and must
be a valid identifier. `defaultEnforcementLevel` decides what a failed policy
does: `advisory` only warns, `soft-mandatory` (the default) fails the task unless
`overrideSoftMandatory` is `true`, and `hard-mandatory` always fails.

#### Bring your own Sentinel configuration

`sentinelConfigPath` points at a `sentinel.hcl` that you maintain. The task runs
`sentinel apply` in that file's directory and uses the file as it is: the
policies, their enforcement levels and the static import of the plan JSON are
yours to declare, and `inputFile` is not wired in for you. The task then gates
purely on the exit code of `sentinel apply`, so `defaultEnforcementLevel`,
`overrideSoftMandatory` and `sentinelImportName` have no effect. `policyPath` is
still required with `policySource: 'path'`, although it is not used to find the
policies. `traceOutput: true` runs `sentinel apply -trace` for verbose debugging
output.

```yaml
- task: PipelineTerraformPolicyCheck@1
  inputs:
    engine: 'sentinel'
    inputFile: '$(tfshow.showFilePath)'
    policySource: 'path'
    policyPath: '$(Build.SourcesDirectory)/sentinel-policies'
    sentinelConfigPath: '$(Build.SourcesDirectory)/sentinel-policies/sentinel.hcl'
    traceOutput: true
```

#### Clone policies from a git repository

```yaml
- task: PipelineTerraformPolicyCheck@1
  inputs:
    engine: 'opa'
    inputFile: '$(tfshow.showFilePath)'
    policySource: 'gitUrl'
    policyRepoUrl: 'https://github.com/example/policies'
    policyRepoRef: '0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3'   # pin a SHA
    policyRepoSubdir: 'terraform'
    policyRepoToken: '$(POLICY_REPO_PAT)'   # secret variable, injected via http.extraheader
```

The repository is cloned over HTTPS into the agent temp directory and removed
when the step ends. `policyRepoRef` (default `main`) is a branch, a tag or a full
40-character commit SHA; pin a SHA so that a moved branch cannot change what is
enforced. `policyRepoSubdir` selects a folder inside the clone and cannot point
outside it. `policyRepoToken` authenticates a private repository without putting
the token in the URL or in the git command line, so it must be a secret variable,
and `policyRepoUrl` must not carry a `user:password@` part.

#### Emit a SARIF report

```yaml
- task: PipelineTerraformPolicyCheck@1
  name: policy
  inputs:
    engine: 'opa'
    inputFile: '$(tfshow.showFilePath)'
    policySource: 'path'
    policyPath: 'policy/'
    sarifOutput: true               # default false
    sarifPath: '$(Build.ArtifactStagingDirectory)/policy.sarif'   # optional; leave empty for the agent temp directory

- task: PublishBuildArtifacts@1
  inputs:
    PathtoPublish: '$(policy.sarifFilePath)'
    ArtifactName: 'CodeAnalysisLogs'           # picked up by SARIF-aware viewers
```

With `sarifOutput: true` the task writes a SARIF 2.1.0 report of the policy
violations and exposes its path via the `sarifFilePath` output variable. When
`sarifPath` is empty a file is written to the agent temp directory. Publish it as
a build artifact to surface policy findings in SARIF-aware tooling; the JUnit
report (published by default) remains the zero-setup path for the **Tests** tab.

> **SARIF has no native Azure DevOps viewer.** The file above is only actionable
> once published (e.g. as the `CodeAnalysisLogs` artifact shown above) and read by
> a SARIF-aware Marketplace extension or an external sink (GitHub code scanning, a
> SIEM) — the same caveat noted under `PipelineTerraformDriftReport@1`'s own SARIF
> section below, which emits the same SARIF shape from the same `sarifFilePath`
> output variable name.

---

## PipelineTerraformDriftReport@1

Parse a Terraform/OpenTofu plan JSON into drift counts and a changed-resource
summary, and optionally POST it to a Terraform State Manager (TSM) drift
callback. Like the policy check, it consumes the `terraform show -json` document,
so the natural chain is plan → show -json → drift report.

### Report drift from a plan

```yaml
- task: PipelineTerraformTask@5
  inputs:
    command: 'plan'
    provider: 'azurerm'
    environmentServiceNameAzureRM: 'my-azure-connection'
    commandOptions: '-out=tfplan'

- task: PipelineTerraformTask@5
  name: tfshow
  inputs:
    command: 'show'
    provider: 'azurerm'
    environmentServiceNameAzureRM: 'my-azure-connection'
    outputTo: 'file'
    outputFormat: 'json'
    filename: '$(Agent.TempDirectory)/plan.json'
    cleanupShowFileIfSensitive: false
    commandOptions: 'tfplan'

- task: PipelineTerraformDriftReport@1
  name: drift
  inputs:
    planJsonFile: '$(tfshow.showFilePath)'
```

The `show` step writes the plan under `$(Agent.TempDirectory)` and sets
`cleanupShowFileIfSensitive: false`. Otherwise it deletes its output file at the
end of its step whenever the plan holds sensitive values, and the drift report
would find nothing to read; see the note under
[PipelineTerraformPolicyCheck@1](#pipelineterraformpolicycheck1) about keeping
that file out of published directories.

The task sets output variables `driftDetected` (`true`/`false`), `addedCount`,
`changedCount`, `destroyedCount`, and `summaryFilePath` (the JSON report, which
is also the exact callback body). Reference them by the task `name`, e.g.
`$(drift.driftDetected)`.

### Fail the build on drift

```yaml
- task: PipelineTerraformDriftReport@1
  inputs:
    planJsonFile: '$(tfshow.showFilePath)'
    failOnDrift: true               # default false
```

### Report to Terraform State Manager

```yaml
- task: PipelineTerraformDriftReport@1
  inputs:
    planJsonFile: '$(tfshow.showFilePath)'
    detail: '$(Build.BuildId)'                 # free-text run label, forwarded as the callback detail
    callbackUrl: 'https://tsm.example.com/api/v1/drift/ingest'
    callbackToken: '$(tsm-callback-token)'     # per-run one-shot secret; sent as X-TSM-Callback-Token
    rejectUnauthorized: true                   # default; set false only for an untrusted private-CA endpoint
    failOnCallbackError: false                 # default true; false warns instead of failing on a non-2xx response
```

The result is POSTed **only when both `callbackUrl` and `callbackToken` are
set**; with only one of them the task warns and sends nothing. `callbackToken` is a per-run one-shot token sent as the
`X-TSM-Callback-Token` header — pass it as a secret variable. `rejectUnauthorized`
(default `true`) verifies the callback's TLS certificate; set it `false` only for
a private-CA endpoint the agent does not trust. For a TSM endpoint fronted by a
private CA, prefer installing that CA via `NODE_EXTRA_CA_CERTS` on the agent —
`rejectUnauthorized: false` is a last resort, since it then sends the callback
token over a connection whose certificate is not authenticated, so it could be
captured by an on-path attacker. It is honoured only when `callbackUrl` is, or
resolves to, a private/link-local address; against a public destination — or a
URL that does not parse, or one carrying `user:password@` credentials — the task
fails rather than sending the token to an unverified peer.

`failOnCallbackError` (default `true`) fails the task when the callback endpoint
answers outside the 2xx range; `false` logs a warning and lets the build
continue, which suits a report that is only advisory. A request that gets no
answer at all (connection refused or reset, a TLS failure, a timeout) is retried
up to three times and then still fails the task. A received response is never
retried, because the callback token is one-shot.

### Emit a SARIF report

```yaml
- task: PipelineTerraformDriftReport@1
  name: drift
  inputs:
    planJsonFile: '$(tfshow.showFilePath)'
    sarifOutput: true               # default false
    sarifPath: '$(Build.ArtifactStagingDirectory)/drift.sarif'   # optional; leave empty for the agent temp directory

- task: PublishBuildArtifacts@1
  inputs:
    PathtoPublish: '$(drift.sarifFilePath)'
    ArtifactName: 'CodeAnalysisLogs'           # picked up by SARIF-aware viewers
```

With `sarifOutput: true` the task writes a SARIF 2.1.0 report of the drifted
resources and exposes its path via the `sarifFilePath` output variable. When
`sarifPath` is empty a file is written to the agent temp directory; either way
the path is exposed via `sarifFilePath`. Publish it as a build artifact to
surface drift in SARIF-aware tooling.

> **SARIF has no native Azure DevOps viewer.** `PipelineTerraformPolicyCheck@1` exposes the
> same `sarifOutput`/`sarifPath` inputs and `sarifFilePath` output as the drift task. For
> either task the SARIF is only actionable once published (e.g. as the `CodeAnalysisLogs`
> artifact shown above) and read by a SARIF-aware Marketplace extension or an external sink
> (GitHub code scanning, a SIEM). The JUnit results the policy-check task also emits render
> natively in the **Tests** tab, so JUnit is the zero-setup path.

**Completeness markers.** The report and the callback body carry five fields
describing what the run did **not** do, straight from the drift contract:

| Field             | Meaning                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| `unparseable`     | the document did not have the shape of a plan — nothing was actually checked |
| `unmasked`        | a change carried no sensitivity metadata, so nothing was redacted for it     |
| `truncated`       | a bound was reached and the summary is not the whole story                   |
| `omitted_entries` | summary rows dropped by the entry cap (**the counts still include them**)    |
| `omitted_attrs`   | changed attributes dropped by the per-row cap, across all rows               |

`unparseable` is the one that changes an answer. Without it a truncated
`terraform show -json`, a wrong file, an empty `{}` and a genuinely clean plan
all leave the agent as `added: 0, changed: 0, destroyed: 0, drifted: false` —
byte-identical bodies — so "we checked and it was clean" and "we never finished
checking" were the same report, and TSM auto-resolved the live drift record on
either. Gate on `driftDetected` by all means, but treat `unparseable` as a
failure of the check rather than as a clean result.

### Control module provenance

```yaml
- task: PipelineTerraformDriftReport@1
  inputs:
    planJsonFile: '$(tfshow.showFilePath)'
    includeModuleProvenance: true   # default; false leaves module calls and locks out of the report
    moduleManifest: '$(System.DefaultWorkingDirectory)/infra/.terraform/modules/modules.json'
```

`includeModuleProvenance` (default `true`) adds the configuration's module calls
and locked module versions to the report and callback body. Set it `false` to
omit them. The locked versions come from `moduleManifest` (default
`.terraform/modules/modules.json`), which is read relative to the task's working
directory, `$(System.DefaultWorkingDirectory)`. The task has no `workingDirectory`
input, so when Terraform ran in a sub-directory give the full path, as above. A
path that resolves outside the working directory (symlinks are resolved first) is
skipped with a warning, and a missing, oversized or non-object file is skipped as
well; the report then carries no locked versions.

Only `source` (with any credential in the URL redacted) and `version_constraint`
are emitted per module call: the plan's `configuration` block carries no
sensitivity metadata, so the rest of the subtree, including every literal module
argument's `constant_value`, is dropped rather than forwarded. See
[SECURITY.md](../SECURITY.md).

### Delete the summary file after the run

```yaml
- task: PipelineTerraformDriftReport@1
  inputs:
    planJsonFile: '$(tfshow.showFilePath)'
    callbackUrl: 'https://tsm.example.com/api/v1/drift/ingest'
    callbackToken: '$(tsm-callback-token)'
    cleanupSummaryFile: true        # default false; summaryFilePath is unreadable afterwards
```

The summary file lives in the agent temp directory and can hold plan resource
values. By default it stays there so that later steps can read it through
`summaryFilePath`. With `cleanupSummaryFile: true` the task overwrites and deletes
it as soon as it finishes, which suits a self-hosted agent whose temp directory is
not wiped between jobs, but `summaryFilePath` then names a file that no longer
exists. The file is also scrubbed when the run is cancelled, whatever the setting.

---

## PipelineTerraformModulePublish@1

Publish a module version to HCP Terraform / Terraform Enterprise or a private
`terraform-registry-backend`. Typically the last step of a module's release
pipeline. The two registry types publish differently: HCP Terraform / TFE gets a
new version created through its API, whereas a private registry is asked to
import the git tag that is already pushed, so the task uploads nothing to it.

### Publish to a private registry

```yaml
- task: PipelineTerraformModulePublish@1
  displayName: 'Publish module to private registry'
  inputs:
    registryType: 'private'
    registryUrl: 'https://registry.example.com'
    namespace: 'platform'
    name: 'networking-vpc'          # module name without the terraform-<provider>- prefix
    provider: 'aws'
    version: '1.2.3'
    apiKey: '$(tfregistry-api-key)' # secret variable; needs the modules:write scope
```

A private-registry publish uploads nothing. The task asks the registry to run its
SCM tag sync for the module, and the registry imports the tag that is already
pushed to the module's linked repository as the new version. The git tag for
`version` must therefore exist, and match the module's tag pattern, before this
step runs. A version the registry already lists is reported as already published
and no sync is triggered, so a re-run costs one request. The module must also be
registered and linked to its repository in the registry; otherwise the task fails
with an error that asks you to register and SCM-link it, unless the inputs in the
next section are set.

`apiKey` must be a **secret** pipeline variable with the `modules:write` scope —
never inline the literal. For an internal registry fronted by a private CA the
agent does not trust, prefer installing the CA via `NODE_EXTRA_CA_CERTS`;
`skipTlsVerify: true` is a last resort, since it then sends the API key over a
connection whose certificate is not authenticated, so it could be captured by
an on-path attacker. It is honoured only when `registryUrl` is, or resolves to,
a private/link-local address; against a public destination — including the
rooted spelling `https://app.terraform.io./` — the task fails rather than
sending the API key to an unverified peer.

### Create and SCM-link the module on first publish

```yaml
- task: PipelineTerraformModulePublish@1
  displayName: 'Publish (create and SCM-link the module if missing)'
  inputs:
    registryType: 'private'
    registryUrl: 'https://registry.example.com'
    namespace: 'platform'
    name: 'networking-vpc'
    provider: 'aws'
    version: '1.2.3'
    apiKey: '$(tfregistry-api-key)'
    scmProviderId: '00000000-0000-0000-0000-000000000000'   # UUID of an SCM provider connection in the registry
    repositoryOwner: 'my-project'                            # Azure DevOps project; org or user on GitHub and GitLab
    repositoryName: 'terraform-aws-networking-vpc'
    defaultBranch: 'main'           # default; recorded on the SCM link
    tagPattern: 'v*'                # default; git tags imported as versions
```

When the module does not exist, the task creates its record in the registry, links
it to the source repository named by `scmProviderId`, `repositoryOwner` and
`repositoryName`, and then triggers the sync. All three must be set for this to
happen; without them a missing module stays an error. If the record exists but is
not linked to a repository yet, the task links it and retries the sync once.
`defaultBranch` (default `main`) and `tagPattern` (default `v*`) are recorded on
the link and are used only when the task links a module.

### Skip TLS verification for an internal registry

Only for a registry on a private or link-local address whose certificate chains to
a CA that the agent does not trust, and only when installing that CA is not an
option:

```yaml
- task: PipelineTerraformModulePublish@1
  displayName: 'Publish module to the internal registry'
  inputs:
    registryType: 'private'
    registryUrl: 'https://registry.corp.internal'
    namespace: 'platform'
    name: 'networking-vpc'
    provider: 'aws'
    version: '1.2.3'
    apiKey: '$(tfregistry-api-key)'
    skipTlsVerify: true             # default false; last resort, see above
```

### Publish to HCP Terraform

```yaml
- task: PipelineTerraformModulePublish@1
  displayName: 'Publish module to HCP Terraform'
  inputs:
    registryType: 'hcp'
    namespace: 'my-org'             # HCP organization name
    name: 'networking-vpc'
    provider: 'aws'
    version: '1.2.3'
    hcpToken: '$(hcp-team-token)'   # secret variable
```

For HCP Terraform / TFE the `namespace` is the organization name. `hcpToken` is a
team or user API token and must be a secret variable. With the default
`hcpPublishMode: auto` the task publishes to whichever kind of module already
exists (see [Choose the HCP publish path](#choose-the-hcp-publish-path-with-hcppublishmode)):
it creates the version through the API, records `commitSha` as its commit, and for
a module with no VCS connection also uploads the module archive. When HCP already
reports the version as ready, the task finishes without creating anything, and a
422 answer to the create call (the version already exists) is logged rather than
treated as a failure.

### Publish to Terraform Enterprise

```yaml
- task: PipelineTerraformModulePublish@1
  displayName: 'Publish module to Terraform Enterprise'
  inputs:
    registryType: 'hcp'
    hcpAddress: 'https://tfe.example.com'   # base URL of your Terraform Enterprise host
    namespace: 'my-org'
    name: 'networking-vpc'
    provider: 'aws'
    version: '1.2.3'
    hcpToken: '$(tfe-team-token)'
    commitSha: '$(Build.SourceVersion)'     # default; the commit recorded on the new version
```

`hcpAddress` (default `https://app.terraform.io`) is the address of HCP Terraform;
set it to the base URL of the Terraform Enterprise host to publish there instead.

### Create a VCS-connected module on first publish

```yaml
- task: PipelineTerraformModulePublish@1
  displayName: 'Publish (create VCS-connected module if missing)'
  inputs:
    registryType: 'hcp'
    namespace: 'my-org'
    name: 'networking-vpc'
    provider: 'aws'
    version: '1.2.3'
    hcpToken: '$(hcp-team-token)'
    vcsRepoIdentifier: 'my-org/my-project/_git/terraform-aws-networking-vpc'
    vcsOauthTokenId: 'ot-xxxxxxxxxxxxxxxx'
    vcsBranch: 'main'               # defaults to main
```

`vcsRepoIdentifier` and `vcsOauthTokenId` apply **only when the module does not
yet exist** and HCP should create a VCS-connected module for it; for modules that
already exist they are ignored. `commitSha` defaults to `$(Build.SourceVersion)`.

HCP names a VCS-connected module from its repository (`terraform-<provider>-<name>`),
so `name` and `provider` must match the repository name or the task fails before
creating anything.

### Choose the HCP publish path with hcpPublishMode

HCP Terraform has three kinds of private module. `hcpPublishMode` defaults to
`auto`, which publishes to whichever kind the module already is, so existing
pipelines need no change. Set it explicitly to require a kind: the task then
fails before changing anything if the existing module is a different one.

| `hcpPublishMode` | Module kind            | Behaviour                                                       |
| ---------------- | ---------------------- | --------------------------------------------------------------- |
| `auto`           | any                    | Follows the existing module; creates it if missing (see below). |
| `vcsBranch`      | VCS-connected, branch  | Creates the version from `commitSha`.                           |
| `vcsTag`         | VCS-connected, git tag | Observe only: HCP imports versions from git tags.               |
| `upload`         | no VCS connection      | Archives `moduleDirectory` and uploads it.                      |

```yaml
# Module with no VCS connection: the task archives the directory and uploads it.
- task: PipelineTerraformModulePublish@1
  displayName: 'Publish module to HCP Terraform (upload)'
  inputs:
    registryType: 'hcp'
    hcpPublishMode: 'upload'
    namespace: 'my-org'
    name: 'networking-vpc'
    provider: 'aws'
    version: '1.2.3'
    hcpToken: '$(hcp-team-token)'
    moduleDirectory: '$(Build.SourcesDirectory)/modules/vpc'   # default '.'
```

```yaml
# Module versioned from git tags: the tag must already be pushed. The task
# creates nothing and waits for HCP to import the version.
- task: PipelineTerraformModulePublish@1
  displayName: 'Wait for HCP to import the tag'
  inputs:
    registryType: 'hcp'
    hcpPublishMode: 'vcsTag'
    namespace: 'my-org'
    name: 'networking-vpc'
    provider: 'aws'
    version: '1.2.3'
    hcpToken: '$(hcp-team-token)'
```

In `auto` mode a module that does not exist yet is created VCS-connected
(branch-based) when both `vcsRepoIdentifier` and `vcsOauthTokenId` are set, and
with no VCS connection when neither is set; setting only one fails the task. To
create a tag-based module, set `hcpPublishMode: vcsTag` with both inputs. `vcsTag`
mode only checks for the version unless `waitForPublish` is on, in which case it
waits for it. A branch module's
version is ingested from the commit, so nothing is archived or uploaded for it.
Upload mode
requires `.tf` or `.tf.json` files at the root of `moduleDirectory`, excludes
`.git` and `.terraform`, refuses symbolic links that point outside the directory,
and limits the archive to 64 MiB uncompressed. If a run fails after the version
was created, a re-run deletes the failed or stuck version and creates it again;
a version HCP already reports as available is skipped, unless `existingVersion` is
`fail`.

### Gate a release on HCP before tagging

`checkOnly: true` reads the module and reports what a publish would do, without
creating a module or version, deleting anything, or uploading. It still fails on
invalid inputs, an unreadable module (for example a rejected API token), or a
`moduleDirectory` that is not a module. When the module does not exist it also
reads the organization's registry, so a wrong `namespace` or a token without access
fails the check instead of passing it. With `existingVersion: fail` it also fails
when the version is already available, so the pipeline stops before it tags a
release whose number is taken.

```yaml
- task: PipelineTerraformModulePublish@1
  displayName: 'Check HCP before tagging'
  inputs:
    registryType: 'hcp'
    namespace: 'my-org'
    name: 'networking-vpc'
    provider: 'aws'
    version: '1.2.3'
    hcpToken: '$(hcp-team-token)'
    checkOnly: true
    existingVersion: 'fail'
```

On the publish step itself, `existingVersion: fail` makes the first run of a
release fail when the number is already used; leave it at the default `skip` where
the step is re-run after a partial failure.

### Keep files out of the uploaded archive

The archive holds every file under `moduleDirectory` except `.git` and
`.terraform`, so pointing it at a checkout publishes the pipeline files and any
`.tfvars` next to the module. Stage the module from the release tag first, or list
what to drop in `moduleExclude`: one path per line, relative to `moduleDirectory`,
where `*` matches within one path segment and `**` across segments; `**/` also
matches no folder, so `**/*.tfvars` drops a root `validation.tfvars` as well as
nested ones. A path that
names a directory drops everything under it.

```yaml
- task: PipelineTerraformModulePublish@1
  inputs:
    registryType: 'hcp'
    hcpPublishMode: 'upload'
    namespace: 'my-org'
    name: 'networking-vpc'
    provider: 'aws'
    version: '1.2.3'
    hcpToken: '$(hcp-team-token)'
    moduleDirectory: '$(Build.SourcesDirectory)'
    moduleExclude: |
      azure-pipelines.yml
      tests
      **/*.tfvars
```

### Wait behaviour

```yaml
- task: PipelineTerraformModulePublish@1
  inputs:
    registryType: 'private'
    registryUrl: 'https://registry.example.com'
    namespace: 'platform'
    name: 'networking-vpc'
    provider: 'aws'
    version: '1.2.3'
    apiKey: '$(tfregistry-api-key)'
    waitForPublish: true            # default; poll until the version is queryable
    timeoutSeconds: '300'           # default 180
```

With `waitForPublish: true` (the default) the task polls the registry until the
published version is available, failing if it is not ready within
`timeoutSeconds`. Set `waitForPublish: false` to return as soon as the publish
request is accepted.

For a private registry the poll interval starts at about 3 seconds and doubles
up to 30 seconds (jittered), and a rate-limited poll waits at least the
registry's `Retry-After`, because every poll spends the same API-key rate limit
as the publish itself. The final poll lands on the `timeoutSeconds` deadline
rather than after it.

---

## PipelineTerraformDocsInstaller@1

Install [terraform-docs](https://terraform-docs.io) on the pipeline agent and
prepend it to `PATH`. Run this before `PipelineTerraformDocs@1`. Like the other
installers it verifies the download's SHA256 checksum over HTTPS and supports
official (GitHub releases), private-registry, and custom-mirror sources.
terraform-docs releases carry no signature, so the checksum, which comes from the
same source as the archive, only proves the download arrived intact.

### Install latest terraform-docs

```yaml
- task: PipelineTerraformDocsInstaller@1
  displayName: 'Install terraform-docs (latest)'
  inputs:
    version: 'latest'
```

`latest` is resolved from the GitHub releases API (from the registry when
`downloadSource` is `registry`), and the install fails if that lookup fails rather
than falling back to an older version, so pin `version` on agents that cannot
reach it.

### Install a pinned version

```yaml
- task: PipelineTerraformDocsInstaller@1
  displayName: 'Install terraform-docs 0.20.0'
  inputs:
    version: '0.20.0'
```

### Download terraform-docs from a custom mirror

A mirror serves the upstream file names under `<mirrorBaseUrl>/<version>/`: the
archive `terraform-docs-v<version>-<os>-<arch>.tar.gz` (`.zip` on Windows) and
`terraform-docs-v<version>.sha256sum`. `mirrorBaseUrl` must use `https://`. A
mirror host that is, or resolves to, a private or link-local address is refused
unless `mirrorAllowedHosts` (comma- or newline-separated) lists it; once that list
is set, only the hosts on it are used. `latest` is still resolved against the
GitHub releases API when a mirror is used, so pin `version` on agents that cannot
reach it.

```yaml
- task: PipelineTerraformDocsInstaller@1
  displayName: 'Install terraform-docs from mirror'
  inputs:
    version: '0.20.0'
    downloadSource: 'mirror'
    mirrorBaseUrl: 'https://mirror.internal.example.com/terraform-docs'
    mirrorAllowedHosts: 'mirror.internal.example.com'
    requireChecksum: true           # default; fail when the mirror serves no checksum file
```

`requireChecksum` (default `true`) makes a missing checksum file a failure. Set it
to `false` only for a mirror that publishes none; the install then logs a warning
and rests on HTTPS alone.

### Download terraform-docs from a private registry backend

The task asks the registry for
`<registryUrl>/terraform/binaries/<registryMirrorName>/versions/<version>/<os>/<arch>`.
The answer holds an HTTPS `download_url` and the archive's `sha256`, and `latest`
is resolved by the registry. That `sha256` is the only integrity check on this
path: with `requireChecksum` on, a registry that returns no `sha256` fails the
install.

By default the task refuses a registry or `download_url` host that is, or
resolves to, a private or link-local address, and accepts any other.
`registryAllowedHosts` (comma- or newline-separated, `*.` wildcards allowed) pins
the install to the hosts listed: the registry itself, the `download_url` it
returns and every redirect that download follows. List the registry host as well
as the storage host; a registry on a private address is allowed only by listing
it.

```yaml
- task: PipelineTerraformDocsInstaller@1
  displayName: 'Install terraform-docs from private registry'
  inputs:
    version: '0.20.0'
    downloadSource: 'registry'
    registryUrl: 'https://registry.example.com'
    registryMirrorName: 'terraform-docs'   # default; the {name} segment of the registry path
    registryAllowedHosts: 'registry.example.com, *.blob.core.windows.net'
```

### Re-verify the tool cache on a shared agent

A cached binary that carries no local integrity marker is re-downloaded and
re-verified before use whenever `requireChecksum` is on, and an unreachable source
only produces a warning. `requireOnlineReverification` turns that warning into a
failure. `forceOnlineReverification` re-downloads every cache hit and compares it
byte for byte with the cached copy, even when its marker is valid. Both default to
`false`, which keeps offline and air-gapped cache reuse working.

```yaml
- task: PipelineTerraformDocsInstaller@1
  displayName: 'Install terraform-docs 0.20.0 (verify the tool cache)'
  inputs:
    version: '0.20.0'
    requireChecksum: true
    requireOnlineReverification: true
    forceOnlineReverification: true
```

### Use the installed binary's location

Give the step a `name` to read its output variables. `terraformDocsLocation` is
the full path of the installed binary (its directory is also prepended to `PATH`).
`terraformDocsDownloadedFrom` is `official`, `registry:<url>`, `mirror:<url>` or
`cache`.

```yaml
- task: PipelineTerraformDocsInstaller@1
  name: docsInstall
  displayName: 'Install terraform-docs 0.20.0'
  inputs:
    version: '0.20.0'

- script: |
    echo "Installed: $(docsInstall.terraformDocsLocation)"
    echo "Source: $(docsInstall.terraformDocsDownloadedFrom)"
  displayName: 'Show where terraform-docs came from'
```

---

## PipelineTerraformDocs@1

Generate documentation for a Terraform module with terraform-docs. Requires
terraform-docs on `PATH` — run `PipelineTerraformDocsInstaller@1` first.
terraform-docs exits non-zero on error and, with `outputCheck`, when the target
file is out of date — either fails the task.

### Inject a Markdown table into README.md

The most common use: keep the generated tables between the
`<!-- BEGIN_TF_DOCS -->` and `<!-- END_TF_DOCS -->` markers in `README.md` and
leave the rest of the file alone. `outputFile` is relative to `modulePath`. The
markers do not have to exist: terraform-docs creates a missing file and appends
the marked block to a file that has none. To choose where the block goes, add the
markers yourself before the first run:

```markdown
<!-- BEGIN_TF_DOCS -->
<!-- END_TF_DOCS -->
```

```yaml
- task: PipelineTerraformDocs@1
  name: moduleDocs
  displayName: 'Generate module docs'
  inputs:
    formatter: 'markdown-table'
    modulePath: '$(System.DefaultWorkingDirectory)/modules/vpc'
    outputFile: 'README.md'
    outputMode: 'inject'            # default; keeps the text outside the markers

- script: echo "Wrote $(moduleDocs.generatedFilePath)"
  displayName: 'Show the generated file'
```

`generatedFilePath` is the module path joined with `outputFile`. The task sets it
only when `outputFile` is set.

### Replace a whole file

`outputMode: 'replace'` overwrites the file with the generated output (and creates
it when missing), so manual edits are lost. Use it for a file that is fully
generated, such as `MODULE.md`. `outputMode` applies only when `outputFile` is set.

```yaml
- task: PipelineTerraformDocs@1
  displayName: 'Write MODULE.md'
  inputs:
    formatter: 'markdown-document'
    modulePath: '$(System.DefaultWorkingDirectory)'
    outputFile: 'MODULE.md'
    outputMode: 'replace'           # inject | replace
```

### Print documentation to the build log

Omit `outputFile` to write the generated docs to the console instead of a file.

```yaml
- task: PipelineTerraformDocs@1
  displayName: 'Show module docs (JSON)'
  inputs:
    formatter: 'json'
    modulePath: '$(System.DefaultWorkingDirectory)/modules/vpc'
```

### Fail the build when docs are out of date (CI gate)

`outputCheck` makes terraform-docs compare the generated output with the file
without writing it, failing the task when the committed documentation is stale —
a useful pull-request gate.

```yaml
- task: PipelineTerraformDocs@1
  displayName: 'Check module docs are current'
  inputs:
    formatter: 'markdown-table'
    modulePath: '$(System.DefaultWorkingDirectory)/modules/vpc'
    outputFile: 'README.md'
    outputCheck: true
```

A stale file fails the task with an out-of-date message. Any other non-zero exit
from terraform-docs (a bad config file, an unreadable module, a missing output
file) fails it with terraform-docs' own output.

### Recurse across submodules

With `recursive` on, terraform-docs documents the module at `modulePath` and every
submodule under `recursivePath` in one run. terraform-docs allows this only when
`outputFile` is set, and needs version 0.16.0 or later.

```yaml
- task: PipelineTerraformDocs@1
  displayName: 'Generate docs for all submodules'
  inputs:
    formatter: 'markdown-table'
    modulePath: '$(System.DefaultWorkingDirectory)'
    outputFile: 'README.md'
    outputMode: 'inject'
    recursive: true
    recursivePath: 'modules'        # default; relative to modulePath
```

### Use a terraform-docs config file

`configFile` must point to an existing file; a missing path fails the task.
`sortBy` orders the documented inputs and outputs, and `default` keeps
terraform-docs' own order.

```yaml
- task: PipelineTerraformDocs@1
  displayName: 'Generate docs from config'
  inputs:
    formatter: 'markdown-document'
    modulePath: '$(System.DefaultWorkingDirectory)/modules/vpc'
    configFile: '.terraform-docs.yml'
    sortBy: 'required'                 # default | name | required | type
```

### Pass extra terraform-docs flags

`additionalArgs` carries any terraform-docs flag the task has no input for. It is
split like a command line (spaces separate arguments, double quotes keep one
together) and placed after the flags the other inputs produce, before the module
path.

```yaml
- task: PipelineTerraformDocs@1
  displayName: 'Generate docs without empty sections'
  inputs:
    formatter: 'markdown-table'
    modulePath: '$(System.DefaultWorkingDirectory)/modules/vpc'
    outputFile: 'README.md'
    additionalArgs: '--hide-empty --show inputs'
```

### Full pipeline — install, then gate on current docs

```yaml
steps:
  - task: PipelineTerraformDocsInstaller@1
    displayName: 'Install terraform-docs'
    inputs:
      version: 'latest'

  - task: PipelineTerraformDocs@1
    displayName: 'Verify docs are current'
    inputs:
      formatter: 'markdown-table'
      modulePath: '$(System.DefaultWorkingDirectory)'
      outputFile: 'README.md'
      outputCheck: true
```

Available formatters: `markdown-table`, `markdown-document`, `json`, `yaml`,
`toml`, `pretty`, `asciidoc-table`, `asciidoc-document`, `tfvars-hcl`,
`tfvars-json`.

## Markdown2Html@1

**Deprecated.** `Markdown2Html@1` is being republished as
`PipelineMarkdown2Html` in
[Pipeline Tasks for Release & Documentation](https://github.com/sethbacon/azure-pipelines-release-docs)
under a new name and a new id, so nothing migrates automatically: a pipeline
keeps running `Markdown2Html@1` from this extension until its YAML is changed,
and every run logs a deprecation warning. The task is removed here only after
both extensions have published five minor releases with it available in both
(see the [README](../README.md)).

Converts Markdown to a single styled HTML document (markdown-it + highlight.js).
Runs locally, with no network access. The output is passed through an allowlist
sanitizer, so raw active content in the Markdown cannot reach it. Sets the
`htmlFilePath` output variable to the absolute path of the file it wrote;
missing parent directories are created.

### Convert a single generated doc file

`inputFiles` takes one path per line or a comma-separated list, and `title` is
both the page title and the heading at the top of the document. `debug: true`
logs each file as it is converted:

```yaml
steps:
  - task: Markdown2Html@1
    displayName: 'Render module docs to HTML'
    inputs:
      mode: 'filelist'
      inputFiles: 'MODULE.md'
      outputFile: '$(Build.ArtifactStagingDirectory)/module.html'
      title: 'My Terraform Module'
      debug: true   # default false; log each file as it is converted
```

### Combine several files with section headings and dividers

`sections` adds each file's name as a heading and, when there is more than one
file, a table of contents; `dividers` adds a horizontal rule between files. Both
apply to `filelist` mode only.

```yaml
steps:
  - task: Markdown2Html@1
    displayName: 'Combine docs'
    inputs:
      mode: 'filelist'
      inputFiles: |
        README.md
        docs/inputs.md
        docs/outputs.md
      outputFile: '$(Build.ArtifactStagingDirectory)/combined.html'
      title: 'Module Reference'
      sections: true
      dividers: true
```

### Front-matter-driven composition

In `frontMatter` mode the primary file's YAML front matter (a `---` block at the
start of the file) declares what to include and how to combine it, so the step
only names the primary file:

```markdown
---
title: Terraform Module Guide
includes:
  - sections/install.md
  - sections/usage.md
include-options:
  toc: true               # default false; build a table of contents
  separator: pagebreak    # hr (default) | pagebreak | none
  heading-shift: 1        # default 0; demote headings in the included files
  section-anchors: true   # default false; wrap each include in a section
---

# Terraform Module Guide

Text that comes before the included sections.
```

```yaml
steps:
  - task: Markdown2Html@1
    displayName: 'Render KB page from front matter'
    inputs:
      mode: 'frontMatter'
      primaryFile: 'kb/index.md'
      outputFile: '$(Build.ArtifactStagingDirectory)/kb.html'
```

- `includes` lists Markdown files relative to the primary file's directory. Each
  must exist and resolve, after following symlinks, inside that directory.
  Duplicates are skipped, a cycle is an error, and the `includes` of an included
  file are followed up to five levels deep. An included file must not have a
  `kb-key` field.
- `toc` builds a table of contents from the headings, and only when there is at
  least one include.
- `separator` is what goes between the parts: `hr` (a horizontal rule, the
  default), `pagebreak` (a print page break) or `none`. Any other value is
  treated as `hr`.
- `heading-shift` adds that number to every heading level in the included files
  (`1` turns `#` into `##`), stopping at level 6. The primary file is not
  shifted.
- `section-anchors` wraps each include in a `<section>` with an id and turns
  relative links to the included `.md` files into in-page links.

The page title is the `title` input when it is set to something other than its
default, otherwise the `title` front-matter field, then the first `#` heading of
the primary file, then the file's name. Malformed front matter logs a warning
and the defaults apply. Only `title` and `debug` apply in this mode; `sections`
and `dividers` are for `filelist` mode.

## PublishKbArticle@1

**Deprecated.** `PublishKbArticle@1` is being republished as
`PipelinePublishKbArticle` in
[Pipeline Tasks for Release & Documentation](https://github.com/sethbacon/azure-pipelines-release-docs)
under a new name and a new id, so nothing migrates automatically: a pipeline
keeps running `PublishKbArticle@1` from this extension until its YAML is
changed, and every run logs a deprecation warning. The task is removed here only
after both extensions have published five minor releases with it available in
both (see the [README](../README.md)).

Creates or updates a ServiceNow knowledge base article from an HTML file.
Authenticates via a `ServiceNowKb` service connection (OAuth client credentials
or basic) or inline credentials. All requests are HTTPS-only; the token/password
are masked in logs. Sets `kbArticleId`, `kbArticleNumber`, and `kbWorkflowState`.

### Create or update via a service connection (idempotent)

`sourceKey` correlates re-runs to the same article, so this create-or-updates.
The key is kept as a `wiki-source: <key>` line in the article's Meta field,
`kbId` limits the lookup to that knowledge base, and a key that matches more
than one article fails the task. `category` is created when it does not exist,
and so is `subcategory`, which needs `category` and is created beneath it.
`workflowState` is applied on every run and is `draft` unless set, so a run that
should leave the article published must say `publish`:

```yaml
steps:
  - task: PublishKbArticle@1
    displayName: 'Publish module docs to ServiceNow'
    inputs:
      serviceConnection: 'my-servicenow'
      kbId: '$(kbSysId)'
      title: 'My Terraform Module'
      htmlFile: '$(Build.ArtifactStagingDirectory)/module.html'
      author: 'svc-docs'
      category: 'Infrastructure'
      subcategory: 'Terraform'
      sourceKey: 'my-terraform-module'
      workflowState: 'publish'   # draft | review | publish
```

The task looks for the article to update in this order, and creates a new one
when none is found:

1. the `articleId` input;
2. the article whose Meta field carries the `sourceKey` (or the key read by
   `readKeyFrom`);
3. the article named by the most recently modified `KB<number>.json` file in the
   working directory, left by an earlier run (skipped with `skipJsonLookup`).

Creating needs `kbId`, `title`, `htmlFile` and `author`.

### List the knowledge bases

`kbId: 'list'` prints each knowledge base's title and `sys_id`, then ends the
task successfully without changing anything. Run it once to find the value to
use for `kbId`:

```yaml
steps:
  - task: PublishKbArticle@1
    displayName: 'List knowledge bases'
    inputs:
      serviceConnection: 'my-servicenow'
      kbId: 'list'
```

### Dry-run on PR builds, publish on main

`dryRun` converts, validates, and logs the planned action without writing to
ServiceNow — ideal for pull-request validation:

```yaml
steps:
  - task: PublishKbArticle@1
    displayName: 'Publish (dry-run off main)'
    inputs:
      serviceConnection: 'my-servicenow'
      kbId: '$(kbSysId)'
      title: 'My Terraform Module'
      htmlFile: '$(Build.ArtifactStagingDirectory)/module.html'
      author: 'svc-docs'
      sourceKey: 'my-terraform-module'
      workflowState: 'publish'
      dryRun: ${{ ne(variables['Build.SourceBranch'], 'refs/heads/main') }}
```

### Use the outputs in later steps

Give the step a `name` and read its outputs as `$(<name>.<output>)`. A dry run
and `kbId: 'list'` set none of them:

```yaml
steps:
  - task: PublishKbArticle@1
    name: publish
    displayName: 'Publish module docs'
    inputs:
      serviceConnection: 'my-servicenow'
      kbId: '$(kbSysId)'
      title: 'My Terraform Module'
      htmlFile: '$(Build.ArtifactStagingDirectory)/module.html'
      author: 'svc-docs'
      sourceKey: 'my-terraform-module'
      workflowState: 'publish'

  - script: echo "Published $(publish.kbArticleNumber) as $(publish.kbArticleId), state $(publish.kbWorkflowState)"
    displayName: 'Show the article'
```

### Upload images and use inline OAuth credentials

Relative `<img>` images are uploaded as attachments and their `src` rewritten.
Images are matched by file name: an unchanged image is reused and a changed one
replaced. A `src` that resolves outside `imageBaseDir` (which defaults to the
HTML file's directory) is left alone, an SVG file is never uploaded (a warning
is logged), and a missing image file fails the task unless `force` is set.

Without a service connection, `instance` is the instance name only and
`authType: oauth` (the default) needs both `clientId` and `clientSecret`:

```yaml
steps:
  - task: PublishKbArticle@1
    displayName: 'Publish with images'
    inputs:
      instance: 'mycompany'
      authType: 'oauth'
      clientId: '$(snClientId)'
      clientSecret: '$(snClientSecret)'
      kbId: '$(kbSysId)'
      title: 'My Terraform Module'
      htmlFile: '$(Build.ArtifactStagingDirectory)/module.html'
      author: 'svc-docs'
      sourceKey: 'my-terraform-module'
      uploadImages: true
      imageBaseDir: '$(System.DefaultWorkingDirectory)'
```

### Authenticate with a username and password

`authType: basic` takes `username` and `password` instead of `clientId` and
`clientSecret`. `password` is a secret, so pass it from a variable:

```yaml
steps:
  - task: PublishKbArticle@1
    displayName: 'Publish with basic authentication'
    inputs:
      instance: 'mycompany'
      authType: 'basic'   # oauth | basic
      username: 'svc-docs'
      password: '$(snPassword)'
      kbId: '$(kbSysId)'
      title: 'My Terraform Module'
      htmlFile: '$(Build.ArtifactStagingDirectory)/module.html'
      author: 'svc-docs'
      sourceKey: 'my-terraform-module'
```

A service connection that uses the Basic scheme supplies the same two values,
and its scheme selects basic authentication. `authType` is read only when no
service connection is set.

### Update a known article by sys_id

`articleId` skips every lookup and updates that article. Only the fields you pass
are changed, except `workflowState`, which always applies. Passing `sourceKey`
as well marks the article with the key, so later runs find it by key alone:

```yaml
steps:
  - task: PublishKbArticle@1
    displayName: 'Update a known article'
    inputs:
      serviceConnection: 'my-servicenow'
      articleId: '$(kbArticleSysId)'
      htmlFile: '$(Build.ArtifactStagingDirectory)/module.html'
      sourceKey: 'my-terraform-module'
      workflowState: 'publish'
```

When the article is found (by `articleId`, `sourceKey` or a `KB<number>.json`
file) and none of `title`, `htmlFile`, `category` or `author` is set, the task
changes only the workflow state:

```yaml
steps:
  - task: PublishKbArticle@1
    displayName: 'Send the article for review'
    inputs:
      serviceConnection: 'my-servicenow'
      articleId: '$(kbArticleSysId)'
      workflowState: 'review'   # draft | review | publish
```

### Take the source key from a Markdown file

`readKeyFrom` reads the `kb-key:` field from the YAML front matter of a Markdown
file and uses it as the source key, replacing `sourceKey` if both are set. The
task fails when the file has no front matter or no `kb-key:` field. Keep the key
in the primary file: `Markdown2Html@1` rejects an included file that has one
(see [Front-matter-driven composition](#front-matter-driven-composition)).

```markdown
---
kb-key: my-terraform-module
title: Terraform Module Guide
---
```

```yaml
steps:
  - task: PublishKbArticle@1
    displayName: 'Publish using the kb-key from front matter'
    inputs:
      serviceConnection: 'my-servicenow'
      kbId: '$(kbSysId)'
      title: 'My Terraform Module'
      htmlFile: '$(Build.ArtifactStagingDirectory)/kb.html'
      author: 'svc-docs'
      readKeyFrom: 'kb/index.md'
      workflowState: 'publish'
```

### Record the article in a manifest

After each create or update the task leaves a `KB<number>.json` file in the
working directory, which a later run in the same workspace can use to find the
article. It does not survive a clean workspace, so `sourceKey` is the dependable
way to correlate runs. `emitManifest` instead appends the article's metadata
(source key, `sys_id`, number, knowledge base, title and workflow state) to a
JSON array in the file you name, creating it if needed, and no `KB*.json` file
is written. A manifest that cannot be read is renamed to
`<path>.corrupt-<timestamp>.bak` and a new one is started, and a failed write is
a warning rather than a failure. With `sourceKey` set, the task also logs a
`##[manifest]` line holding the source key, `sys_id` and number:

```yaml
steps:
  - task: PublishKbArticle@1
    displayName: 'Publish and record in a manifest'
    inputs:
      serviceConnection: 'my-servicenow'
      kbId: '$(kbSysId)'
      title: 'My Terraform Module'
      htmlFile: '$(Build.ArtifactStagingDirectory)/module.html'
      author: 'svc-docs'
      sourceKey: 'my-terraform-module'
      emitManifest: '$(Build.ArtifactStagingDirectory)/kb-manifest.json'
```

### Always create a new article

Without an `articleId` or a matching `sourceKey`, the task looks in the working
directory for the most recently modified `KB<number>.json` (or
`article_info.json`) and updates the article it names. `skipJsonLookup` turns
that lookup off, so with no `articleId` or `sourceKey` the task always creates a
new article:

```yaml
steps:
  - task: PublishKbArticle@1
    displayName: 'Create a new article'
    inputs:
      serviceConnection: 'my-servicenow'
      kbId: '$(kbSysId)'
      title: 'My Terraform Module'
      htmlFile: '$(Build.ArtifactStagingDirectory)/module.html'
      author: 'svc-docs'
      skipJsonLookup: true   # default false; ignore KB<number>.json files
```

### Continue past a content-loss warning

The task fails when the HTML parses to less than half its original length, which
usually points at a syntax error. `force` turns that failure into a warning. It
never relaxes the security checks: `<script>` elements, inline event-handler
attributes, `javascript:`, `vbscript:` and non-image `data:` URIs, `<base>` and
meta-refresh redirects, and embedding elements such as `<iframe>` always fail
the task. With `uploadImages`, `force` also lets a missing image file produce a
warning instead of a failure:

```yaml
steps:
  - task: PublishKbArticle@1
    displayName: 'Publish despite a content-loss warning'
    inputs:
      serviceConnection: 'my-servicenow'
      kbId: '$(kbSysId)'
      title: 'My Terraform Module'
      htmlFile: '$(Build.ArtifactStagingDirectory)/module.html'
      author: 'svc-docs'
      force: true   # default false; warn instead of failing on likely content loss
```

## End-to-end: docs to ServiceNow KB

Generate module docs with terraform-docs, render them to HTML, and publish to a
ServiceNow knowledge base — publishing only on `main`, dry-running elsewhere.
`Markdown2Html@1` and `PublishKbArticle@1` are deprecated (they are moving to
`PipelineMarkdown2Html` and `PipelinePublishKbArticle`; see
[Markdown2Html@1](#markdown2html1) and [PublishKbArticle@1](#publishkbarticle1)),
and this pipeline keeps working until its YAML is changed:

```yaml
steps:
  - task: PipelineTerraformDocsInstaller@1
    displayName: 'Install terraform-docs'

  - task: PipelineTerraformDocs@1
    displayName: 'Generate module docs'
    inputs:
      formatter: 'markdown-document'
      modulePath: '$(System.DefaultWorkingDirectory)'
      outputFile: 'MODULE.md'
      outputMode: 'replace'

  - task: Markdown2Html@1
    displayName: 'Render docs to HTML'
    inputs:
      mode: 'filelist'
      inputFiles: 'MODULE.md'
      outputFile: '$(Build.ArtifactStagingDirectory)/module.html'
      title: 'My Terraform Module'

  - task: PublishKbArticle@1
    displayName: 'Publish to ServiceNow KB'
    inputs:
      serviceConnection: 'my-servicenow'
      kbId: '$(kbSysId)'
      title: 'My Terraform Module'
      htmlFile: '$(Build.ArtifactStagingDirectory)/module.html'
      author: 'svc-docs'
      sourceKey: 'my-terraform-module'
      workflowState: 'publish'
      dryRun: ${{ ne(variables['Build.SourceBranch'], 'refs/heads/main') }}
```
