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

## Supply-chain residual risk: same-origin checksum trust for OPA and terraform-docs

The terraform (TerraformInstaller) and Sentinel (PolicyAgentInstaller) download paths verify a GPG-signed `SHA256SUMS` manifest against HashiCorp's pinned public key, and the OpenTofu path uses cosign keyless verification with an anchored certificate identity. **OPA and terraform-docs, however, publish no detached GPG/cosign signature** — only a per-release `.sha256`/`.sha256sum` file served from the same GitHub release as the binary. The installers verify that checksum (fail-closed by default via `requireChecksum`), which guarantees transport integrity but **not authenticity against a poisoned release**: an attacker who compromised the upstream release (or the account/CI publishing it) would control both the binary and its checksum. This is an accepted residual driven by upstream tooling, not a defect in this extension; it will be revisited if OPA/terraform-docs publish signed checksums or GitHub-native build-provenance attestations a CI verifier can anchor to.

## Optional-feature residual risk: `runAzLogin` passes credentials on argv

The TerraformTask `runAzLogin` helper (opt-in, **default false**) invokes `az login` with the WIF federated token or service-principal secret on the command line, which is visible via `ps` / `/proc/<pid>/cmdline` to other processes on a shared agent — the Azure CLI offers no non-argv way to supply these. The primary provider-auth path never touches argv (credentials flow via environment variables). Scope `runAzLogin` to single-tenant / non-shared agents; leave it disabled otherwise.

## CI/CD residual risk: `npm audit` gate threshold and moderate/low-severity triage

Every task's job in `unit-test.yml` runs `npm audit --omit=dev --audit-level=high`, so a **moderate or low** severity advisory in a production dependency does not fail the PR/push build. This is intentional, not an oversight: moderate/low advisories in transitive dependencies are frequently not independently fixable by this repo (no patched version yet, or the fix is upstream of a pinned tool), and gating PRs on them would create chronic, unactionable red builds unrelated to the change under review.

**The moderate/low-severity gap is covered by the weekly OSV scan, not the PR gate.** `weekly-security.yml`'s `osv-scan` job runs `google/osv-scanner-action` with no severity filter — it reports vulnerabilities of every severity, including the moderate/low findings `npm audit --audit-level=high` intentionally passes over. That step is `continue-on-error: true` so a finding doesn't fail the scheduled run itself, but a failing scan still automatically files a tracked GitHub issue (the `Create issue on new vulnerabilities` step, labeled `security, dependencies`, linking back to the run) — this is the triage mechanism, run weekly rather than gating every PR.

## Optional-feature residual risk: PublishKbArticle's `force` input

`force` (opt-in, **default false**) only downgrades one heuristic in `html-validate.ts`'s `validateHtmlContent()` — a parsing-fidelity check (does the parsed output retain at least 50% of the input's length) that can have legitimate false positives on unusual-but-safe markdown-to-HTML output — from a hard failure to a warning. Every stored-XSS-relevant check in the same function (external/inline `<script>` elements, inline event-handler attributes, `<base>`/meta-refresh redirects, `javascript:`/`vbscript:`/non-image `data:` URIs, including control-character-obfuscated variants) always fails the task regardless of `force`. This was not always the case: prior to this fix, `force` disabled the entire validation gate, including the XSS-relevant checks — see the resolved history in CHANGELOG.md for the original stored-XSS finding.


## Maintainer continuity

This project has a single maintainer (`@sethbacon`), who is also the sole GitHub CODEOWNERS reviewer and the VS Marketplace publisher account owner. There is currently no second maintainer or co-owner.

- **Vulnerability response:** private security advisories and reports (see [Reporting a Vulnerability](#reporting-a-vulnerability) above) route to this one account. If the maintainer is unavailable for an extended period, expect delayed acknowledgement/triage beyond the "few business days" target above — there is no secondary contact today.
- **Marketplace publisher recovery:** the extension is published under the `sethbacon` VS Marketplace publisher, authenticated via the GitHub OIDC → Microsoft Entra federated credential described in [CONTRIBUTING.md](CONTRIBUTING.md#release-process) (no stored long-lived publisher PAT). Recovery of publisher access, in the event the maintainer's GitHub or Microsoft account becomes inaccessible, would go through GitHub's and Microsoft's respective account-recovery/support channels — there is no pre-arranged secondary publisher account.
- **Mitigations already in place:** every change to `main` still goes through required CI (the full `unit-test.yml` matrix, CodeQL, zizmor) and required PR review, even though the same individual is the only possible reviewer; see the "Accepted Risk Register" and "Remaining Recommendations" sections of `CLAUDE.md` for the related branch-protection tradeoffs and the open recommendation to recruit a second, at least limited-scope, maintainer/codeowner.

## Preferred Languages

English preferred.
