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

### Cross-cloud state backend — "unable to build authorizer" / "Please run 'az login'" / "NoCredentialProviders" on `plan`/`apply`

**Cause:** `init` succeeded (it uses `backendType` to pick the right backend handler), but a later state-accessing command — `plan`, `apply`, `destroy`, `refresh`, `import`, `output`, `state`, `workspace`, or `forceunlock` — is missing the backend's credential inputs. This is the classic symptom when the state backend is on a *different* cloud than `provider` (e.g. an `azurerm` backend with `provider: aws`): the step only had AWS credentials, so the azurerm backend had no way to authenticate.

**Fix:** Add the backend's inputs to **every** state-accessing step, not just `init` — `backendServiceArm`/`backendAzureRm*` for azurerm, `backendServiceAWS`/`backendAWS*` for s3, `backendServiceGCP`/`backendGCP*` for gcs, or `backendHCP*` for HCP Terraform. See [Cross-cloud state backends](yaml-examples.md#cross-cloud-state-backends) for full examples of every combination.

Since this fix, a step missing the required backend inputs fails immediately with an actionable error (naming the detected backend, the provider, and the command) instead of the opaque authorizer/login error above — if you still see the opaque error, you're on an older task version; update to the latest `PipelineTerraformTask@5`.

**Note on `local-exec`/`external` data sources:** when using Workload Identity Federation for the azurerm backend/provider with `runAzLogin: true`, the ADO pipeline OIDC access token (`ARM_OIDC_REQUEST_TOKEN`) is present in the process environment for the whole Terraform run and is therefore inherited by any `local-exec` provisioner or `external` data source. Avoid combining `runAzLogin` with untrusted modules on shared agents.

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

## Policy tasks

### "Policy agent executable not found" / engine not on PATH

Add the `PipelinePolicyAgentInstaller@1` task before `PipelineTerraformPolicyCheck@1`,
or set the check task's `policyAgentPath` to the binary explicitly.

### OPA: no violations reported when you expect some

- Confirm `decisionPath` matches your package/rule (e.g. `terraform/deny` →
  `package terraform` + `deny` rule). The check evaluates `data.<decisionPath>`.
- Confirm your rule reads the plan from `input` (the raw `terraform show -json`
  document), not from a wrapper object.
- For a boolean `allow`-style rule, set `failMode: defined` instead of the
  default `nonEmpty`.

### OPA: "Failed to parse 'opa exec' output as JSON"

The task expects machine-readable `opa exec` output. Ensure the installed binary
is OPA (not the legacy `conftest`) and that policies compile — a Rego compile
error surfaces here.

### Sentinel: policies pass locally but the task reports failure (or vice versa)

The standalone `sentinel` CLI returns exit 0 = pass, 1 = fail, 2 = undefined
(treated as fail), 3 = runtime error. Enforcement levels (`advisory`,
`soft-mandatory`, `hard-mandatory`) are applied by this task, not by the CLI, so
an advisory failure still exits 1 from Sentinel but the task succeeds with a
warning. A result of 2 (undefined) usually means a policy's `main` rule was not
satisfied by the data — check the static import name (`sentinelImportName`)
matches the `import` statement in your policy.

### Sentinel: policies written for HCP Terraform don't work

This task wires the **raw** `terraform show -json` document as the static import.
HCP Terraform exposes a different `tfplan/v2` mock schema. Adapt the import paths
in your policies, or supply your own `sentinelConfigPath` with matching mock data.

### Private policy repo clone fails (gitUrl source)

- The URL must be HTTPS. Provide `policyRepoToken` (a pipeline secret variable)
  for private repos; it is injected via a per-invocation `GIT_CONFIG` environment
  variable (never on the command line) and masked in logs.
- When pinning a commit, use the full 40-character SHA — short SHAs are treated
  as branch/tag names and shallow-cloned.

## terraform-docs

### "Unable to locate executable file: 'terraform-docs'"

**Cause:** terraform-docs is not installed on the agent, or not on `PATH`.

**Fix:** Add `PipelineTerraformDocsInstaller@1` before `PipelineTerraformDocs@1`:

```yaml
- task: PipelineTerraformDocsInstaller@1
  inputs:
    version: 'latest'
- task: PipelineTerraformDocs@1
  inputs:
    formatter: 'markdown-table'
    modulePath: '$(System.DefaultWorkingDirectory)/modules/vpc'
    outputFile: 'README.md'
```

### The task fails with a non-zero exit code when `outputCheck` is enabled

**Cause:** This is by design — `outputCheck: true` makes terraform-docs fail when
the output file is out of date, i.e. the committed documentation does not match
what terraform-docs would generate.

**Fix:** Regenerate the docs locally and commit the result, then re-run:

```bash
terraform-docs markdown table --output-file README.md --output-mode inject ./modules/vpc
```

Drop `outputCheck` (or set it `false`) if you want the task to write the file
in-pipeline instead of gating on it.

### Injected content does not appear in README.md

**Cause:** `outputMode: inject` (the default) only updates content between the
terraform-docs marker comments; if they are missing, nothing is inserted.

**Fix:** Add the markers where the table should go, or use `outputMode: replace`
to overwrite the whole file:

```markdown
<!-- BEGIN_TF_DOCS -->
<!-- END_TF_DOCS -->
```

### Empty output for a directory

**Cause:** `modulePath` points at a directory with no `.tf` files (terraform-docs
ignores directories without Terraform configuration).

**Fix:** Point `modulePath` at the module directory containing the `.tf` files,
or enable `recursive` to walk submodules under `recursivePath`.

## Documentation publishing (Markdown2Html / PublishKbArticle)

### Markdown2Html: content is stripped from the generated HTML

**Cause:** The converter sanitizes the rendered HTML — inline `<script>`, `on*=`
event-handler attributes, and `javascript:`/`vbscript:`/non-image `data:` URIs are
removed as stored-XSS vectors before the HTML reaches the KB pipeline.

**Fix:** This is by design. Only static formatting HTML (tables, `<br>`, code blocks,
images) survives sanitization; move any dynamic behavior out of the document.

### Markdown2Html: "include path is outside the base directory"

**Cause:** A front-matter `includes:` entry (or an `<img src>`) resolves outside the
primary document's directory / `imageBaseDir`. Path traversal is blocked by design.

**Fix:** Keep includes and images within the document's directory (or the configured
base dir) and use relative paths that stay inside it.

### PublishKbArticle: OAuth token acquisition fails / 401

**Cause:** Wrong `instance`, or invalid OAuth client credentials / Basic auth.

**Fix:** `instance` must match `^[a-z0-9-]+$` — the subdomain only (e.g. `acme` for
`acme.service-now.com`), not a full URL. Supply `clientId`/`clientSecret` for OAuth or
`username`/`password` for Basic; the secret and the resulting token are masked in logs.

### PublishKbArticle: HTML rejected before publish

**Cause:** `html-validate` fail-closes on inline `<script>`, `on*` handlers, and
`javascript:`/`vbscript:`/non-image `data:` URIs.

**Fix:** Clean the source (preferred). `force: true` downgrades the rejection to a
warning — use only for trusted content.

### PublishKbArticle: a duplicate draft article appears on re-run

**Cause:** An earlier run failed during the image-upload phase. (Current versions
persist the article's `sys_id` before uploading images, so this no longer happens.)

**Fix:** Update to the latest `PipelinePublishKbArticle@1`, and provide a stable
`sourceKey` (front-matter `wiki-source`) so re-runs update the same article instead of
creating a new one.
