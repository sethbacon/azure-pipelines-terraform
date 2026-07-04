# Security

This is a community fork of [microsoft/azure-pipelines-terraform](https://github.com/microsoft/azure-pipelines-terraform). It is not affiliated with or supported by Microsoft. Security issues should be reported to the maintainers of this repository, not to the Microsoft Security Response Center.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Use [GitHub's private vulnerability reporting](https://github.com/sethbacon/azure-pipelines-terraform/security/advisories/new) instead. This keeps the report confidential until a fix is available.

When reporting, please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce or proof-of-concept code if available
- The affected version(s) or commit range
- Any suggested mitigations you are aware of

You can expect an acknowledgement within a few business days. Fixes will be released as patch versions and documented in [CHANGELOG.md](CHANGELOG.md).

## Supported Versions

Only the latest published release receives security fixes. If you are running an older version, please upgrade before reporting.

## Release pipeline residual risk: Entra token visible via process arguments

The `publish-marketplace` job in `release.yml` mints a Microsoft Entra access token, scoped only to the Azure DevOps resource app, and passes it to `tfx extension publish --token "$ENTRA_TOKEN"` to authenticate the Marketplace publish. The token is registered with `::add-mask::` so it never appears in the GitHub Actions log, but it is still visible in `/proc/<pid>/cmdline` for the lifetime of the `tfx` process — GitHub Actions runners do not hide process arguments from other processes in the same job. This was not fixed in code because `tfx-cli` 0.23.2 (the currently pinned version) has no non-argv way to supply `--token`: no token-file option and no interactive stdin prompt.

**Mitigated by a 10-minute token lifetime.** A Microsoft Graph `tokenLifetimePolicy` (`AccessTokenLifetime: 00:10:00`, the platform minimum) is assigned to the `tsm-azdo-marketplace-publisher` service principal — shared with the `azure-pipelines-packer` extension's identical publish flow — capping the token well below the platform default of ~60-90 minutes. The `tfx extension publish` step completes in seconds, so this costs nothing operationally while sharply narrowing the window in which an exfiltrated token would still be valid.

**Also mitigated by dependency-script isolation.** The `sbom-and-sign` and `publish-marketplace` jobs run `npm ci --ignore-scripts`, denying a compromised transitive dependency (e.g. one accepted via a routine version bump) a foothold to go looking for the token in the first place.

If a future `tfx-cli` release adds a non-argv token option, this job should switch to it.

## Preferred Languages

English preferred.
