# GCP Workload Identity Federation Setup

This guide covers the one-time GCP configuration needed to use Workload Identity Federation (OIDC) with the **Pipeline Tasks for Terraform** extension.

WIF eliminates the need to store GCP service account JSON keys in Azure DevOps. Instead, the pipeline requests a short-lived OIDC token from Azure DevOps, which GCP exchanges for a temporary access token via Workload Identity Federation.

## Prerequisites

- A GCP project with Owner or IAM Admin permissions
- `gcloud` CLI installed, or access to the GCP Console
- Your Azure DevOps organization ID (found in `https://dev.azure.com/{org}/_settings/organizationAad`)

## Step 1: Enable Required APIs

```bash
gcloud services enable iam.googleapis.com
gcloud services enable iamcredentials.googleapis.com
gcloud services enable sts.googleapis.com
```

## Step 2: Create a Workload Identity Pool

```bash
gcloud iam workload-identity-pools create "azure-devops-pool" \
    --project="<YOUR_PROJECT_ID>" \
    --location="global" \
    --display-name="Azure DevOps"
```

Note the full pool resource name — you will need it:

```text
projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/azure-devops-pool
```

To get your project number:

```bash
gcloud projects describe <YOUR_PROJECT_ID> --format="value(projectNumber)"
```

## Step 3: Create an OIDC Provider in the Pool

```bash
gcloud iam workload-identity-pools providers create-oidc "azure-devops-provider" \
    --project="<YOUR_PROJECT_ID>" \
    --location="global" \
    --workload-identity-pool="azure-devops-pool" \
    --display-name="Azure DevOps OIDC" \
    --issuer-uri="https://vstoken.dev.azure.com/<YOUR_ORG_ID>" \
    --allowed-audiences="api://AzureADTokenV2" \
    --attribute-mapping="google.subject=assertion.sub,attribute.service_connection=assertion.sub"
```

Replace `<YOUR_ORG_ID>` with your Azure DevOps organization ID (the GUID, not the name).

### Restrict to a specific service connection (recommended)

Add an attribute condition to restrict which Azure DevOps service connection can use this provider. The OIDC token `sub` claim format is:

```text
sc://<ORG_NAME>/<PROJECT_NAME>/<SERVICE_CONNECTION_NAME>
```

Update the provider with a condition:

```bash
gcloud iam workload-identity-pools providers update-oidc "azure-devops-provider" \
    --project="<YOUR_PROJECT_ID>" \
    --location="global" \
    --workload-identity-pool="azure-devops-pool" \
    --attribute-condition="attribute.service_connection == 'sc://<ORG_NAME>/<PROJECT_NAME>/<SERVICE_CONNECTION_NAME>'"
```

## Step 4: Create a Service Account for Terraform

Create the service account that Terraform will impersonate:

```bash
gcloud iam service-accounts create "terraform-deployer" \
    --project="<YOUR_PROJECT_ID>" \
    --display-name="Terraform Deployer"
```

Attach the permissions your Terraform configuration requires:

```bash
# Example: Editor role (adjust to the minimum required)
gcloud projects add-iam-policy-binding <YOUR_PROJECT_ID> \
    --member="serviceAccount:terraform-deployer@<YOUR_PROJECT_ID>.iam.gserviceaccount.com" \
    --role="roles/editor"
```

## Step 5: Grant Workload Identity User Role

Allow the Workload Identity Pool to impersonate the service account:

```bash
gcloud iam service-accounts add-iam-policy-binding \
    "terraform-deployer@<YOUR_PROJECT_ID>.iam.gserviceaccount.com" \
    --project="<YOUR_PROJECT_ID>" \
    --role="roles/iam.workloadIdentityUser" \
    --member="principalSet://iam.googleapis.com/projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/azure-devops-pool/attribute.service_connection/sc://<ORG_NAME>/<PROJECT_NAME>/<SERVICE_CONNECTION_NAME>"
```

## Step 6: Collect Values for the Pipeline Task

You will need these values for the pipeline task configuration:

| Value | Where to find it |
| --- | --- |
| Project number | `gcloud projects describe <PROJECT_ID> --format="value(projectNumber)"` |
| Pool ID | `azure-devops-pool` (as created above) |
| Provider ID | `azure-devops-provider` (as created above) |
| Service account email | `terraform-deployer@<YOUR_PROJECT_ID>.iam.gserviceaccount.com` |

## Step 7: Configure the Pipeline Task

```yaml
- task: TerraformTaskV5@5
  inputs:
    provider: 'gcp'
    command: 'plan'
    environmentServiceNameGCP: 'my-gcp-service-connection'
    environmentAuthSchemeGCP: 'WorkloadIdentityFederation'
    gcpProjectNumber: '123456789012'
    gcpWorkloadIdentityPoolId: 'azure-devops-pool'
    gcpWorkloadIdentityProviderId: 'azure-devops-provider'
    gcpServiceAccountEmail: 'terraform-deployer@my-project.iam.gserviceaccount.com'
    workingDirectory: '$(System.DefaultWorkingDirectory)/terraform'
```

## How It Works

At runtime, the task:

1. Requests an OIDC token from Azure DevOps (signed by `vstoken.dev.azure.com`)
2. Writes the token to a temporary file on the agent
3. Constructs an external account credentials JSON file pointing to the token file and the GCP WIF pool/provider
4. Sets `GOOGLE_CREDENTIALS` to the path of the credentials file
5. Runs `terraform plan` (or apply/destroy)
6. The Terraform Google provider uses `GOOGLE_CREDENTIALS` to call `sts.googleapis.com` for token exchange
7. GCP validates the OIDC token signature and attribute conditions
8. GCP issues a short-lived access token for the service account

The access token is valid for 1 hour, which is sufficient for any Terraform operation.

## Troubleshooting

### "Error creating service account token: googleapi: Error 403: Permission iam.serviceAccounts.getAccessToken denied"

- The Workload Identity Pool principal does not have `roles/iam.workloadIdentityUser` on the service account
- Verify the `--member` value in Step 5 exactly matches the token's `sub` claim path

### "Unable to parse credentials file"

- The external account JSON was not written correctly
- Check the task output for the credentials file path and verify the JSON is valid

### "Invalid JWT: Token must be a short-lived token"

- The OIDC token has expired (they are valid for ~5 minutes)
- This should not happen in normal pipeline execution; if it does, check for delays in the pipeline before the Terraform step

### Pool or provider not found

- Verify the pool ID and provider ID are exactly as specified (case-sensitive)
- Verify the pool is in the `global` location
