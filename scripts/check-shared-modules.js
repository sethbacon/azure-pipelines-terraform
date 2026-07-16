#!/usr/bin/env node
// Enforces a single effective source of truth for the security-critical modules
// that are intentionally duplicated across tasks. Each "family" lists a set of
// task src dirs that must carry byte-identical copies of the named modules, so a
// fix (e.g. the 2030 GPG key rotation, or the credential-bearing https-pin guard)
// can never be applied to one copy and silently missed in the other. CI fails on
// any divergence.

const fs = require('fs');
const path = require('path');

// Each family: the first dir is the canonical source; every other dir's copy of
// each listed module must match it exactly.
const FAMILIES = [
    {
        // Installer download trust chain: embedded HashiCorp GPG key, the signature
        // verifier, and the raw HTTP client shared by the two installer tasks.
        dirs: [
            'Tasks/TerraformInstaller/TerraformInstallerV1/src',
            'Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src',
        ],
        modules: [
            'hashicorp-gpg-key.ts',
            'gpg-verifier.ts',
            'http-client.ts',
        ],
    },
    {
        // Credential-bearing HTTPS transport (https-pin guard + socket timeout +
        // body truncation) shared by the registry module publish (API key) and the
        // drift callback (TSM token).
        dirs: [
            'Tasks/TerraformModulePublish/TerraformModulePublishV1/src',
            'Tasks/TerraformDriftReport/TerraformDriftReportV1/src',
        ],
        modules: [
            'https-client.ts',
        ],
    },
    {
        // The terraform-docs installer downloads sha256-verified archives from
        // GitHub releases (no GPG/cosign signature), so it shares only the
        // HTTPS-pinned fetch client with the other installers — not the GPG key or
        // verifier. Keep this copy byte-identical with the canonical installer.
        dirs: [
            'Tasks/TerraformInstaller/TerraformInstallerV1/src',
            'Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src',
        ],
        modules: [
            'http-client.ts',
        ],
    },
    {
        // Verification-failure classification (cache-hit re-verification): typed
        // marker distinguishing "material failed verification" (fail closed) from
        // "material unavailable" (degrade gracefully to the cached tool). A drift
        // here could silently reclassify a bad signature as a mere availability
        // warning, so keep it byte-identical across the three installer tasks.
        dirs: [
            'Tasks/TerraformInstaller/TerraformInstallerV1/src',
            'Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src',
            'Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src',
        ],
        modules: [
            'verification-failure.ts',
        ],
    },
    {
        // Registry download-host allowlist (SSRF-relevant): shared across all three
        // installer tasks that accept a registryAllowedHosts input.
        dirs: [
            'Tasks/TerraformInstaller/TerraformInstallerV1/src',
            'Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src',
            'Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src',
        ],
        modules: [
            'registry-allowlist.ts',
        ],
    },
    {
        // Fail-closed boolean-input helper: requireGpgSignature / requireChecksum /
        // requireCosignVerification default to TRUE even on agents that do not
        // materialize task.json defaultValues. A drift here could silently flip a
        // verification default to fail-open, so keep it byte-identical across the
        // three installer tasks.
        dirs: [
            'Tasks/TerraformInstaller/TerraformInstallerV1/src',
            'Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src',
            'Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src',
        ],
        modules: [
            'bool-input.ts',
        ],
    },
    {
        // Registry-download credential masking: extracts and setSecret()s any
        // pre-signed-URL query-string token before download, and scrubs the raw
        // URL/tokens out of a download failure message. A drift here previously let
        // two of the three installers leak a live storage credential to the build
        // log (2026-07 re-audit, finding "registry pre-signed URL token leak") while
        // the third had already fixed it — keep byte-identical across all three.
        dirs: [
            'Tasks/TerraformInstaller/TerraformInstallerV1/src',
            'Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src',
            'Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src',
        ],
        modules: [
            'url-secret-redaction.ts',
        ],
    },
    {
        // URI-scheme validation shared by the two independent HTML sanitizer/gate
        // layers guarding the ServiceNow KB-publishing pipeline: Markdown2Html's
        // render-time sanitizeRenderedHtml() and PublishKbArticle's downstream
        // fail-closed validateHtmlContent(). Previously each task carried its own
        // drifting copy of this logic, which is exactly how the control-character
        // scheme bypass (#446) evaded both layers at once — keep byte-identical.
        dirs: [
            'Tasks/Markdown2Html/Markdown2HtmlV1/src',
            'Tasks/PublishKbArticle/PublishKbArticleV1/src',
        ],
        modules: [
            'uri-scheme-guard.ts',
        ],
    },
    {
        // Frozen plan/apply digest CONTRACT shared between the task that PRODUCES
        // the redacted digest (src/results/) and the build-results tab that
        // CONSUMES it (src/tab/). digest-schema.ts is the versioned TypeScript
        // shape; caps.ts is the single source of the §6 size/DoS limits. A drift
        // between producer and consumer here would silently break redaction/size
        // guarantees or the render contract, so keep byte-identical (design
        // decision D4). NOTE: unlike the installer families above, the second dir
        // is the repo-root tab source (not under Tasks/), so the self-test
        // (scripts/test-check-shared-modules.js) copies src/ as well as Tasks/.
        dirs: [
            'Tasks/TerraformTask/TerraformTaskV5/src/results',
            'src/tab',
        ],
        modules: [
            'digest-schema.ts',
            'caps.ts',
        ],
        // NOTE: redact.ts (the recursive redaction core) is NOT listed here. It
        // has only one copy — Tasks/TerraformTask/TerraformTaskV5/src/results/
        // redact.ts — since only the task PRODUCES a digest; the tab CONSUMES an
        // already-redacted one and never re-implements redaction. There is
        // nothing to byte-compare it against, so it is deliberately excluded
        // from this family rather than silently forgotten (design §9/§5.2.6).
        // If a redact.ts (or equivalent) copy is ever bundled into src/tab/, add
        // it to `modules` above in the same commit.
        //
        // Phase 5 (destroy/state): state-digest.ts is the same single-copy
        // pattern as redact.ts — only the task produces a StateDigest, so it is
        // also NOT listed here. The StateDigest TYPE and the state caps
        // (MAX_STATE_RESOURCES / MAX_STATE_ATTRS_PER_RESOURCE) landed as
        // additive members of the EXISTING digest-schema.ts / caps.ts files
        // above, so this family already covers them; destroy needed no schema
        // change at all (it reuses PlanDigest via the optional `planMode`
        // field). No new family was needed for Phase 5.
    },
];

// These two families are deliberately NOT merged into one shared client, even
// though both enforce an https-only guard: they sit on different transport
// primitives (fetch+AbortController vs raw https.request+req.setTimeout) and
// different trust models (the installer family downloads public release
// artifacts and sends no credential; the second family attaches a bearer
// token/API key to every request). Each family is independently guarded
// end-to-end by this script, which is the property that actually matters;
// collapsing them into a single abstraction would be a large, risky rewrite
// of working transport code for no behavior change.
//
// A THIRD credential-bearing transport exists outside this script's FAMILIES:
// Tasks/PublishKbArticle/PublishKbArticleV1/src/servicenow-http.ts. It is not
// listed above because it has only one copy (nothing to byte-compare), but it
// intentionally mirrors the same hardening as the family above — an https-only
// guard, a DEFAULT_REQUEST_TIMEOUT_MS socket timeout, and the same 10MB
// MAX_RESPONSE_BYTES response cap (see truncate()/truncateBody()). It stays a
// separate module rather than reusing https-client.ts because its call sites
// need JSON-body encoding, query-string params, and axios-like non-2xx
// rejection that the module-publish/drift-report clients don't. This comment
// is the tracking mechanism for it: a future hardening change to the timeout,
// response cap, or https-only guard in https-client.ts should be evaluated for
// servicenow-http.ts too, even though CI cannot enforce byte-identity here.

// Normalize line endings so a CRLF checkout never reads as drift; the bytes that
// matter (the key material, the verification logic) are still compared exactly.
function read(relDir, file) {
    const full = path.resolve(relDir, file);
    if (!fs.existsSync(full)) {
        return { ok: false, full };
    }
    return { ok: true, full, content: fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n') };
}

let hasError = false;

for (const { dirs, modules } of FAMILIES) {
    const [canonicalDir, ...otherDirs] = dirs;
    for (const file of modules) {
        const base = read(canonicalDir, file);
        if (!base.ok) {
            console.error(`FAIL: canonical copy missing: ${path.join(canonicalDir, file)}`);
            hasError = true;
            continue;
        }
        for (const dir of otherDirs) {
            const other = read(dir, file);
            if (!other.ok) {
                console.error(`FAIL: copy missing: ${path.join(dir, file)}`);
                hasError = true;
                continue;
            }
            if (other.content !== base.content) {
                console.error(`FAIL: ${file} diverged between ${canonicalDir} and ${dir}`);
                console.error(`      reconcile both copies (canonical: ${base.full})`);
                hasError = true;
            } else {
                console.log(`OK: ${file} identical (${canonicalDir} == ${dir})`);
            }
        }
    }
}

if (hasError) {
    process.exit(1);
}
console.log('All shared-module parity checks passed.');
