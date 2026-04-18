# Initiative 4: Workload Identity Federation for OCI

## Goal

Add Workload Identity Federation (OIDC) support to the OCI provider handler so that static
API key credentials are no longer required in pipeline service connections. This mirrors the
WIF support added for AWS and GCP in Initiative 3.

## Implementation Status

**Status: COMPLETED** — OCI WIF support shipped in v1.0.0 (2026-04-17). This document is retained for reference.

## Current State (historical)

The `TerraformCommandHandlerOCI` handler currently authenticates using an API key stored in
an `PTTOCIServiceEndpoint` service connection (user OCID + tenancy OCID + private key +
fingerprint + region). These long-lived credentials must be rotated manually and stored in ADO as secrets.

## Why OCI WIF Is More Complex Than AWS/GCP

### The UPST Problem

AWS and GCP use standard OAuth 2.0 OIDC token exchange: an external JWT is directly exchanged
for short-lived cloud credentials via their respective STS/token endpoints. The Terraform
provider for each cloud then reads those credentials from environment variables.

OCI's equivalent is a **User Principal Security Token (UPST)**: a session token issued by the
OCI Token Exchange API after validating an external OIDC JWT. However:

1. The OCI Terraform provider (`hashicorp/oci`) does not natively accept a UPST via environment
   variable. Its documented auth methods are: API key, instance principal, resource principal,
   and OCI CLI config file.
2. OCI CLI stores UPST credentials in `~/.oci/sessions/<profile>/` and references them via a
   profile in `~/.oci/config`. This is not a simple env-var injection.
3. The `OCI_CLI_SECURITY_TOKEN_FILE` environment variable is accepted by OCI CLI but not directly
   by the Terraform provider's Go SDK initialization.

### Potential Paths Forward

| Approach                                                                | Feasibility | Notes                                                                                                                                             |
| ----------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| OCI Token Exchange API → UPST → OCI CLI session profile → Terraform     | Medium      | Requires writing config files to disk, not just env vars. Brittle.                                                                                |
| OCI Token Exchange API → UPST → `security_token_file` in provider block | Medium      | OCI TF provider *may* accept `security_token_file` in the `provider "oci"` block via `auth = "SecurityToken"`. Needs testing.                     |
| OCI Resource Principal / Dynamic Groups                                 | Low         | Only works if the ADO agent runs on OCI compute. Not applicable to hosted agents.                                                                 |
| OCI API Key via dynamic secrets (Vault)                                 | Low         | Not a WIF approach; just moves the secret rotation problem.                                                                                       |
| OCI Workload Identity with direct JWT auth                              | Unknown     | OCI IAM supports OIDC federation for service resources. Whether the Terraform provider can accept a raw OCI OIDC-validated token is undocumented. |

## Research Questions

The following must be answered by reading OCI and Terraform provider documentation and
testing against a real OCI tenancy before implementation begins.

### 1. OCI IAM OIDC Federation Setup

- Does OCI IAM support configuring Azure DevOps (`vstoken.dev.azure.com/<org-id>`) as an
  external OIDC identity provider?
- What is the exact token exchange endpoint? (Expected:
  `https://auth.ap-sydney-1.oraclecloud.com/v1/authentication/authenticateClient` or similar
  per-region endpoint)
- What request format does the OCI Token Exchange API require? (JWT in Authorization header?
  In body as `assertion`?)
- What is the audience claim that OCI validates against the external JWT?
- What subject claim format does OCI use for trust policy conditions?

**Reference endpoints to investigate:**

- OCI SDK source: `github.com/oracle/oci-go-sdk` — `common/auth/` package, token exchange flow
- OCI documentation: "Using Token Authentication" in Identity and Access Management

### 2. OCI Terraform Provider `SecurityToken` Auth Mode

The OCI Terraform provider supports an `auth` attribute in the provider block:

```hcl
provider "oci" {
  auth             = "SecurityToken"
  config_file_profile = "my-profile"
}
```

This reads a session token from the OCI CLI config file at the specified profile path.

**Questions:**

- Can `config_file_profile` be overridden via environment variable (`TF_VAR_` or provider env vars)?
- Does the OCI provider respect `OCI_CLI_PROFILE` or equivalent env var?
- Is `security_token_file` accepted directly in the provider block without a full OCI config file?
- What exact file format does the OCI CLI session profile require? Can we write a minimal
  synthetic profile from a UPST without running `oci session authenticate`?

**Reference:** `github.com/hashicorp/terraform-provider-oci` — `oci/internal/client/` — auth configuration parsing

### 3. Environment Variable Support

The OCI Terraform provider reads several env vars:

| Env Var                                     | Purpose                               |
| ------------------------------------------- | ------------------------------------- |
| `OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING` | Suppress config file warnings         |
| `TF_VAR_tenancy_ocid`                       | Tenancy OCID (via Terraform variable) |
| `OCI_CONFIG_FILE`                           | Path to OCI config file               |
| `OCI_CONFIG_PROFILE`                        | Profile name within the config file   |

**Questions:**

- Does setting `OCI_CONFIG_FILE` to a synthetically generated file containing a `[DEFAULT]`
  profile with `security_token_file=<path>` and `auth=SecurityToken` work?
- Is `fingerprint` still required in the config file when using token auth?
- What minimal fields are required in the synthetic OCI config file?

### 4. UPST File Format

A UPST is a base64-encoded token returned from the OCI token exchange. The OCI CLI session
profile directory contains:

```txt
~/.oci/sessions/<profile>/
    oci_api_key.pem         # ephemeral private key
    oci_api_key_public.pem  # corresponding public key
    token                   # the UPST value
```

**Questions:**

- Is an ephemeral key pair required alongside the UPST, or can the UPST be used standalone?
- Does the OCI Terraform provider require a private key even in `SecurityToken` auth mode?
- If yes, must the ephemeral key pair be generated client-side before calling the token
  exchange API?

### 5. Token Exchange Flow (Proposed)

If the above questions resolve favourably, the proposed flow would be:

```txt
1. Generate ephemeral RSA key pair (in-memory, Node.js crypto module)
2. POST ephemeral public key + ADO OIDC JWT to OCI Token Exchange API
   → Receive UPST
3. Write synthetic OCI config to temp file:
   [DEFAULT]
   tenancy = <tenancy-ocid>
   region = <region>
   key_file = <path-to-ephemeral-private-key.pem>
   fingerprint = <fingerprint-of-ephemeral-key>
   security_token_file = <path-to-upst-file>
4. Set OCI_CONFIG_FILE=<path-to-config>
5. Terraform init/plan/apply reads OCI config → authenticates with UPST
```

This is significantly more complex than AWS/GCP WIF and requires:

- Client-side RSA key generation (available via Node.js `crypto` module)
- Knowledge of the OCI token exchange API request format
- Writing 3-4 files to disk (config, private key, public key, UPST)

## Implementation Scope (if research validates feasibility)

### New Task Inputs

```json
{
  "name": "environmentAuthSchemeOCI",
  "type": "pickList",
  "label": "Authentication scheme",
  "defaultValue": "ServiceConnection",
  "visibleRule": "provider = oci && command != init && command != validate && command != workspace && command != state && command != fmt && command != get",
  "options": {
    "ServiceConnection": "Service connection (API key)",
    "WorkloadIdentityFederation": "Workload Identity Federation (OIDC)"
  }
},
{
  "name": "ociTenancyOcid",
  "type": "string",
  "label": "Tenancy OCID",
  "visibleRule": "provider = oci && environmentAuthSchemeOCI = WorkloadIdentityFederation && ...",
  "required": true
},
{
  "name": "ociRegion",
  "type": "string",
  "label": "OCI Region",
  "visibleRule": "provider = oci && environmentAuthSchemeOCI = WorkloadIdentityFederation && ...",
  "required": true
}
```

### New Handler Method

`TerraformCommandHandlerOCI.handleProviderWIF(command)`:

1. Call `generateIdToken(command.serviceProvidername)` to get ADO OIDC JWT
2. Generate ephemeral RSA-2048 key pair
3. POST to OCI Token Exchange API with JWT + public key
4. Write synthetic OCI config file, private key file, UPST file to temp dir
5. Set `OCI_CONFIG_FILE` environment variable
6. Clean up temp files after Terraform exits (best effort)

### Files to Modify

| File                               | Change                                               |
| ---------------------------------- | ---------------------------------------------------- |
| `task.json`                        | Add `environmentAuthSchemeOCI` + WIF inputs          |
| `oci-terraform-command-handler.ts` | Add `handleProviderWIF()`, update `handleProvider()` |
| `docs/setup/oci-wif-setup.md`      | New — OCI IAM OIDC provider setup guide              |

## Recommended Research Steps Before Coding

1. **Read OCI SDK Go source** for the token exchange flow in `github.com/oracle/oci-go-sdk`
   (specifically `common/auth/federation_client.go` or similar)
2. **Read Terraform OCI provider source** for SecurityToken auth mode parsing
   (`github.com/hashicorp/terraform-provider-oci`)
3. **Test manually** using `oci session authenticate` in a sandbox tenancy to understand the
   exact file format the provider expects
4. **Prototype the token exchange** using `curl` or a small Node.js script against a real OCI
   tenancy with Azure DevOps as the OIDC provider
5. **Only then** design the final implementation

## Dependency

- Requires an OCI sandbox tenancy with IAM federation configured
- Research can be done against the user's existing OCI tenancy (`OCI_TENANCY_OCID` in
  `vg-terraform-test-oci`)
- Should be tracked as a GitHub issue before any code is written

## Estimated Complexity

**High.** This is 2-3× more complex than AWS/GCP WIF due to the ephemeral key pair requirement,
multi-file OCI config, and the unknown behaviour of the Terraform provider in SecurityToken mode.
Research must come first — do not start coding before the token exchange flow is validated end-to-end.
