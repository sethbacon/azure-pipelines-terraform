# Azure Pipelines Terraform Extension — YAML Examples

## Task Reference

- [`PipelineTerraformInstaller@1`](#pipelineterraforminstaller1) — Install Terraform or OpenTofu
- [`PipelineTerraformProviderMirror@1`](#pipelineterraformprovidermirror1) — Configure provider network mirror
- [`PipelineTerraformTask@5`](#pipelineterraformtask5) — Run Terraform commands (init, plan, apply, destroy, etc.)
- [Cross-cloud examples](#cross-cloud-examples) — AzureRM state with AWS/GCP resources; HCP Terraform with AzureRM resources
- [Policy as code](#policy-as-code) — Install OPA/Sentinel and evaluate policies against plan JSON
- [`PipelineTerraformDriftReport@1`](#pipelineterraformdriftreport1) — Summarise plan drift, optional SARIF report + TSM callback
- [`PipelineTerraformModulePublish@1`](#pipelineterraformmodulepublish1) — Publish a module version to HCP Terraform or a private registry
- [`PipelineTerraformDocsInstaller@1`](#pipelineterraformdocsinstaller1) — Install terraform-docs
- [`PipelineTerraformDocs@1`](#pipelineterraformdocs1) — Generate Terraform module documentation with terraform-docs
- [`Markdown2Html@1`](#markdown2html1) — Convert Markdown docs to a single styled HTML file
- [`PublishKbArticle@1`](#publishkbarticle1) — Create or update a ServiceNow knowledge base article
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

### Install OpenTofu

```yaml
- task: PipelineTerraformInstaller@1
  displayName: 'Install OpenTofu 1.9.0'
  inputs:
    binary: 'tofu'
    terraformVersion: '1.9.0'
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
```

---

## PipelineTerraformProviderMirror@1

Write a `.terraformrc` that routes provider downloads through a network mirror. Run this before `terraform init`.

### Basic mirror (no direct fallback)

```yaml
- task: PipelineTerraformProviderMirror@1
  displayName: 'Configure provider mirror'
  inputs:
    mirrorUrl: 'https://registry.example.com/terraform/providers'
    allowDirectFallback: false
```

### Mirror with fallback to public registry

```yaml
- task: PipelineTerraformProviderMirror@1
  displayName: 'Configure provider mirror (with fallback)'
  inputs:
    mirrorUrl: 'https://registry.example.com/terraform/providers'
    allowDirectFallback: true
```

### Mirror with restricted direct download

```yaml
- task: PipelineTerraformProviderMirror@1
  displayName: 'Configure provider mirror (restricted fallback)'
  inputs:
    mirrorUrl: 'https://registry.example.com/terraform/providers'
    allowDirectFallback: true
    directExcludePatterns: |
      registry.terraform.io/company-internal/*
    directIncludePatterns: |
      registry.terraform.io/hashicorp/azurerm
      registry.terraform.io/hashicorp/aws
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

---

### AWS

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

#### Init with GCS backend

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Init'
  inputs:
    provider: 'gcp'
    command: 'init'
    backendType: 'gcs'
    backendServiceGCP: 'my-gcp-service-connection'
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
```

---

### OCI

#### Init with OCI backend

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Init'
  inputs:
    provider: 'oci'
    command: 'init'
    backendType: 'oci'
    backendServiceOCI: 'my-oci-service-connection'
    backendOCIPar: 'https://objectstorage.eu-frankfurt-1.oraclecloud.com/p/...'
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

#### Output (export to file)

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Output'
  inputs:
    provider: 'azurerm'
    command: 'output'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
    outputTo: 'file'
    filename: '$(Pipeline.Workspace)/tf-outputs.json'
```

#### Show plan as JSON

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Show'
  inputs:
    provider: 'azurerm'
    command: 'show'
    commandOptions: 'tfplan'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
    outputTo: 'file'
    outputFormat: 'json'
    filename: '$(Pipeline.Workspace)/plan.json'
```

#### Workspace — create/select

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Workspace Select'
  inputs:
    provider: 'azurerm'
    command: 'workspace'
    workspaceSubCommand: 'select'
    workspaceName: 'production'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
```

#### State list

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform State List'
  inputs:
    provider: 'azurerm'
    command: 'state'
    stateSubCommand: 'list'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
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

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Force Unlock'
  inputs:
    provider: 'azurerm'
    command: 'forceunlock'
    lockId: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
```

#### Custom command

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Custom Command'
  inputs:
    provider: 'azurerm'
    command: 'custom'
    customCommand: 'providers lock -platform=linux_amd64'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
```

#### Test (with JUnit output)

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Test'
  inputs:
    provider: 'azurerm'
    command: 'test'
    testJunitXmlPath: '$(Common.TestResultsDirectory)/terraform-tests.xml'
    testFilter: 'tests/unit'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
```

---

### Variables and var files

#### Inline variables

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

```yaml
- task: PipelineTerraformTask@5
  displayName: 'Terraform Apply'
  inputs:
    provider: 'azurerm'
    command: 'apply'
    commandOptions: 'tfplan'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
    varFile: |
      environments/prod.tfvars
      environments/prod-secrets.tfvars
```

#### Secure var file (from ADO Secure Files)

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

## Cross-cloud examples

These examples combine a remote state backend from one cloud with provider credentials for another.
The `provider` input controls which cloud authenticates for the Terraform *provider* (resources).
The `backendType` input (on `init`) controls which cloud stores *state*.

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

  - task: PipelineTerraformTask@5
    displayName: 'Terraform Apply'
    condition: and(succeeded(), eq(variables['terraformPlan.changesPresent'], 'true'))
    inputs:
      provider: 'gcp'
      command: 'apply'
      commandOptions: 'tfplan'
      environmentServiceNameGCP: 'my-gcp-service-connection'
```

---

### HCP Terraform backend + AzureRM resources

Use HCP Terraform (Terraform Cloud) for state and remote operations while authenticating to Azure for provider calls.

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

  - task: PipelineTerraformTask@5
    displayName: 'Terraform Apply'
    condition: and(succeeded(), eq(variables['terraformPlan.changesPresent'], 'true'))
    inputs:
      provider: 'azurerm'
      command: 'apply'
      commandOptions: 'tfplan'
      environmentServiceNameAzureRM: 'my-azure-service-connection'
```

---

## Policy as code

The `PipelinePolicyAgentInstaller@1` and `PipelineTerraformPolicyCheck@1` tasks
evaluate OPA or Sentinel policies against Terraform plan JSON. The natural chain
is plan → show -json → policy check.

### Install a policy engine

```yaml
# OPA from GitHub releases (default)
- task: PipelinePolicyAgentInstaller@1
  inputs:
    policyAgent: 'opa'
    version: 'latest'

# Sentinel from releases.hashicorp.com (GPG-verified)
- task: PipelinePolicyAgentInstaller@1
  inputs:
    policyAgent: 'sentinel'
    version: 'latest'

# From a private registry mirror
- task: PipelinePolicyAgentInstaller@1
  inputs:
    policyAgent: 'opa'
    version: 'latest'
    downloadSource: 'registry'
    registryUrl: 'https://registry.example.com'
    registryMirrorName: 'opa'
```

### Evaluate OPA policies from a checked-out path

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
    filename: 'plan.json'
    commandOptions: 'tfplan'

- task: PipelineTerraformPolicyCheck@1
  inputs:
    engine: 'opa'
    inputFile: '$(tfshow.showFilePath)'
    policySource: 'path'
    policyPath: '$(Build.SourcesDirectory)/policies'
    decisionPath: 'terraform/deny'
    failMode: 'nonEmpty'
```

A `terraform/deny` rule that returns a non-empty set of message strings fails the
task and surfaces each message as an error. Policies evaluate the raw
`terraform show -json` document as `input`.

### Evaluate Sentinel policies with enforcement levels

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
Bring your own config with `sentinelConfigPath` to manage imports yourself.

### Clone policies from a git repository

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

The check task sets output variables `policyResult` (`passed`/`failed`),
`violationCount`, and `resultsFilePath`, and (by default) publishes a JUnit
report so outcomes appear in the pipeline **Tests** tab.

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
    filename: 'plan.json'
    commandOptions: 'tfplan'

- task: PipelineTerraformDriftReport@1
  name: drift
  inputs:
    planJsonFile: '$(tfshow.showFilePath)'
```

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
```

The result is POSTed **only when both `callbackUrl` and `callbackToken` are
set**. `callbackToken` is a per-run one-shot token sent as the
`X-TSM-Callback-Token` header — pass it as a secret variable. `rejectUnauthorized`
(default `true`) verifies the callback's TLS certificate; set it `false` only for
a private-CA endpoint the agent does not trust.

### Emit a SARIF report

```yaml
- task: PipelineTerraformDriftReport@1
  name: drift
  inputs:
    planJsonFile: '$(tfshow.showFilePath)'
    sarifOutput: true               # default false
    # sarifPath: '$(Build.ArtifactStagingDirectory)/drift.sarif'  # optional; defaults to the agent temp dir

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

Module provenance: `includeModuleProvenance` (default `true`) adds the
configuration's `module_calls` and locked module versions — read from
`moduleManifest` (default `.terraform/modules/modules.json`) — to the report and
callback body. Set it `false` to omit them.

---

## PipelineTerraformModulePublish@1

Publish a module version to HCP Terraform / Terraform Enterprise or a private
`terraform-registry-backend`. Typically the last step of a module's release
pipeline.

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

`apiKey` must be a **secret** pipeline variable with the `modules:write` scope —
never inline the literal. For an internal registry fronted by a private CA the
agent does not trust, prefer installing the CA via `NODE_EXTRA_CA_CERTS`;
`skipTlsVerify: true` is a last resort.

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
    # hcpAddress defaults to https://app.terraform.io; point it at your TFE host for Terraform Enterprise
```

For HCP Terraform / TFE the `namespace` is the organization name. `hcpToken` is a
team or user API token and must be a secret variable.

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

---

## PipelineTerraformDocsInstaller@1

Install [terraform-docs](https://terraform-docs.io) on the pipeline agent and
prepend it to `PATH`. Run this before `PipelineTerraformDocs@1`. Like the other
installers it verifies the download's SHA256 checksum over HTTPS and supports
official (GitHub releases), private-registry, and custom-mirror sources.

### Install latest terraform-docs

```yaml
- task: PipelineTerraformDocsInstaller@1
  displayName: 'Install terraform-docs (latest)'
  inputs:
    version: 'latest'
```

### Install a pinned version

```yaml
- task: PipelineTerraformDocsInstaller@1
  displayName: 'Install terraform-docs 0.20.0'
  inputs:
    version: '0.20.0'
```

### Download terraform-docs from a custom mirror

```yaml
- task: PipelineTerraformDocsInstaller@1
  displayName: 'Install terraform-docs from mirror'
  inputs:
    version: '0.20.0'
    downloadSource: 'mirror'
    mirrorBaseUrl: 'https://mirror.example.com/terraform-docs'
    requireChecksum: true
```

### Download terraform-docs from a private registry backend

```yaml
- task: PipelineTerraformDocsInstaller@1
  displayName: 'Install terraform-docs from private registry'
  inputs:
    version: '0.20.0'
    downloadSource: 'registry'
    registryUrl: 'https://registry.example.com'
    registryMirrorName: 'terraform-docs'
```

The task sets output variables `terraformDocsLocation` (the installed binary
path) and `terraformDocsDownloadedFrom` (`official`, `registry:<url>`,
`mirror:<url>`, or `cache`).

---

## PipelineTerraformDocs@1

Generate documentation for a Terraform module with terraform-docs. Requires
terraform-docs on `PATH` — run `PipelineTerraformDocsInstaller@1` first.
terraform-docs exits non-zero on error and, with `outputCheck`, when the target
file is out of date — either fails the task.

### Inject a Markdown table into README.md

The most common use — refresh the content between the terraform-docs markers in
`README.md`. The module's `README.md` must already contain the marker comments:

```markdown
<!-- BEGIN_TF_DOCS -->
<!-- END_TF_DOCS -->
```

```yaml
- task: PipelineTerraformDocs@1
  displayName: 'Generate module docs'
  inputs:
    formatter: 'markdown-table'
    modulePath: '$(System.DefaultWorkingDirectory)/modules/vpc'
    outputFile: 'README.md'
    outputMode: 'inject'
```

The written file path is exposed via the `generatedFilePath` output variable.

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

### Recurse across submodules

```yaml
- task: PipelineTerraformDocs@1
  displayName: 'Generate docs for all submodules'
  inputs:
    formatter: 'markdown-table'
    modulePath: '$(System.DefaultWorkingDirectory)'
    outputFile: 'README.md'
    outputMode: 'inject'
    recursive: true
    recursivePath: 'modules'
```

### Use a terraform-docs config file

```yaml
- task: PipelineTerraformDocs@1
  displayName: 'Generate docs from config'
  inputs:
    formatter: 'markdown-document'
    modulePath: '$(System.DefaultWorkingDirectory)/modules/vpc'
    configFile: '.terraform-docs.yml'
    sortBy: 'required'                 # default | name | required | type
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
`tfvars-json`. Pass any other terraform-docs flag the task does not surface as a
dedicated input via `additionalArgs` (e.g. `--hide-empty`).

## Markdown2Html@1

Converts Markdown to a single styled HTML document (markdown-it + highlight.js).
Runs locally — no network access. Sets the `htmlFilePath` output variable.

### Convert a single generated doc file

```yaml
steps:
  - task: Markdown2Html@1
    displayName: 'Render module docs to HTML'
    inputs:
      mode: 'filelist'
      inputFiles: 'MODULE.md'
      outputFile: '$(Build.ArtifactStagingDirectory)/module.html'
      title: 'My Terraform Module'
```

### Combine several files with section headings and dividers

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

The primary file's YAML front-matter declares the included files and options
(`toc`, `separator`, `heading-shift`, `section-anchors`):

```yaml
steps:
  - task: Markdown2Html@1
    displayName: 'Render KB page from front matter'
    inputs:
      mode: 'frontMatter'
      primaryFile: 'kb/index.md'
      outputFile: '$(Build.ArtifactStagingDirectory)/kb.html'
```

## PublishKbArticle@1

Creates or updates a ServiceNow knowledge base article from an HTML file.
Authenticates via a `ServiceNowKb` service connection (OAuth client credentials
or basic) or inline credentials. All requests are HTTPS-only; the token/password
are masked in logs. Sets `kbArticleId`, `kbArticleNumber`, and `kbWorkflowState`.

### Create or update via a service connection (idempotent)

`sourceKey` correlates re-runs to the same article, so this create-or-updates:

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
      sourceKey: 'my-terraform-module'
      workflowState: 'publish'
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

### Upload images and use inline OAuth credentials

Relative `<img>` images are uploaded as attachments and their `src` rewritten:

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

## End-to-end: docs to ServiceNow KB

Generate module docs with terraform-docs, render them to HTML, and publish to a
ServiceNow knowledge base — publishing only on `main`, dry-running elsewhere:

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
