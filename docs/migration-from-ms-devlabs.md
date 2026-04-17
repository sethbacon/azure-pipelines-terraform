# Migrating from `ms-devlabs.custom-terraform-tasks`

This guide walks through moving an existing pipeline from Microsoft DevLabs'
`ms-devlabs.custom-terraform-tasks` extension to
`sethbacon.pipeline-tasks-terraform`.

The two extensions are designed to coexist — distinct extension IDs and
distinct service connection type names — so you can install both and migrate
pipelines incrementally without a big-bang cutover.

---

## Install side-by-side

Keep the DevLabs extension installed while you migrate:

1. Marketplace → install **Pipeline Tasks for Terraform** (`sethbacon.pipeline-tasks-terraform`).
2. Both extensions will appear in the task picker. The tasks in this fork all
   start with `Pipeline` (`PipelineTerraformInstaller`, `PipelineTerraformTask`)
   so they're easy to tell apart in YAML and the classic editor.
3. Migrate pipelines one at a time; uninstall DevLabs once nothing references it.

---

## YAML task renames

Rename the task identifiers. Inputs are mostly compatible — a few renames are
called out in the [Input renames](#input-renames) section below.

| Old (DevLabs)         | New (this fork)                 |
| --------------------- | ------------------------------- |
| `TerraformInstaller@0` | `PipelineTerraformInstaller@1` |
| `TerraformCLI@0`       | `PipelineTerraformTask@5`      |
| `TerraformTaskV4@4`    | `PipelineTerraformTask@5`      |

### Example — installer

```yaml
# Before
- task: TerraformInstaller@0
  inputs:
    terraformVersion: "1.9.0"

# After
- task: PipelineTerraformInstaller@1
  inputs:
    terraformVersion: "1.9.0"
```

### Example — `plan` against Azure

```yaml
# Before
- task: TerraformTaskV4@4
  inputs:
    provider: azurerm
    command: plan
    environmentServiceNameAzureRM: my-azure-connection

# After
- task: PipelineTerraformTask@5
  inputs:
    provider: azurerm
    command: plan
    environmentServiceNameAzureRM: my-azure-connection
```

---

## Service connection type renames

The DevLabs extension registered non-Azure service connection types with
generic names. This fork uses `PTT`-prefixed names so both extensions can
coexist without ID collisions.

| Provider | DevLabs type                   | This fork type                    |
| -------- | ------------------------------ | --------------------------------- |
| AWS      | `AWSServiceEndpoint`           | `PTTAWSServiceEndpoint`           |
| GCP      | `GoogleCloudServiceEndpoint`   | `PTTGoogleCloudServiceEndpoint`   |
| OCI      | `OCIServiceEndpoint`           | `PTTOCIServiceEndpoint`           |

Azure auth uses the built-in **Azure Resource Manager** service connection and
is unchanged.

**What this means for you:** existing AWS/GCP/OCI service connections created
against the DevLabs extension cannot be reused by this fork. Create a new
connection of the `PTT*` type. The credential material (access keys, WIF
config, OCI private key) can be copy-pasted — only the type name changes.

Steps in the Azure DevOps UI:

1. Project Settings → **Service connections** → **New service connection**.
2. Search for "Pipeline AWS for Terraform" (or GCP / OCI).
3. Fill in the same credentials you used for the DevLabs connection.
4. Reference the new connection by name in the `environmentServiceNameAWS` /
   `environmentServiceNameGCP` / `environmentServiceNameOCI` input.

---

## Input renames

Most inputs carry over verbatim. Known differences:

| DevLabs input             | This fork                                | Notes                                                                                      |
| ------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `allowTelemetryCollection` | _removed_                               | No telemetry is collected in this fork.                                                    |
| `runAzLogin`              | _removed_                                | The AzureRM handler always authenticates via the service connection without `az login`.   |
| `commandOptions`           | `commandOptions`                         | Unchanged.                                                                                 |
| `secureVarsFile`           | `secureVarsFile`                         | Unchanged. Secure Files library reference.                                                 |

### New inputs introduced by this fork

- **`backendType`** on `init` — decouples the state backend from the provider.
  Values: `azurerm`, `s3`, `gcs`, `oci`, `hcp`, `generic`, `local`. Defaults to
  the value of `provider` if unset.
- **`replaceAddress`** on `plan` / `apply` — passes `-replace=ADDRESS`.
- **`downloadSource`** on the installer — `hashicorp` (default), `registry`
  (private terraform-registry-backend), or `mirror` (custom HTTPS mirror).
- **`environmentAuthSchemeAWS`** / **`environmentAuthSchemeGCP`** — `ServiceConnection`
  (default) or `WorkloadIdentityFederation`. WIF avoids static credentials.
- **Additional commands not in DevLabs:** `workspace`, `state`, `fmt`, `test`,
  `get`, `refresh`, `import`, `forceunlock`.

---

## Terraform Plan attachment compatibility

This fork's **Terraform Plan tab** reads pipeline attachments named
`terraform-plan-results`, compatible with the
[jason-johnson/azure-pipelines-tasks-terraform](https://github.com/jason-johnson/azure-pipelines-tasks-terraform)
attachment convention. If you were using that extension's tab, this fork's tab
will pick up the same attachments with no YAML change.

The DevLabs extension did not publish plan attachments, so no migration step is
needed for that case — enable `publishPlanResults: true` on the `plan` step to
start surfacing plans in the tab.

---

## Validation checklist

Before decommissioning the DevLabs extension:

- [ ] All pipelines reference `Pipeline*` task names, no `TerraformInstaller@0`
      or `TerraformTaskV4@4` left (grep the repo).
- [ ] New `PTT*` service connections exist and pipelines reference them.
- [ ] A test pipeline runs `init` + `plan` end-to-end against a non-production
      workspace on each provider you use.
- [ ] State backends are unchanged — this migration does not touch state files
      or backend config.
- [ ] Uninstall `ms-devlabs.custom-terraform-tasks` from the organization.

---

## Related docs

- [README.md](../README.md) — extension overview, supported commands, providers
- [AWS WIF Setup Guide](setup/aws-wif-setup.md)
- [GCP WIF Setup Guide](setup/gcp-wif-setup.md)
- [Troubleshooting Guide](troubleshooting.md)
