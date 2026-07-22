# Azure (AzureRM) Workload Identity Federation Setup

This guide covers the one-time Azure configuration needed to use Workload Identity Federation (OIDC) with the **Pipeline Tasks for Terraform** extension.

Unlike [AWS](aws-wif-setup.md), [GCP](gcp-wif-setup.md), and [OCI](oci-wif-setup.md), AzureRM has no `environmentAuthSchemeAzureRM` task input and no separate cloud-side OIDC provider object to create. For AzureRM, **the Azure Resource Manager service connection itself _is_ the Workload Identity Federation** — you configure WIF once, when you create (or convert) the service connection, and the task inputs below (`environmentServiceNameAzureRM`, `backendServiceArm`) simply reference that connection by name. At runtime the task reads the connection's own configured authorization scheme (`WorkloadIdentityFederation`, `ManagedServiceIdentity`, or `ServicePrincipal`) — there's nothing WIF-specific to select in the task itself.

## Prerequisites

- Permission to create service connections in the Azure DevOps project (Service connection administrator or endpoint administrator).
- Either:
  - **Owner** on the target Azure subscription (for the automatic flow below), or
  - Permission to create a Microsoft Entra app registration (or a user-assigned managed identity) plus permission to grant it an RBAC role on the target scope (for the manual flow).

## Step 1: Create the Azure Resource Manager service connection

### Option A — Automatic (Azure DevOps creates the app registration and federation for you)

Use this if you have **Owner** on the subscription:

1. In the Azure DevOps project, go to **Project settings** → **Service connections** → **New service connection**.
2. Select **Azure Resource Manager** → **Next**.
3. Select **App registration (automatic)** with the credential **Workload identity federation** — do _not_ pick the **Secret** credential option, which stores a static secret instead.
4. Choose a **Scope level** (Subscription, Management Group, or Machine Learning Workspace), select the target, and name the connection.

Azure DevOps creates the Entra app registration, the federated credential, and the connection in one flow.

### Option B — Manual (existing identity, or no Owner permission)

Use this if you don't have Owner on the subscription, need to reuse an existing app registration/managed identity, or want to control the federated credential yourself:

1. Create (or choose an existing) Microsoft Entra **app registration** or **user-assigned managed identity**.
2. In Azure DevOps, create the service connection (**Azure Resource Manager** → **App registration (manual)** or **Managed identity**, credential **Workload identity federation**) and save it **as a draft** — Azure DevOps generates and displays the exact **Issuer** and **Subject identifier** values for this connection.
3. On the app registration or managed identity in Azure, add a federated credential using that Issuer/Subject and audience `api://AzureADTokenExchange`.
4. Grant the identity a least-privilege RBAC role (see Step 2), then return to Azure DevOps and complete/save the service connection.

See Microsoft's [Manually set an Azure Resource Manager workload identity service connection](https://learn.microsoft.com/azure/devops/pipelines/release/configure-workload-identity) for the full click-by-click walkthrough, or [Use scripts to automate Azure Resource Manager with workload identity service connections](https://learn.microsoft.com/azure/devops/pipelines/release/automate-service-connections) for a scripted `az cli` flow.

## Step 2: Assign a least-privilege RBAC role

> **Security note:** don't assign **Owner** or **Contributor** at the subscription root. Scope the role assignment to the narrowest resource group (or resource) your Terraform configuration actually manages, and prefer a built-in role no broader than **Contributor** on that scope — or a custom role restricted to the specific actions your configuration needs.

## Step 3: Reference the service connection from the pipeline

```yaml
- task: PipelineTerraformTask@5
  inputs:
    provider: 'azurerm'
    command: 'plan'
    environmentServiceNameAzureRM: 'my-azure-service-connection'
```

There is no `environmentAuthSchemeAzureRM` input — whichever authentication method `my-azure-service-connection` is configured with (Workload identity federation, per this guide) is what the task uses.

The `azurerm` backend works the same way, via `backendServiceArm`:

```yaml
- task: PipelineTerraformTask@5
  inputs:
    command: 'init'
    provider: 'azurerm'
    backendType: 'azurerm'
    backendServiceArm: 'my-azure-service-connection'
    backendAzureRmResourceGroupName: 'my-tfstate-rg'
    backendAzureRmStorageAccountName: 'mytfstatestorage'
    backendAzureRmContainerName: 'tfstate'
    backendAzureRmKey: 'my-project.tfstate'
```

## Token modes and exposure

Both the provider and the backend have a boolean input, default `false`, controlling how the WIF token is acquired: `environmentAzureRmUseIdTokenGeneration` (provider) and `backendAzureRmUseIdTokenGeneration` (backend).

- **Default (`false`) — ID token refresh mode:** the task exports the broad ADO pipeline OIDC access token (`ARM_OIDC_REQUEST_TOKEN`) into the Terraform process environment for the **whole run**, and the `azurerm` provider/backend refreshes it as needed. This is present regardless of whether `runAzLogin` is enabled — `runAzLogin` only additionally signs the Azure CLI in with it. Because the token sits in the process environment for the run's duration, it's inherited by any `local-exec` provisioner or `external` data source the configuration runs.
- **`true` — one-shot ID token mode:** the task generates a single-use `ARM_OIDC_TOKEN` up front instead of leaving a refreshable token in the environment for the whole run.

> **Security note:** for pipelines that run untrusted or third-party modules/providers on shared agents, set `environmentAzureRmUseIdTokenGeneration`/`backendAzureRmUseIdTokenGeneration` to `true`. See [docs/troubleshooting.md](../troubleshooting.md) for the related local-exec/external note, and [SECURITY.md](../../SECURITY.md) for `runAzLogin`'s own (separate, accepted) argv-exposure residual risk.

Both tokens are registered with `setSecret` and masked in the pipeline log like any other credential.

## How It Works

At runtime, the task:

1. Reads the connection name from `environmentServiceNameAzureRM`/`backendServiceArm`.
2. Asks the ADO agent for that connection's configured authorization scheme (`tasks.getEndpointAuthorizationScheme`).
3. For `WorkloadIdentityFederation`, the agent/connection obtains Azure DevOps's own OIDC token and exchanges it with Microsoft Entra for a short-lived access token — the exchange itself happens inside the ADO agent/connection, not in this extension's code.
4. The task exports the resulting token (`ARM_OIDC_REQUEST_TOKEN` or `ARM_OIDC_TOKEN`, per the token mode above) plus `ARM_TENANT_ID`, `ARM_SUBSCRIPTION_ID`, and `ARM_CLIENT_ID` as environment variables the `azurerm` provider/backend read directly.
5. `terraform` runs with these credentials in its process environment for the step's duration — no static secret ever exists.

## Troubleshooting

### "Unrecognized authorization scheme 'xxx'"

The connection's authorization scheme must map (case-insensitively) to one of `WorkloadIdentityFederation`, `ManagedServiceIdentity`, or `ServicePrincipal`. Open the service connection and confirm its authentication method, or recreate it following Step 1. See [docs/troubleshooting.md](../troubleshooting.md).

### Broad token exposure to `local-exec`/`external` data sources

See [Token modes and exposure](#token-modes-and-exposure) above.

### An existing connection is flagged as using a deprecated issuer

See Microsoft's [Convert service connections](https://learn.microsoft.com/azure/devops/pipelines/release/convert-service-connections) guide — conversion doesn't require any change to this task's inputs.
