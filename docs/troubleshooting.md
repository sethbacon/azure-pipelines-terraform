# Troubleshooting Guide

Common issues and their solutions when using Pipeline Tasks for Terraform.

---

## Authentication Errors

### Azure — "The access token is from the wrong issuer"

**Cause:** The service connection's tenant ID doesn't match the tenant of the target subscription.

**Fix:** Verify the service connection in Azure DevOps Project Settings > Service connections. Ensure the tenant ID matches the target Azure AD tenant.

### Azure — "AADSTS700024: Client assertion is not within its valid time range"

**Cause:** Clock skew between the Azure DevOps agent and Azure AD, or an expired OIDC token.

**Fix:**

- Ensure the agent host clock is synchronized (NTP).
- If using self-hosted agents, verify that the system clock drift is less than 5 minutes.

### AWS — "Not authorized to perform sts:AssumeRoleWithWebIdentity"

**Cause:** The IAM role trust policy does not permit the Azure DevOps OIDC issuer.

**Fix:** Review the trust policy on the IAM role. The `Condition` block must include the correct Azure DevOps issuer URL and service connection ID audience. See [AWS WIF Setup Guide](setup/aws-wif-setup.md).

### GCP — "Error getting access token: identity provider returned an error response"

**Cause:** The Workload Identity Pool/Provider configuration does not match the OIDC token claims.

**Fix:** Verify the `issuer`, `audience`, and `subject` in the Workload Identity Provider match the Azure DevOps pipeline OIDC token. See [GCP WIF Setup Guide](setup/gcp-wif-setup.md).

### "Unrecognized authorization scheme 'xxx'" (Azure)

**Cause:** The Azure service connection's authorization scheme does not map to one of the three supported values after case-insensitive comparison: `WorkloadIdentityFederation`, `ManagedServiceIdentity`, `ServicePrincipal`.

**Fix:**

- The AzureRM handler lowercases the incoming scheme before matching, so `serviceprincipal`, `ServicePrincipal`, and `SERVICEPRINCIPAL` all resolve the same way.
- If you see this error, the service connection was created with a scheme the task does not recognize (for example, a legacy certificate-based principal). Recreate the connection using one of the supported schemes from the Azure DevOps UI.
- **AWS / GCP schemes are case-sensitive**, unlike Azure. The `environmentAuthSchemeAWS` and `environmentAuthSchemeGCP` inputs must be exactly `WorkloadIdentityFederation` or `ServiceConnection` — `workloadidentityfederation` will silently fall through to the static-credentials path.

### AWS / GCP — WIF configured but task uses static credentials

**Cause:** `environmentAuthSchemeAWS` / `environmentAuthSchemeGCP` is set to something other than the exact string `WorkloadIdentityFederation` (typos, case variation, or inadvertently blank).

**Fix:**

- Check the YAML or classic-editor input for the exact value `WorkloadIdentityFederation`. The string comparison is case-sensitive and no partial matching is performed.
- Enable debug logging (`System.Debug: true`) and look for a `handleProvider` trace to confirm which code path executed.
- If the input is unset, the default is `ServiceConnection` (static credentials). Explicitly set the auth scheme input — it is not inherited from the service connection.

### OIDC federated-token acquisition — timeouts and retries

**Cause:** The pipeline agent could not reach `SYSTEM_OIDCREQUESTURI` (the Azure DevOps token exchange endpoint) within 30 seconds, or the upstream service returned a non-2xx response.

**Fix:**

- Each token request has a 30-second timeout. The task retries up to **3 times** with exponential backoff (200 ms, then 400 ms between attempts), so worst-case total delay is around **90 seconds** before the task fails.
- `Timed out acquiring federated token` indicates the HTTPS call itself did not return — check agent network connectivity to the Azure DevOps API, proxy configuration, and firewall rules.
- `Failed to acquire federated token: HTTP 4xx/5xx` indicates a server-side response — check that the service connection ID is still valid and that the pipeline identity is allowed to use it.
- `SYSTEM_OIDCREQUESTURI is not set` means the pipeline is running on an agent or in a context that does not expose the OIDC request endpoint. Only **yaml pipelines on Microsoft-hosted agents (and properly configured self-hosted agents)** receive this variable.

### OCI — "Error: Failed to parse private key"

**Cause:** The OCI service connection private key is malformed or not in PEM format.

**Fix:** Ensure the private key in your OCI service connection is in PKCS#8 PEM format (begins with `-----BEGIN PRIVATE KEY-----`). RSA and EC keys are supported.

---

## Terraform Errors

### "Error: No configuration files found in directory"

**Cause:** The `Configuration directory` input points to a directory that has no `.tf` files.

**Fix:** Verify the `workingDirectory` input. The default is `$(System.DefaultWorkingDirectory)`, which is the root of the checked-out repository. You may need to specify a subdirectory (e.g., `$(System.DefaultWorkingDirectory)/infra`).

### "Error acquiring the state lock"

**Cause:** Another Terraform process holds the state lock. This often happens when a previous pipeline run was cancelled or failed without releasing the lock.

**Fix:**

1. Identify the lock ID from the error message.
2. Use the `force-unlock` command with the lock ID:

   ```yaml
   - task: PipelineTerraformTask@5
     inputs:
       provider: azurerm
       command: forceunlock
       lockId: "<lock-id-from-error>"
   ```

3. **Caution:** Only use force-unlock when you are certain no other process is actively modifying state.

### "Error: Failed to load state: ... 403 Forbidden"

**Cause:** The service connection does not have permission to access the state backend storage.

**Fix:**

- **Azure:** Ensure the service principal has `Storage Blob Data Contributor` role on the storage account.
- **AWS:** Ensure the IAM role/user has `s3:GetObject`, `s3:PutObject`, `s3:ListBucket` on the S3 bucket.
- **GCP:** Ensure the service account has `roles/storage.objectAdmin` on the GCS bucket.

### "Error: Terraform 1.x.x does not support the -replace flag"

**Cause:** The `-replace` flag requires Terraform 1.0 or later.

**Fix:** Update the installer task to use a newer Terraform version:

```yaml
- task: PipelineTerraformInstaller@1
  inputs:
    terraformVersion: "1.9.0"
```

---

## Installer Errors

### "SHA256 checksum verification failed"

**Cause:** The downloaded Terraform binary does not match the expected checksum. This could indicate a corrupted download or a MITM attack.

**Fix:**

1. Retry the pipeline — transient network issues can corrupt downloads.
2. If using a custom mirror (`downloadSource: mirror`), verify the mirror serves correct SHA256SUMS files.
3. If the issue persists, check network proxy settings on the build agent.

### "Error: Unable to resolve version 'latest'"

**Cause:** The HashiCorp checkpoint API (`checkpoint-api.hashicorp.com`) is unreachable from the build agent.

**Fix:**

- Check agent network connectivity and proxy configuration.
- Pin a specific version instead of using `latest`.
- Use an internal registry (`downloadSource: registry`) or mirror (`downloadSource: mirror`).

---

## Pipeline Configuration

### "Some settings need attention" warning on the task

**Cause:** Required inputs are not filled in. The Azure DevOps UI shows an orange warning badge.

**Fix:** Click on the task in the pipeline editor and fill in all required fields. Common missing fields:

- `provider` — select azurerm, aws, gcp, or oci
- `command` — select the Terraform command to run
- Service connection — required for auth

### Backend/provider decoupling — "Unknown backend/provider type"

**Cause:** The `backendType` input has an unrecognized value.

**Fix:** Valid `backendType` values are: `azurerm`, `s3`, `gcs`, `oci`, `hcp`, `generic`, `local`. If you don't set `backendType`, it defaults to the `provider` value.

### Multiple provider blocks warning

**Cause:** The task runs `terraform providers` after `handleProvider` and greps the output for names of _other_ cloud providers the extension supports. When a match is found, it emits a non-fatal warning so the pipeline author is aware that credentials for only the selected provider have been configured.

**When to ignore:**

- You are intentionally composing multiple providers (e.g. deploying to AWS while reading an AzureRM data source for cross-cloud references).
- Only the selected provider's credentials are needed at runtime — Terraform will only authenticate against providers actually instantiated.

**When to investigate:**

- You did not expect to see a second provider — look for transitive module dependencies with stray provider blocks.
- The warning names a provider whose binary has not been resolved — `terraform init` will fail.

**Known false positive:** the current detection uses a substring match. Modules with names like `my-aws-helpers` or `terraform-azurerm-utils` can trip the warning even when no second cloud provider is actually configured. A stricter regex-anchored check is planned (roadmap item P3.7). Suppress by renaming the offending module or ignoring the warning.

---

## Agent Compatibility

### "Unable to locate executable file: 'terraform'"

**Cause:** Terraform is not installed on the build agent, or not in PATH.

**Fix:** Add the `PipelineTerraformInstaller@1` task before the `PipelineTerraformTask@5` task:

```yaml
- task: PipelineTerraformInstaller@1
  inputs:
    terraformVersion: "1.9.0"
- task: PipelineTerraformTask@5
  inputs:
    provider: azurerm
    command: init
```

### Self-hosted agent — proxy issues

**Cause:** The agent is behind a proxy and Terraform cannot reach the provider APIs.

**Fix:** Set the `HTTP_PROXY` and `HTTPS_PROXY` environment variables on the agent, or configure them in the pipeline:

```yaml
variables:
  HTTP_PROXY: http://proxy.example.com:8080
  HTTPS_PROXY: http://proxy.example.com:8080
  NO_PROXY: ".local,169.254.169.254"
```
