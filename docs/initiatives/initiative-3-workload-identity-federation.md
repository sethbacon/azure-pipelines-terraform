# Initiative 3: Workload Identity Federation for Non-AzureRM Providers

## Goal

1. Decouple the state backend from the deployment provider (add `backendType` input)
2. Add Workload Identity Federation (OIDC) support for AWS and GCP providers
3. Support all Terraform backends: first-class for azurerm/s3/gcs/hcp, plus a generic passthrough for all others

## Implementation Status

**Status: COMPLETED** — All features shipped in v0.8.0 (AWS/GCP WIF, backend/provider decoupling, HCP backend). This document is retained for reference.

### Original tracking (as of v0.1.2)

| Item | Status |
| ------ | -------- |
| `backendType` input (azurerm, s3, gcs, oci, generic, local) | Done |
| `ParentCommandHandler` routing by `backendType` on init | Done |
| `TerraformCommandHandlerGeneric` (generic + local) | Done |
| `environmentAuthSchemeAWS` + AWS WIF provider branch | Done |
| `environmentAuthSchemeGCP` + GCP WIF provider branch | Done |
| HCP Terraform Cloud backend (`backendType: hcp`) | COMPLETED |

### HCP Backend — Implementation Note

HCP Terraform Cloud backend support is now implemented. The `TerraformCommandHandlerHCP` class,
`backendHCPToken` / `backendHCPOrganization` / `backendHCPWorkspace` inputs, and the `hcp` option
in the `backendType` picklist are all in place.

## Phase Split

- **Phase 1:** `backendType` decoupling + Generic/Local handlers. Complete. HCP handler pending v0.2.0.
- **Phase 2:** AWS and GCP WIF (OIDC) for plan/apply/destroy. Complete.

## Background: Backend/Provider Coupling Problem

The current design uses a single `provider` input to control both state backend (for `init`) and deployment provider (for `plan`/`apply`/`destroy`). This makes it impossible to use, for example, Azure Blob state with AWS infrastructure.

**Solution:** Add a `backendType` input. `init` routes to the handler selected by `backendType`. All other commands continue to route to the handler selected by `provider`.

## Files to Modify

| File | Change |
| --- | --- |
| `Tasks/TerraformTask/TerraformTaskV5/task.json` | Add `backendType`, backend-specific inputs, AWS/GCP auth scheme inputs |
| `Tasks/TerraformTask/TerraformTaskV5/task.loc.json` | Add localization keys |
| `Tasks/TerraformTask/TerraformTaskV5/src/parent-handler.ts` | Decouple init routing from provider routing |
| `Tasks/TerraformTask/TerraformTaskV5/src/aws-terraform-command-handler.ts` | Add WIF branch |
| `Tasks/TerraformTask/TerraformTaskV5/src/gcp-terraform-command-handler.ts` | Add WIF branch |
| `Tasks/TerraformTask/TerraformTaskV5/src/id-token-generator.ts` | Extend for non-Azure service connection use |
| `Tasks/TerraformTask/TerraformTaskV5/src/hcp-terraform-command-handler.ts` | New file |
| `Tasks/TerraformTask/TerraformTaskV5/src/generic-terraform-command-handler.ts` | New file |
| `Tasks/TerraformTask/TerraformTaskV5/src/local-terraform-command-handler.ts` | Not created as a separate file; both "generic" and "local" backends are routed to `TerraformCommandHandlerGeneric` in `parent-handler.ts` |
| `Tasks/TerraformTask/TerraformTaskV5/Tests/` | Add WIF test cases for AWS and GCP |
| `docs/setup/aws-wif-setup.md` | New — IAM identity provider setup guide |
| `docs/setup/gcp-wif-setup.md` | New — GCP WIF pool setup guide |

## Phase 1: Backend/Provider Decoupling

### New `backendType` Task Input

```json
{
  "name": "backendType",
  "type": "pickList",
  "label": "State backend type",
  "defaultValue": "azurerm",
  "required": true,
  "visibleRule": "command = init",
  "helpMarkDown": "Where Terraform remote state is stored. Independent of the deployment provider. Use 'Generic / Other' for backends not listed (http, kubernetes, PostgreSQL, Consul, Alibaba OSS, Tencent COS, etcd, etc.).",
  "options": {
    "azurerm": "Azure Blob Storage (azurerm)",
    "s3": "Amazon S3 (s3)",
    "gcs": "Google Cloud Storage (gcs)",
    "hcp": "HCP Terraform / Terraform Cloud (cloud)",
    "generic": "Generic / Other (http, pg, consul, kubernetes, oss, cos, etcdv3, ...)",
    "local": "Local filesystem (no remote state)"
  }
}
```

Existing backend config input `visibleRule` values change from `provider = X && command = init` to `backendType = X && command = init`.

### Generic Backend Inputs

```json
{
  "name": "backendConfigArgs",
  "type": "multiLine",
  "label": "Backend configuration (key=value pairs)",
  "visibleRule": "backendType = generic && command = init",
  "required": false,
  "helpMarkDown": "One backend-config argument per line in key=value format. Each line is passed as a separate -backend-config flag.\n\nExamples:\n  HTTP backend:   address=https://my-server/state\n  PostgreSQL:     conn_str=postgres://user:pass@host/db?sslmode=disable\n  Consul:         address=consul.example.com:8500\n                  path=infra/terraform.tfstate"
},
{
  "name": "backendConfigFile",
  "type": "filePath",
  "label": "Backend config file (.tfbackend)",
  "visibleRule": "backendType = generic && command = init",
  "required": false,
  "helpMarkDown": "Path to a Terraform backend configuration file (.tfbackend). Passed as -backend-config=<file> to terraform init."
}
```

### Updated `ParentCommandHandler`

```typescript
export class ParentCommandHandler implements IParentCommandHandler {
    public async execute(providerName: string, command: string): Promise<number> {
        let handler: BaseTerraformCommandHandler;

        if (command === 'init') {
            const backendType = tasks.getInput("backendType", true);
            handler = this.createHandler(backendType);
        } else {
            handler = this.createHandler(providerName);
        }

        return await handler[command]();
    }

    private createHandler(name: string): BaseTerraformCommandHandler {
        switch(name) {
            case "azurerm":  return new TerraformCommandHandlerAzureRM();
            case "aws":      return new TerraformCommandHandlerAWS();
            case "gcp":      return new TerraformCommandHandlerGCP();
            case "oci":      return new TerraformCommandHandlerOCI();
            case "hcp":      return new TerraformCommandHandlerHCP();
            case "generic":  return new TerraformCommandHandlerGeneric();
            case "local":    return new TerraformCommandHandlerLocal();
            default: throw new Error(tasks.loc("ProviderNotFound", name));
        }
    }
}
```

### New Handler: `TerraformCommandHandlerGeneric`

```typescript
export class TerraformCommandHandlerGeneric extends BaseTerraformCommandHandler {
    constructor() {
        super();
        this.providerName = "generic";
    }

    public async handleBackend(terraformToolRunner: ToolRunner): Promise<void> {
        // Pass a backend config file if provided
        const configFile = tasks.getInput("backendConfigFile", false);
        if (configFile && configFile.trim()) {
            terraformToolRunner.arg(`-backend-config=${configFile.trim()}`);
        }

        // Parse key=value lines from backendConfigArgs (one per line, # comments ignored)
        const configArgs = tasks.getInput("backendConfigArgs", false);
        if (configArgs) {
            for (const line of configArgs.split('\n')) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) {
                    terraformToolRunner.arg(`-backend-config=${trimmed}`);
                }
            }
        }
    }

    public async handleProvider(command: TerraformAuthorizationCommandInitializer): Promise<void> {
        // No-op: generic backend handler has no provider credentials
    }
}
```

### New Handler: `TerraformCommandHandlerHCP`

Sets `TF_CLOUD_ORGANIZATION`, `TF_WORKSPACE`, and `TF_TOKEN_app_terraform_io` (from a task input or service connection).

```typescript
export class TerraformCommandHandlerHCP extends BaseTerraformCommandHandler {
    constructor() {
        super();
        this.providerName = "hcp";
    }

    public async handleBackend(terraformToolRunner: ToolRunner): Promise<void> {
        const token = tasks.getInput("backendHCPToken", true);
        EnvironmentVariableHelper.setEnvironmentVariable("TF_TOKEN_app_terraform_io", token);

        const organization = tasks.getInput("backendHCPOrganization", false);
        if (organization) {
            EnvironmentVariableHelper.setEnvironmentVariable("TF_CLOUD_ORGANIZATION", organization);
        }

        const workspace = tasks.getInput("backendHCPWorkspace", false);
        if (workspace) {
            EnvironmentVariableHelper.setEnvironmentVariable("TF_WORKSPACE", workspace);
        }
    }

    public async handleProvider(command: TerraformAuthorizationCommandInitializer): Promise<void> {
        // No-op: HCP backend handler has no provider credentials for plan/apply
    }
}
```

**Required task inputs for HCP backend:**

```json
{
  "name": "backendHCPToken",
  "type": "string",
  "label": "HCP Terraform token",
  "visibleRule": "backendType = hcp && command = init",
  "required": true,
  "helpMarkDown": "API token for HCP Terraform / Terraform Cloud. Generate at app.terraform.io → User Settings → Tokens."
},
{
  "name": "backendHCPOrganization",
  "type": "string",
  "label": "Organization name",
  "visibleRule": "backendType = hcp && command = init",
  "required": false,
  "helpMarkDown": "Optional. If not set, Terraform reads from the cloud{} block in your .tf files."
},
{
  "name": "backendHCPWorkspace",
  "type": "string",
  "label": "Workspace name",
  "visibleRule": "backendType = hcp && command = init",
  "required": false
}
```

### New Handler: `TerraformCommandHandlerLocal`

No-op for both `handleBackend()` and `handleProvider()`. Used when state is defined entirely in `.tf` files.

## Phase 2: AWS and GCP Workload Identity Federation

### How Azure DevOps WIF Works (existing pattern from AzureRM handler)

1. Call `generateIdToken(serviceConnectionID)` which POSTs to `${SYSTEM_OIDCREQUESTURI}?api-version=7.1&serviceConnectionId={id}` with Bearer token
2. Response contains an `oidcToken` (short-lived JWT signed by Azure DevOps)
3. JWT is set as an environment variable for the provider to consume

The same `id-token-generator.ts` function is reused for AWS and GCP.

### AWS WIF Support

**AWS SDK environment variables for OIDC:**

- `AWS_ROLE_ARN` — ARN of the IAM role to assume
- `AWS_WEB_IDENTITY_TOKEN_FILE` — path to a file containing the OIDC JWT
- `AWS_ROLE_SESSION_NAME` — session name (default: `AzureDevOps-Terraform`)
- `AWS_REGION` — AWS region

**AWS IAM setup (user performs once; see `docs/setup/aws-wif-setup.md`):**

1. Create IAM Identity Provider (OIDC type) with issuer `https://vstoken.dev.azure.com/<organization-id>`
2. Create IAM Role with trust policy referencing the identity provider
3. Attach needed policies to the role

**New task inputs for AWS WIF:**

```json
{
  "name": "environmentAuthSchemeAWS",
  "type": "pickList",
  "label": "Authentication scheme",
  "visibleRule": "provider = aws && command != init && command != validate",
  "defaultValue": "ServiceConnection",
  "options": {
    "ServiceConnection": "Service connection (static credentials)",
    "WorkloadIdentityFederation": "Workload Identity Federation (OIDC)"
  }
},
{
  "name": "awsRoleArn",
  "type": "string",
  "label": "IAM Role ARN",
  "visibleRule": "provider = aws && environmentAuthSchemeAWS = WorkloadIdentityFederation",
  "required": true,
  "helpMarkDown": "ARN of the IAM role to assume via OIDC. E.g. arn:aws:iam::123456789012:role/MyTerraformRole"
},
{
  "name": "awsRegion",
  "type": "string",
  "label": "AWS Region",
  "visibleRule": "provider = aws && environmentAuthSchemeAWS = WorkloadIdentityFederation",
  "required": true
},
{
  "name": "awsSessionName",
  "type": "string",
  "label": "Session name (optional)",
  "visibleRule": "provider = aws && environmentAuthSchemeAWS = WorkloadIdentityFederation",
  "required": false,
  "defaultValue": "AzureDevOps-Terraform"
}
```

**Changes to `aws-terraform-command-handler.ts`:**

```typescript
public async handleProvider(command: TerraformAuthorizationCommandInitializer): Promise<void> {
    const authScheme = tasks.getInput("environmentAuthSchemeAWS", false) || "ServiceConnection";

    if (authScheme === "WorkloadIdentityFederation") {
        await this.handleProviderWIF(command);
    } else {
        // Existing static credentials logic
        if (command.serviceProvidername) {
            process.env['AWS_ACCESS_KEY_ID'] = tasks.getEndpointAuthorizationParameter(command.serviceProvidername, 'username', false);
            process.env['AWS_SECRET_ACCESS_KEY'] = tasks.getEndpointAuthorizationParameter(command.serviceProvidername, 'password', false);
            process.env['AWS_DEFAULT_REGION'] = tasks.getEndpointDataParameter(command.serviceProvidername, 'region', false);
        }
    }
}

private async handleProviderWIF(command: TerraformAuthorizationCommandInitializer): Promise<void> {
    // Get OIDC token from Azure DevOps
    const oidcToken = await generateIdToken(command.serviceProvidername);
    tasks.setSecret(oidcToken); // mask in logs

    // Write token to temp file
    const tokenFilePath = path.resolve(`aws-oidc-token-${uuidV4()}.jwt`);
    tasks.writeFile(tokenFilePath, oidcToken);

    // Set AWS SDK environment variables
    EnvironmentVariableHelper.setEnvironmentVariable("AWS_ROLE_ARN", tasks.getInput("awsRoleArn", true));
    EnvironmentVariableHelper.setEnvironmentVariable("AWS_WEB_IDENTITY_TOKEN_FILE", tokenFilePath);
    EnvironmentVariableHelper.setEnvironmentVariable("AWS_REGION", tasks.getInput("awsRegion", true));
    const sessionName = tasks.getInput("awsSessionName") || "AzureDevOps-Terraform";
    EnvironmentVariableHelper.setEnvironmentVariable("AWS_ROLE_SESSION_NAME", sessionName);
}
```

### GCP WIF Support

The Terraform Google provider (v5.0+) accepts external account credentials via `GOOGLE_CREDENTIALS`.

**External account credentials JSON format:**

```json
{
  "type": "external_account",
  "audience": "//iam.googleapis.com/projects/{PROJECT_NUMBER}/locations/global/workloadIdentityPools/{POOL_ID}/providers/{PROVIDER_ID}",
  "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
  "token_url": "https://sts.googleapis.com/v1/token",
  "credential_source": {
    "file": "/path/to/oidc-token.jwt"
  },
  "service_account_impersonation_url": "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{SERVICE_ACCOUNT_EMAIL}:generateAccessToken"
}
```

**GCP setup (user performs once; see `docs/setup/gcp-wif-setup.md`):**

1. Create a Workload Identity Pool in GCP
2. Create a Provider in the pool (OIDC type, issuer `https://vstoken.dev.azure.com/<org-id>`)
3. Grant the pool ability to impersonate a service account
4. Collect: project number, pool ID, provider ID, service account email

**New task inputs for GCP WIF:**

```json
{
  "name": "environmentAuthSchemeGCP",
  "type": "pickList",
  "label": "Authentication scheme",
  "visibleRule": "provider = gcp && command != init && command != validate",
  "defaultValue": "ServiceConnection",
  "options": {
    "ServiceConnection": "Service connection (service account key)",
    "WorkloadIdentityFederation": "Workload Identity Federation (OIDC)"
  }
},
{
  "name": "gcpProjectNumber",
  "type": "string",
  "label": "GCP Project Number",
  "visibleRule": "provider = gcp && environmentAuthSchemeGCP = WorkloadIdentityFederation",
  "required": true,
  "helpMarkDown": "Numeric GCP project number (not project ID) where the Workload Identity Pool lives."
},
{
  "name": "gcpWorkloadIdentityPoolId",
  "type": "string",
  "label": "Workload Identity Pool ID",
  "visibleRule": "provider = gcp && environmentAuthSchemeGCP = WorkloadIdentityFederation",
  "required": true
},
{
  "name": "gcpWorkloadIdentityProviderId",
  "type": "string",
  "label": "Workload Identity Provider ID",
  "visibleRule": "provider = gcp && environmentAuthSchemeGCP = WorkloadIdentityFederation",
  "required": true
},
{
  "name": "gcpServiceAccountEmail",
  "type": "string",
  "label": "Service Account Email",
  "visibleRule": "provider = gcp && environmentAuthSchemeGCP = WorkloadIdentityFederation",
  "required": true,
  "helpMarkDown": "Email of the GCP service account to impersonate."
}
```

**Changes to `gcp-terraform-command-handler.ts`:**

```typescript
public async handleProvider(command: TerraformAuthorizationCommandInitializer): Promise<void> {
    const authScheme = tasks.getInput("environmentAuthSchemeGCP", false) || "ServiceConnection";

    if (authScheme === "WorkloadIdentityFederation") {
        await this.handleProviderWIF(command);
    } else {
        // Existing service account key logic
    }
}

private async handleProviderWIF(command: TerraformAuthorizationCommandInitializer): Promise<void> {
    // Get OIDC token from Azure DevOps
    const oidcToken = await generateIdToken(command.serviceProvidername);
    tasks.setSecret(oidcToken);

    // Write OIDC token to temp file
    const tokenFilePath = path.resolve(`gcp-oidc-token-${uuidV4()}.jwt`);
    tasks.writeFile(tokenFilePath, oidcToken);

    // Build external account credentials JSON
    const projectNumber = tasks.getInput("gcpProjectNumber", true);
    const poolId = tasks.getInput("gcpWorkloadIdentityPoolId", true);
    const providerId = tasks.getInput("gcpWorkloadIdentityProviderId", true);
    const serviceAccountEmail = tasks.getInput("gcpServiceAccountEmail", true);

    const credentials = {
        type: "external_account",
        audience: `//iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`,
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        token_url: "https://sts.googleapis.com/v1/token",
        credential_source: { file: tokenFilePath },
        service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccountEmail}:generateAccessToken`
    };

    const credentialsFilePath = path.resolve(`gcp-wif-credentials-${uuidV4()}.json`);
    tasks.writeFile(credentialsFilePath, JSON.stringify(credentials));

    EnvironmentVariableHelper.setEnvironmentVariable("GOOGLE_CREDENTIALS", credentialsFilePath);
    EnvironmentVariableHelper.setEnvironmentVariable("GOOGLE_PROJECT", projectNumber);
}
```

### `id-token-generator.ts` Extension

The existing function `generateIdToken(serviceConnectionID)` works for Azure service connections. For AWS/GCP WIF, the same function can be called with the AWS/GCP service connection ID. During implementation, verify:

- What audience the OIDC token carries when generated against an `AWSServiceEndpoint` or `GoogleCloudServiceEndpoint` service connection
- Whether a separate `generateIdTokenForPipeline()` variant is needed that uses `SystemVssConnection` as the service connection ID

Document the exact audience value in the respective setup guides so users configure their IAM/GCP trust policies correctly.

## Migration Notes

Existing pipeline configurations using `provider = azurerm` for both backend and provider continue to work because `backendType` defaults to `azurerm`. Users who previously relied on `provider = aws` to drive both S3 backend and AWS provider must now explicitly set `backendType = s3` in their init step configuration.

This warrants a changelog entry and a migration note in the README.
