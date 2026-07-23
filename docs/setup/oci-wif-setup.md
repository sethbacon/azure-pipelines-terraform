# OCI Workload Identity Federation Setup

This guide covers the one-time OCI configuration needed to use Workload Identity Federation (OIDC) with the **Pipeline Tasks for Terraform** extension.

WIF eliminates the need to store a static OCI API signing key in Azure DevOps. Instead, the pipeline requests a short-lived OIDC token from Azure DevOps, exchanges it with OCI Identity Domains for a temporary User Principal Session Token (UPST) bound to an ephemeral, per-run RSA key pair, and Terraform authenticates with that UPST for the duration of the job.

This flow is more involved to set up than the [AWS](aws-wif-setup.md) and [GCP](gcp-wif-setup.md) equivalents — it configures OCI's federated JWT-to-UPST token exchange (an Identity Domains feature, mostly configured via REST/CLI rather than the Console) rather than a simpler provider/pool object. See Oracle's own [Token Exchange Grant Type: Exchanging a JSON Web Token for a UPST](https://docs.oracle.com/en-us/iaas/Content/Identity/api-getstarted/json_web_token_exchange.htm) guide for the authoritative reference on every field used below.

## Prerequisites

- An OCI tenancy with an Identity Domain (the tenancy's default domain works) and Identity Domain Administrator access
- Ability to call the Identity Domain's admin API (`IdentityPropagationTrusts`) — via `curl`/REST or the `oci iam domains` / `oci identity-domains` CLI commands. Most of this setup is not yet exposed as a stable Console click-path
- IAM permissions to create a group and write a policy in the target compartment
- Your Azure DevOps organization ID (found in `https://dev.azure.com/{org}/_settings/organizationAad`)

## Step 1: Create an Identity Domain application for token exchange

1. In the OCI Console, go to **Identity & Security** → **Domains** → select your domain → **Applications** → **Add application**
2. Choose **Confidential Application**, give it a name (e.g. `azure-devops-terraform-token-exchange`), and do **not** grant it any app roles — it is not itself the identity that ends up in the UPST, it only identifies which trust configuration a token-exchange request is allowed to use
3. Activate the application and note its **Client ID** — this is the value you will enter as the task's `ociWifClientId` input

The extension's token-exchange request (`exchangeOidcForUpst()`) sends only this `client_id`, never a client secret — the Azure DevOps-signed OIDC JWT (`subject_token`) is the credential OCI actually verifies against the trust configuration in Step 3, not the application itself.

## Step 2: Create (or choose) the OCI identity the federated token maps to

Create a dedicated, non-interactive **service user** for the pipeline rather than mapping to a real person's account:

```bash
curl -X POST "https://<identity-domain-admin-url>/admin/v1/Users" \
  -H "Authorization: Bearer <IDA-scoped access token>" \
  -H "Content-Type: application/json" \
  -d '{
    "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
    "urn:ietf:params:scim:schemas:oracle:idcs:extension:user:User": {
      "serviceUser": true
    },
    "userName": "svc-azdo-terraform"
  }'
```

A service user cannot sign in interactively or hold API keys/passwords — it exists only to be a policy-attachable principal. Add it to an IAM group (e.g. `TerraformCIDeployers`) that your policy in Step 4 will target.

## Step 3: Configure the Identity Propagation Trust

Create a `JWT`-type Identity Propagation Trust that tells OCI how to validate the Azure DevOps OIDC token and which OCI identity to issue the UPST for:

```bash
curl -X POST "https://<identity-domain-admin-url>/admin/v1/IdentityPropagationTrusts" \
  -H "Authorization: Bearer <IDA-scoped access token>" \
  -H "Content-Type: application/json" \
  -d '{
    "schemas": ["urn:ietf:params:scim:schemas:oracle:idcs:IdentityPropagationTrust"],
    "name": "azure-devops-terraform",
    "active": true,
    "type": "JWT",
    "issuer": "https://vstoken.dev.azure.com/<your-azure-devops-organization-id>",
    "publicKeyEndpoint": "https://vstoken.dev.azure.com/<your-azure-devops-organization-id>/.well-known/openid-configuration",
    "oauthClients": ["<client-id-from-step-1>"],
    "subjectClaimName": "sub",
    "allowImpersonation": true,
    "impersonationServiceUsers": [
      { "rule": "sub eq *", "value": "<service-user-id-from-step-2>" }
    ],
    "clientClaimName": "aud",
    "clientClaimValues": ["api://AzureADTokenV2"]
  }'
```

Replace `<your-azure-devops-organization-id>` with your org's GUID (not the org name) and the placeholder IDs with the values from Steps 1–2.

## Step 4: Write an IAM policy for the mapped identity

Grant the group from Step 2 whatever access your Terraform configuration needs, scoped to the narrowest compartment that works — e.g.:

```text
Allow group TerraformCIDeployers to manage all-resources in compartment my-terraform-compartment
```

Prefer resource-type-specific verbs/compartments over `manage all-resources` at the tenancy root wherever your configuration allows it.

## Step 5: Configure the Pipeline Task

```yaml
- task: PipelineTerraformTask@5
  inputs:
    provider: 'oci'
    command: 'plan'
    environmentServiceNameOCI: 'my-oci-service-connection'
    environmentAuthSchemeOCI: 'WorkloadIdentityFederation'
    ociWifTenancyOcid: 'ocid1.tenancy.oc1..aaaaaaaa...'
    ociWifRegion: 'us-ashburn-1'
    ociWifIdentityDomainUrl: 'https://idcs-abc123.identity.oraclecloud.com'
    ociWifClientId: '<client-id-from-step-1>'
    workingDirectory: '$(System.DefaultWorkingDirectory)/terraform'
```

`environmentServiceNameOCI` still points at a `PTTOCIServiceEndpoint` service connection — WIF mode uses it only to request the Azure DevOps OIDC token (via the connection's federated-identity capability), not for any static credential it may also carry.

## How It Works

At runtime (`oci-terraform-command-handler.ts` / `oci-token-exchange.ts`), the task:

1. Requests an OIDC token from Azure DevOps for the service connection (signed by `vstoken.dev.azure.com`, default `api://AzureADTokenV2` audience — the same token-issuance path used for AWS/GCP/AzureRM WIF)
2. Generates an ephemeral RSA-2048 key pair in memory, unique to this task run
3. POSTs the OIDC JWT, the `ociWifClientId`, and the ephemeral public key to `{ociWifIdentityDomainUrl}/oauth2/v1/token` (RFC 8693 token exchange). The destination host is validated against OCI's known Identity Domains realms (`*.identity.oraclecloud.com`, `*.identity.oraclegovcloud.com`, `*.identity.oraclegovcloud.uk`, `*.identity.oraclecloud.eu`) before the JWT is ever sent, and the request refuses to follow any redirect
4. OCI validates the JWT against the Identity Propagation Trust from Step 3, checks the `clientClaimName`/`clientClaimValues` condition, maps it to the service user, and returns a UPST bound (proof-of-possession) to the ephemeral public key
5. The task writes the UPST, the ephemeral private key, and a synthetic OCI config file (`OCI_CLI_AUTH=security_token`) to per-run temp files, and sets `OCI_CLI_CONFIG_FILE`/`OCI_CLI_PROFILE`/`TF_VAR_tenancy_ocid`/`TF_VAR_region` for the Terraform OCI provider to pick up
6. Runs `terraform plan` (or apply/destroy) — the OCI provider authenticates using the security-token profile
7. All WIF temp files (UPST, ephemeral private key, config) are removed at the end of the task, alongside the other tracked temp files

The UPST and the tenancy's normal session-token lifetime apply — there is no static long-lived credential to rotate or leak.

> **Audience scoping:** the OIDC token minted for OCI carries the same default `api://AzureADTokenV2` audience used for every cloud in this extension — the task does not set a per-cloud custom audience or TTL, and cannot: the Azure DevOps OIDC request API does not expose per-exchange audience selection. It is the Identity Propagation Trust's `issuer`, `clientClaimName`/`clientClaimValues`, and `subjectClaimName` conditions (Step 3) that form the actual security boundary. Scope `clientClaimValues` to your audience and, where possible, add a `sub`-based condition restricting the trust to this specific service connection's `sc://<org>/<project>/<service-connection>` subject, mirroring the AWS/GCP guides' `sub` trust-policy condition — otherwise any service connection in the organization that can request an OIDC token could exchange it through this trust. This is an operator responsibility, not something the task enforces on your behalf.

## Troubleshooting

### "OCI token exchange failed: HTTP 400"

- Verify the Identity Propagation Trust's `issuer` exactly matches `https://vstoken.dev.azure.com/<org-id>` (the GUID, not the org name)
- Verify `oauthClients` includes the exact Client ID from Step 1

### "OCI identity domain URL host '...' is not an OCI Identity Domains endpoint"

- `ociWifIdentityDomainUrl` must be an `https://` URL under `*.identity.oraclecloud.com` (or the government/EU realm equivalents) — this is validated before any token is sent

### "OCI token exchange endpoint returned a redirect"

- The task refuses to follow redirects on the token-exchange call. Double-check `ociWifIdentityDomainUrl` points directly at the Identity Domain's base URL, not a login/vanity URL that redirects there

### Token exchange succeeds but Terraform still fails to authenticate

- Confirm the group from Step 2/4 has a policy grant covering the resources your configuration touches
- Confirm `ociWifTenancyOcid` and `ociWifRegion` match the tenancy/region the Identity Domain and policy live in
