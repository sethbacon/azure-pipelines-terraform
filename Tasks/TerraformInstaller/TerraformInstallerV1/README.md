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

### cosign for OpenTofu signature verification

OpenTofu downloads from the GitHub release, or from a `downloadSource=mirror`, are verified with [cosign](https://github.com/sigstore/cosign) (`requireCosignVerification`, default `true`). `downloadSource=registry` has no cosign step: a registry stores a version's `SHA256SUMS` and one detached signature, not a cosign certificate. When the registry advertises that signature (terraform-registry-backend stores the `.gpgsig` OpenTofu publishes beside each `SHA256SUMS`), the task verifies it under the OpenTofu release key embedded in the task (`src/opentofu-gpg-key.ts`, fingerprint `E3E6E43D84CB852EADB0051D0C0AF313E5FD9F80`) and takes the checksum from that verified `SHA256SUMS` rather than from the registry's own `sha256` field. A signature that does not verify under OpenTofu's key fails the install, including one a mirror made under its own custom key, and a signature made by HashiCorp's key is never accepted for OpenTofu (or the reverse). `requireGpgSignature` (default `true`) also fails the install when an advertised signature cannot be fetched. When the registry advertises no signature, or `requireGpgSignature` is `false` and the advertised signature is absent, the install is checksum-only: the registry's SHA256 is the only check, and the task logs a warning. On the release and mirror paths cosign is OpenTofu's *only* authenticity anchor, so the task treats the verifier as an artifact it must verify like any other.

**`cosignSource: managed` (default).** The task downloads the pinned sigstore/cosign release asset for the agent's platform from `github.com`, checks it against a SHA256 shipped inside the task (`src/cosign-pins.ts`), caches it in the agent tool cache with an integrity marker, and runs only that copy. The agent's `PATH` is never consulted, so a step or a concurrent job that can write a `PATH` directory cannot shadow `cosign` with a stub that exits 0. A digest mismatch deletes the download and fails the task; a download failure while `requireCosignVerification` is `true` fails the task as well — it never falls back to an unverified binary. No agent preparation is required, and nothing needs to be installed on the image.

**`cosignSource: ambient`.** The historical behaviour, kept for image-baked and air-gapped agents that provision cosign themselves: the task resolves `cosign` from `PATH`. That binary is not integrity-verified by anything, so the task emits a build warning on every unpinned run. If you use this mode, install cosign from a trusted, pinned source — for example the [sigstore/cosign-installer](https://github.com/sigstore/cosign-installer) action pinned to a full commit SHA (as this repository's weekly canary does) — and set `cosignSha256` to that binary's exact digest so a substitution fails the install.

In both modes the resolved path and the binary's actual SHA256 are logged, so exactly which verifier was trusted is auditable after the fact.

The pin is not fire-and-forget: the `cosign pin freshness` job in `.github/workflows/weekly-security.yml` fails weekly once the pinned release falls more than two minor releases or 120 days behind current, and independently re-fetches the pinned release's `cosign_checksums.txt` to confirm every shipped digest still matches upstream.

### Outbound network destinations

With the default settings the installer task reaches only these hosts (an air-gapped or proxy-restricted agent needs them allowed, or needs the corresponding feature turned off):

| Host                            | When                                                                                     | Why                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `releases.hashicorp.com`        | `binary=terraform`, `downloadSource=hashicorp`                                           | Terraform release archive, `SHA256SUMS` and its GPG `.sig`                           |
| `checkpoint-api.hashicorp.com`  | `binary=terraform`, `terraformVersion=latest` and `downloadSource=hashicorp` or `mirror` | `latest` version resolution                                                          |
| `github.com`                    | `binary=tofu`, `downloadSource=hashicorp`                                                | OpenTofu release archive, `SHA256SUMS`, `.sig` and `.pem`                            |
| `github.com`                    | `binary=tofu`, `downloadSource=hashicorp` or `mirror`, and `cosignSource=managed`        | the pinned `sigstore/cosign` release asset                                           |
| `api.github.com`                | `binary=tofu`, `terraformVersion=latest` and `downloadSource=hashicorp` or `mirror`      | `latest` version resolution                                                          |
| `objects.githubusercontent.com` | any `github.com` download                                                                | GitHub's release-asset CDN, which `github.com` redirects to                          |
| the host you configure          | `downloadSource=registry` / `mirror`                                                     | your registry or mirror (`registryAllowedHosts` / `mirrorAllowedHosts` constrain it) |

Setting `cosignSource: ambient` removes the cosign asset download; it does not remove `github.com` for `downloadSource=hashicorp`, where the OpenTofu release itself comes from. With `downloadSource=mirror` or `registry` and a pinned `terraformVersion`, the OpenTofu archive and its checksums come only from the host you configure; the one remaining `github.com` request is the managed cosign asset, which `downloadSource=registry` never fetches.

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
