# Terraform tool installer


### Overview

The Terraform Tool Installer task acquires a specified version of [Terraform](https://www.terraform.io/) from the Internet or the tools cache and prepends it to the PATH of the Azure Pipelines Agent (hosted or private). Use this task to change the version of Terraform used in subsequent tasks like [Terraform](https://aka.ms/AAf0uqr).
Adding this task before the [Terraform task](https://aka.ms/AAf0uqr) in a build definition ensures you are using that task with the right Terraform version.


### Contact Information

Please report a problem at [GitHub Issues](https://github.com/sethbacon/azure-pipelines-terraform/issues) if you are facing problems in making this task work. You can also share feedback about the task like, what more functionality should be added to the task, what other tasks you would like to have, at the same place.


### Pre-requisites for the task

The task can run on the following build agent operating systems:
- Windows
- MacOS
- Linux

**Terraform is already installed on hosted Ubuntu build agents.** So, this task may be omitted for these agents unless a different version of Terraform is needed.

### Parameters of the task

* **Display name\*:** Provide a name to identify the task among others in your pipeline.

* **Version\*:** Specify the keyword 'latest' to get the latest released version or specify exact version of Terraform to install.  
Example: 
    To install latest Terraform version use keyword: latest.  To install specific version Ex. 1.0.8, use 1.0.8.
For getting more details about exact version, refer [this link](https://releases.hashicorp.com/terraform/)


### Tool cache integrity on self-hosted agents

On persistent (self-hosted) agents the tool cache outlives the job that populated it, so a Terraform/OpenTofu version cached by an earlier job is reused by later jobs. The installer verifies cached tools rather than trusting them unconditionally:

* After a checksum-verified download, a local integrity marker (`.installer-verified.sha256`) is written into the cached tool directory. Every later cache hit re-hashes the executable against that marker (offline, no network) and fails if the cached copy changed since it was verified.
* A cache hit **without** a marker (cached by an older installer version, or by a job that ran with verification disabled) is re-verified remotely when `requireChecksum` is enabled (the default): the release is re-downloaded through the configured source with the normal signature/checksum verification, and the cached executable must match it. On a mismatch — or if the source serves material that fails verification — the task fails. If the source is simply unreachable (offline/air-gapped agents), the task warns and proceeds with the cached tool, so air-gapped cache reuse keeps working. After a successful re-verification the marker is written, so the extra download happens once per cache entry.

**Do not mix `requireChecksum` values across jobs that share an agent's tool cache** — a job with verification disabled can seed the cache for jobs that require it. Set `requireChecksum: false` only when you deliberately accept unverified tools (it also skips the cache re-verification). To force a fresh, fully verified download, clear the agent's tool cache directory for that version.

Note: the marker sits next to the executable it protects; it defends against corruption and mixed verification settings, not against an attacker who already has write access to the agent's tool cache.

### Output Variables

* **Terraform location:** This variable can be used to refer to the location of the terraform binary that was installed on the agent in subsequent tasks.

### Example Task Usage
Below is a basic example usage of a few commands within the TerraformInstaller task.

```yaml
- task: TerraformInstaller@1
  displayName: Install Terraform 1.5.7
  inputs:
    terraformVersion: 1.5.7
```
