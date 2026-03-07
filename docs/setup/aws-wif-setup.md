# AWS Workload Identity Federation Setup

This guide covers the one-time AWS configuration needed to use Workload Identity Federation (OIDC) with the **Pipeline Tasks for Terraform** extension.

WIF eliminates the need to store static AWS access keys in Azure DevOps. Instead, the pipeline requests a short-lived OIDC token from Azure DevOps, which is used to assume an IAM role via AWS STS.

## Prerequisites

- An AWS account with permissions to create IAM Identity Providers and Roles
- Your Azure DevOps organization ID (found in `https://dev.azure.com/{org}/_settings/organizationAad`)

## Step 1: Create an IAM OIDC Identity Provider

1. Sign in to the AWS Management Console and navigate to **IAM** → **Identity providers**
2. Click **Add provider**
3. Select **OpenID Connect**
4. Set **Provider URL** to: `https://vstoken.dev.azure.com/<your-azure-devops-organization-id>`
   - Replace `<your-azure-devops-organization-id>` with your org's GUID (not the org name)
   - Example: `https://vstoken.dev.azure.com/a1b2c3d4-e5f6-7890-abcd-ef1234567890`
5. Click **Get thumbprint** to automatically populate the certificate thumbprint
6. Set **Audience** to: `api://AzureADTokenV2`
7. Click **Add provider**

## Step 2: Create an IAM Role for Terraform

1. Navigate to **IAM** → **Roles** → **Create role**
2. Select **Web identity** as the trusted entity type
3. Select the identity provider you just created
4. Set audience to `api://AzureADTokenV2`
5. Click **Next** and attach the policies your Terraform configuration requires (e.g., `AmazonEC2FullAccess`, custom policies for your infrastructure)
6. Name the role (e.g., `TerraformDeployRole`) and create it

### Restrict to a specific Azure DevOps service connection (recommended)

Edit the role's trust policy to add a condition that restricts which service connection can assume the role. This prevents other pipelines in your org from using this role.

The OIDC token's `sub` claim contains the service connection ID. To find your service connection ID:

1. Go to **Project Settings** → **Service connections**
2. Click your AWS service connection
3. The ID is the GUID in the browser URL

Update the trust policy condition:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/vstoken.dev.azure.com/<ORG_ID>"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "vstoken.dev.azure.com/<ORG_ID>:aud": "api://AzureADTokenV2",
          "vstoken.dev.azure.com/<ORG_ID>:sub": "sc://<ORG_NAME>/<PROJECT_NAME>/<SERVICE_CONNECTION_NAME>"
        }
      }
    }
  ]
}
```

Replace `<ACCOUNT_ID>`, `<ORG_ID>`, `<ORG_NAME>`, `<PROJECT_NAME>`, and `<SERVICE_CONNECTION_NAME>` with your values.

## Step 3: Configure the Pipeline Task

In your Azure Pipeline YAML, add the Terraform task with the WIF auth scheme:

```yaml
- task: TerraformTaskV5@5
  inputs:
    provider: 'aws'
    command: 'plan'
    environmentServiceNameAWS: 'my-aws-service-connection'
    environmentAuthSchemeAWS: 'WorkloadIdentityFederation'
    awsRoleArn: 'arn:aws:iam::123456789012:role/TerraformDeployRole'
    awsRegion: 'us-east-1'
    awsSessionName: 'AzureDevOps-Terraform'   # optional
    workingDirectory: '$(System.DefaultWorkingDirectory)/terraform'
```

## How It Works

At runtime, the task:

1. Requests an OIDC token from Azure DevOps (signed by `vstoken.dev.azure.com`)
2. Writes the token to a temporary file on the agent
3. Sets `AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_REGION`, and `AWS_ROLE_SESSION_NAME` environment variables
4. Runs `terraform plan` (or apply/destroy)
5. The Terraform AWS provider calls `sts:AssumeRoleWithWebIdentity` using the token file
6. AWS validates the token signature against the registered OIDC provider
7. If the conditions in the trust policy match, AWS issues temporary credentials for the role

The temporary credentials have a maximum lifetime of 1 hour, which is sufficient for any Terraform operation.

## Troubleshooting

### "WebIdentityErr: failed to retrieve credentials"

- Verify the role ARN is correct
- Verify the trust policy audience matches `api://AzureADTokenV2`
- Verify the `sub` condition (if set) matches the service connection path exactly

### "InvalidIdentityToken: No OpenIDConnect provider found"

- The OIDC provider URL must exactly match the issuer in the token
- Verify your organization ID is the GUID, not the name

### Token not generated

- The Azure DevOps service connection must have the Workload Identity Federation capability
- Verify `SYSTEM_OIDCREQUESTURI` is available in the pipeline (it is set automatically for pipelines using service connections with WIF)
