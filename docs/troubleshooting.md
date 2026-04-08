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

**Cause:** The task detected multiple cloud provider blocks (e.g., both `aws` and `azurerm`) in your Terraform configuration.

**Fix:** This is a warning, not an error. If you intentionally use multiple providers, this warning is expected. If not, review your `.tf` files and remove unused provider blocks.

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
