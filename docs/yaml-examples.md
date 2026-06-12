# Azure Pipelines Terraform Extension — YAML Examples

## Task Reference

- [`PipelineTerraformInstaller@1`](#pipelineterraforminstaller1) — Install Terraform or OpenTofu
- [`PipelineTerraformProviderMirror@1`](#pipelineterraformprovidermirror1) — Configure provider network mirror
- [`PipelineTerraformTask@5`](#pipelineterraformtask5) — Run Terraform commands (init, plan, apply, destroy, etc.)
- [Cross-cloud examples](#cross-cloud-examples) — AzureRM state with AWS/GCP resources; HCP Terraform with AzureRM resources

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
