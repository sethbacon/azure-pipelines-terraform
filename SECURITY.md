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

## Tool-cache integrity on persistent/self-hosted agents (installer tasks)

The tool cache used by TerraformInstaller, PolicyAgentInstaller, and TerraformDocsInstaller persists across jobs on self-hosted agents, so a binary cached by one job is served to every later job that requests the same tool/version. The installers close this cross-job trust gap in two layers:

1. **Local integrity marker.** After a checksum-verified download, the installer writes `.installer-verified.sha256` (the SHA256 of the verified executable) into the cached tool directory. Every later cache hit re-hashes the executable against the marker — a purely local, offline check — and **fails closed** on a mismatch (tampering or corruption since verification).
2. **Remote re-verification for unmarked entries.** A cache hit with **no** marker (cached by an older installer version, or by a job that ran with verification disabled) is re-downloaded through the same source/verification path a fresh install would use, and the cached executable must byte-match the freshly verified release. A mismatch or a signature/checksum verification failure **fails closed**; if the source is merely unreachable (offline/air-gapped agents), the install degrades to the cached tool with a warning so air-gapped cache reuse keeps working. On success the marker is written, so this download cost is paid once per unmarked cache entry. `requireChecksum: false` skips this re-verification entirely.

**Operator guidance:** do not mix `requireChecksum` (or `requireGpgSignature`/`requireCosignVerification`) values across jobs that share an agent's tool cache — a job that disables verification can seed the cache for jobs that require it, and while the re-verification above now catches this on network-connected agents, on air-gapped agents it degrades to a warning. To force a full re-verification of a suspect cache entry (e.g. after a mirror compromise is discovered), delete the tool's cached-version directory (or just its `.installer-verified.sha256` marker) under the agent's `_work/_tool` cache and re-run.

**Residual:** the marker lives in the same directory as the executable it protects, so an attacker with write access to the agent's tool cache can rewrite both the binary and the marker consistently (and such an attacker can equally tamper with the agent itself). The marker is defense-in-depth against corruption and verification-policy mixing across jobs, not a defense against a compromised agent account.

## Optional-feature residual risk: `runAzLogin` passes credentials on argv

The TerraformTask `runAzLogin` helper (opt-in, **default false**) invokes `az login` with the WIF federated token or service-principal secret on the command line, which is visible via `ps` / `/proc/<pid>/cmdline` to other processes on a shared agent — the Azure CLI offers no non-argv way to supply these. The primary provider-auth path never touches argv (credentials flow via environment variables). Scope `runAzLogin` to single-tenant / non-shared agents; leave it disabled otherwise.

## CI/CD residual risk: `npm audit` gate threshold and moderate/low-severity triage

Every task's job in `unit-test.yml` runs `npm audit --omit=dev --audit-level=high`, so a **moderate or low** severity advisory in a production dependency does not fail the PR/push build. This is intentional, not an oversight: moderate/low advisories in transitive dependencies are frequently not independently fixable by this repo (no patched version yet, or the fix is upstream of a pinned tool), and gating PRs on them would create chronic, unactionable red builds unrelated to the change under review.

**The moderate/low-severity gap is covered by the weekly OSV scan, not the PR gate.** `weekly-security.yml`'s `osv-scan` job runs `google/osv-scanner-action` with no severity filter — it reports vulnerabilities of every severity, including the moderate/low findings `npm audit --audit-level=high` intentionally passes over. That step is `continue-on-error: true` so a finding doesn't fail the scheduled run itself, but a failing scan still automatically files a tracked GitHub issue (the `Create issue on new vulnerabilities` step, labeled `security, dependencies`, linking back to the run) — this is the triage mechanism, run weekly rather than gating every PR.

## Optional-feature residual risk: PublishKbArticle's `force` input

`force` (opt-in, **default false**) only downgrades one heuristic in `html-validate.ts`'s `validateHtmlContent()` — a parsing-fidelity check (does the parsed output retain at least 50% of the input's length) that can have legitimate false positives on unusual-but-safe markdown-to-HTML output — from a hard failure to a warning. Every stored-XSS-relevant check in the same function (external/inline `<script>` elements, inline event-handler attributes, `<base>`/meta-refresh redirects, `javascript:`/`vbscript:`/non-image `data:` URIs, including control-character-obfuscated variants) always fails the task regardless of `force`. This was not always the case: prior to this fix, `force` disabled the entire validation gate, including the XSS-relevant checks — see the resolved history in CHANGELOG.md for the original stored-XSS finding.


## Structured plan/apply results residual risk: redaction depends on Terraform's own sensitivity marks

The `publishPlanSummary`/`publishApplyResults` structured results tab (`terraform-plan-summary`/`terraform-apply-summary` pipeline attachments, readable by anyone with build-read on the pipeline — a **wider** audience than the live job log, which the agent secret-masks but attachment files are not) redacts every value it publishes, but that redaction has three specific residual gaps documented here rather than silently assumed away:

1. **Provider-echoed secrets in diagnostics.** Apply diagnostics (`diagnostics[].summary`/`.detail`) are freeform strings a provider can construct from user or resource input, and there is no structured sensitivity mask for them. In production the task applies a best-effort format heuristic **only** — long base64/hex/high-entropy runs and PEM blocks are scrubbed (`src/results/secret-scrub.ts`). It does **not** currently feed its own `setSecret()`-registered values into this scrub: there is no general readback of every secret registered across the provider handlers, so the call site passes an empty known-secret list (`base-terraform-command-handler.ts`, `knownSecrets: []`) and the heuristic is the sole active control. A provider-authored message that embeds a **short** secret (below the high-entropy run length, not a PEM block) therefore appears verbatim. Two operator guardrails narrow this: `includeDiagnostics` (default `true`) omits the diagnostics block entirely when set to `false` (the outcome and per-resource status are still published, and the full error text remains in the agent-secret-masked live job log); and `includeDiagnosticDetail` (default `false`) keeps the longer, more leak-prone `detail` field opt-in so only the shorter `summary` is published by default.
2. **Redaction depends on Terraform correctly emitting `*_sensitive`/`sensitive_values` marks.** A provider that fails to mark a value `sensitive` in its own schema leaks it into the structured summary the same way it already leaks into `terraform show -json`/`terraform output -json` themselves — this is the same underlying limitation the existing `warnIfSensitiveOutputs()` detection and the `TF_OUT_*` pipeline-variable masking already carry (cross-reference #491). The redaction core does fail closed on an internal mask/value **shape mismatch** (mask says object, value is scalar, or vice versa — treated as sensitive rather than risk leaking), but a value the provider never marked sensitive at all presents no mismatch to detect.
3. **Attachments are readable by anyone with build-read; redaction is the only control.** Unlike the live job log, there is no agent-side secret masking layer over an attachment file — a redaction bug in `src/results/redact.ts` is a direct disclosure to that audience. This is why the redaction core carries the repo's highest test bar (the full sensitivity-source matrix, a golden-fixture no-leak tripwire that greps every serialized digest for the fixture's known-secret literals, and an adversarial security review of the full diff).

**Operator guardrails:** `failOnSensitiveOutputs` (existing `output`/`show` input, unrelated code path but the same underlying detection primitive) fails the task instead of only warning when a JSON output file would retain cleartext sensitive outputs; `includeDiagnostics` (default `true`) omits the freeform diagnostics block entirely when disabled; and `includeDiagnosticDetail` (default `false`, see above) keeps the more leak-prone diagnostic `detail` field opt-in. None of these inputs widen what the task publishes — they only narrow it further.

## Maintainer continuity

This project has a single maintainer (`@sethbacon`), who is also the sole GitHub CODEOWNERS reviewer and the VS Marketplace publisher account owner. There is currently no second maintainer or co-owner.

- **Vulnerability response:** private security advisories and reports (see [Reporting a Vulnerability](#reporting-a-vulnerability) above) route to this one account. If the maintainer is unavailable for an extended period, expect delayed acknowledgement/triage beyond the "few business days" target above — there is no secondary contact today.
- **Marketplace publisher recovery:** the extension is published under the `sethbacon` VS Marketplace publisher, authenticated via the GitHub OIDC → Microsoft Entra federated credential described in [CONTRIBUTING.md](CONTRIBUTING.md#release-process) (no stored long-lived publisher PAT). Recovery of publisher access, in the event the maintainer's GitHub or Microsoft account becomes inaccessible, would go through GitHub's and Microsoft's respective account-recovery/support channels — there is no pre-arranged secondary publisher account.
- **Mitigations already in place:** every change to `main` still goes through required CI (the full `unit-test.yml` matrix, CodeQL, zizmor) and required PR review, even though the same individual is the only possible reviewer; see the "Accepted Risk Register" and "Remaining Recommendations" sections of `CLAUDE.md` for the related branch-protection tradeoffs and the open recommendation to recruit a second, at least limited-scope, maintainer/codeowner.

## Preferred Languages

English preferred.
