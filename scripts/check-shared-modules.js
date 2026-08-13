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
        // Windows-DACL-aware secure-temp-file writer (owner-only 0600 + O_EXCL on
        // Unix, an explicit restrictive icacls DACL on Windows, both fail closed).
        // Canonical source: TerraformTaskV5, where it guards WIF/OCI secret files.
        // TerraformDriftReport writes plan-derived data (the TSM-callback summary
        // and the SARIF report), and TerraformPolicyCheck writes plan-derived data
        // too (raw engine output, JUnit failure detail, and the SARIF report) —
        // both deserve the same cross-platform guarantee, so each carries a
        // byte-identical copy rather than a re-implementation that could silently
        // drop the Windows DACL half (#607). TerraformProviderMirror writes the
        // credential-bearing .terraformrc (mirrorUrl may embed basic-auth
        // userinfo), so it joined this family too and uses replaceSecretFile for
        // that config file (#628).
        dirs: [
            'Tasks/TerraformTask/TerraformTaskV5/src',
            'Tasks/TerraformDriftReport/TerraformDriftReportV1/src',
            'Tasks/TerraformPolicyCheck/TerraformPolicyCheckV1/src',
            'Tasks/TerraformProviderMirror/TerraformProviderMirrorV1/src',
        ],
        modules: [
            'secure-temp.ts',
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
        // Private-registry 'latest' version resolution + operator-URL credential
        // masking helper, shared by all three installer tasks that support
        // downloadSource=registry. Previously hand-duplicated with a matching body
        // in each (issue #681, escaping the parity gate this family now closes) --
        // a fix to the registry-latest error message or masking order could land in
        // one copy and be silently missed in the others.
        dirs: [
            'Tasks/TerraformInstaller/TerraformInstallerV1/src',
            'Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src',
            'Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src',
        ],
        modules: [
            'registry-version-resolver.ts',
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
        // The allowlist HTML sanitizer itself (#820): before this, PublishKbArticle's
        // raw htmlFile input was only ever DENYLIST-validated (html-validate.ts) and
        // then published VERBATIM, so a bypass of that denylist reached ServiceNow's
        // stored-XSS sink unfiltered. Both the KB-publishing pipeline's independent
        // entry points — Markdown2Html's render-time convertMarkdownToHtml() and
        // PublishKbArticle's pre-publish sanitizeHtmlForPublish() — must apply the
        // SAME allowlist policy (including the #835 rel="noopener noreferrer"
        // forcing on <a target=…>), or a KB article published one way could carry
        // active content a KB article published the other way would have stripped.
        dirs: [
            'Tasks/Markdown2Html/Markdown2HtmlV1/src',
            'Tasks/PublishKbArticle/PublishKbArticleV1/src',
        ],
        modules: [
            'html-sanitizer.ts',
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
    {
        // Wall-clock deadline wrapper for a local subprocess (execWithTimeout +
        // the shared TOOL_EXEC_TIMEOUT_MS ceiling): a Promise.race deadline that
        // kills the child on timeout, generalizing policy-source.ts's git-clone
        // pattern for the policy-engine (opa/sentinel) and terraform-docs
        // invocations that previously had only an output-byte cap and no
        // wall-clock bound (#782). A drift here could silently drop the timeout in
        // one task while the other keeps failing fast, so keep byte-identical.
        dirs: [
            'Tasks/TerraformPolicyCheck/TerraformPolicyCheckV1/src',
            'Tasks/TerraformDocs/TerraformDocsV1/src',
        ],
        modules: [
            'exec-timeout.ts',
        ],
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
// Tasks/PublishKbArticle/PublishKbArticleV1/src/servicenow-http.ts. Its whole
// file is not a byte-for-byte copy, so it is not in FAMILIES above, but it
// intentionally mirrors the same hardening as the family above — an https-only
// guard, a DEFAULT_REQUEST_TIMEOUT_MS socket timeout, and the same 10MB
// MAX_RESPONSE_BYTES response cap (see truncate()/truncateBody()). It stays a
// separate module rather than reusing https-client.ts because its call sites
// need JSON-body encoding, query-string params, and axios-like non-2xx
// rejection that the module-publish/drift-report clients don't. Its two most
// hardening-sensitive shared pieces are gated automatically via the
// REGION_FAMILIES mechanism below: the CONNECT-tunneling ProxyTunnelAgent class
// (`#region shared:ProxyTunnelAgent`) and, as of #722, the request-timeout /
// response-cap constants (`#region shared:HttpHardeningConstants`) — both
// byte-compared against the two https-client.ts copies. Only the https-only
// guard itself remains a hand-tracked parallel: a future hardening change to
// it in https-client.ts should still be mirrored into servicenow-http.ts by
// hand.

// Region families: unlike FAMILIES (whole-file byte-identity), each entry names a
// marked region that must stay byte-identical across files that are otherwise NOT
// whole-file copies. A `// #region shared:<name>` ... `// #endregion shared:<name>`
// pair brackets the shared block in every listed file, and the text strictly
// between the markers is compared byte-for-byte (line endings normalized as
// below). This lets a complex class be duplicated verbatim into a file that has
// its own surrounding code and still be gated. Fail-closed: a missing, duplicated,
// or out-of-order marker in ANY listed file is a hard failure, so deleting a
// marker can never silently skip the check.
const REGION_FAMILIES = [
    {
        // The CONNECT-tunneling ProxyTunnelAgent, duplicated verbatim into the two
        // https-client.ts copies (already whole-file-gated as a FAMILY above) and
        // the ServiceNow transport servicenow-http.ts (not a whole-file copy).
        region: 'ProxyTunnelAgent',
        files: [
            'Tasks/TerraformModulePublish/TerraformModulePublishV1/src/https-client.ts',
            'Tasks/TerraformDriftReport/TerraformDriftReportV1/src/https-client.ts',
            'Tasks/PublishKbArticle/PublishKbArticleV1/src/servicenow-http.ts',
        ],
    },
    {
        // The per-request socket timeout and response-body byte cap, previously a
        // hand-tracked parallel outside any parity gate (#722) -- now byte-
        // compared the same way as ProxyTunnelAgent above.
        region: 'HttpHardeningConstants',
        files: [
            'Tasks/TerraformModulePublish/TerraformModulePublishV1/src/https-client.ts',
            'Tasks/TerraformDriftReport/TerraformDriftReportV1/src/https-client.ts',
            'Tasks/PublishKbArticle/PublishKbArticleV1/src/servicenow-http.ts',
        ],
    },
    {
        // truncateBody(): the last-line bound on how much of a remote response
        // body can be interpolated into a thrown error or a log line. Every
        // transport that surfaces a remote body in an error message carries it,
        // and until #407 each carried its OWN copy: the two https-client.ts
        // copies had a falsy guard, while TerraformTaskV5's oci-token-exchange.ts
        // and PublishKbArticleV1's servicenow-http.ts had independently written
        // variants without one (servicenow-http.ts even under a different name,
        // truncate()). Two of the four sat outside every parity mechanism, so a
        // tightening of the cap -- or a fix to the "does the marker itself leak
        // length" question -- could land in one transport and be missed in the
        // rest. All four are now byte-identical and gated here.
        //
        // A REGION family rather than a whole-file FAMILY because three of the
        // four host files are not copies of each other in any other respect;
        // this is the same reason ProxyTunnelAgent above is region-gated.
        region: 'TruncateBody',
        files: [
            'Tasks/TerraformModulePublish/TerraformModulePublishV1/src/https-client.ts',
            'Tasks/TerraformDriftReport/TerraformDriftReportV1/src/https-client.ts',
            'Tasks/PublishKbArticle/PublishKbArticleV1/src/servicenow-http.ts',
            'Tasks/TerraformTask/TerraformTaskV5/src/oci-token-exchange.ts',
        ],
    },
];

// Normalize line endings so a CRLF checkout never reads as drift; the bytes that
// matter (the key material, the verification logic) are still compared exactly.
function read(relDir, file) {
    const full = path.resolve(relDir, file);
    if (!fs.existsSync(full)) {
        return { ok: false, full };
    }
    return { ok: true, full, content: fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n') };
}

// Extract the text strictly between a region's `#region shared:<name>` and
// `#endregion shared:<name>` markers, normalizing CRLF exactly like read()
// above. A missing, duplicated, or out-of-order marker returns { ok: false } so
// the caller fails closed instead of comparing an empty or partial region.
function extractRegion(relPath, region) {
    const full = path.resolve(relPath);
    if (!fs.existsSync(full)) {
        return { ok: false, full, reason: `file missing: ${relPath}` };
    }
    const lines = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n').split('\n');
    // Match the actual `// #region ...` line-comment markers, not prose that
    // merely mentions the region name (e.g. a backticked reference in a header
    // comment), so a doc mention can never be miscounted as a marker.
    const openToken = `// #region shared:${region}`;
    const closeToken = `// #endregion shared:${region}`;
    const opens = [];
    const closes = [];
    lines.forEach((line, i) => {
        const trimmed = line.trimStart();
        if (trimmed.startsWith(openToken)) opens.push(i);
        if (trimmed.startsWith(closeToken)) closes.push(i);
    });
    if (opens.length !== 1 || closes.length !== 1) {
        return {
            ok: false,
            full,
            reason: `expected exactly one '${openToken}' and one '${closeToken}' marker in ${relPath} (found ${opens.length} open, ${closes.length} close)`,
        };
    }
    if (closes[0] <= opens[0]) {
        return { ok: false, full, reason: `'${closeToken}' precedes its '${openToken}' in ${relPath}` };
    }
    return {
        ok: true,
        full,
        content: lines.slice(opens[0] + 1, closes[0]).join('\n'),
        // Marker positions, so --fix can splice a canonical region back in without
        // disturbing the host file's own surrounding code.
        lines,
        openLine: opens[0],
        closeLine: closes[0],
    };
}

// --fix support (#300). The parity gate tells you a canonical module and its
// copies diverged, but reconciling them was still a manual per-directory copy,
// which is exactly the "must be made twice and kept in sync by hand" cost the
// duplication was reported for. These two helpers make the canonical copy the
// single source you EDIT: fix it once, run `npm run sync:shared`, and every
// other copy is rewritten from it.
//
// Deliberately NOT wired into the build. If syncing ran automatically before
// packaging, a genuine unintended divergence would be silently repaired instead
// of failing CI, which would defeat the whole point of the gate -- the gate has
// to stay fail-closed. Syncing is an explicit authoring step; CI only ever
// verifies.
function writeFamilyCopy(canonicalFull, targetFull) {
    fs.copyFileSync(canonicalFull, targetFull);
}

function writeRegionCopy(canonicalContent, target) {
    const spliced = [
        ...target.lines.slice(0, target.openLine + 1),
        ...canonicalContent.split('\n'),
        ...target.lines.slice(target.closeLine),
    ];
    fs.writeFileSync(target.full, spliced.join('\n'));
}

function main(argv = process.argv.slice(2)) {
    // `--fix` rewrites every non-canonical copy from its canonical source
    // instead of failing on divergence (#300). A missing canonical or a broken
    // region marker is still a hard failure even under --fix: there is nothing
    // trustworthy to sync FROM, so repairing would be a guess.
    const fix = argv.includes('--fix');
    let hasError = false;
    let fixedCount = 0;

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
                    if (fix) {
                        writeFamilyCopy(base.full, other.full);
                        console.log(`FIXED: ${file} rewritten from canonical (${canonicalDir} -> ${dir})`);
                        fixedCount++;
                    } else {
                        console.error(`FAIL: ${file} diverged between ${canonicalDir} and ${dir}`);
                        console.error(`      reconcile both copies (canonical: ${base.full})`);
                        console.error(`      or run: npm run sync:shared`);
                        hasError = true;
                    }
                } else {
                    console.log(`OK: ${file} identical (${canonicalDir} == ${dir})`);
                }
            }
        }
    }

    for (const { region, files } of REGION_FAMILIES) {
        const [canonicalFile, ...otherFiles] = files;
        const base = extractRegion(canonicalFile, region);
        if (!base.ok) {
            console.error(`FAIL: ${base.reason}`);
            hasError = true;
            continue;
        }
        for (const file of otherFiles) {
            const other = extractRegion(file, region);
            if (!other.ok) {
                console.error(`FAIL: ${other.reason}`);
                hasError = true;
                continue;
            }
            if (other.content !== base.content) {
                if (fix) {
                    writeRegionCopy(base.content, other);
                    console.log(`FIXED: region '${region}' rewritten from canonical (${canonicalFile} -> ${file})`);
                    fixedCount++;
                } else {
                    console.error(`FAIL: shared region '${region}' diverged between ${canonicalFile} and ${file}`);
                    console.error(`      reconcile both copies (canonical: ${base.full})`);
                    console.error(`      or run: npm run sync:shared`);
                    hasError = true;
                }
            } else {
                console.log(`OK: region '${region}' identical (${canonicalFile} == ${file})`);
            }
        }
    }

    if (hasError) {
        process.exit(1);
    }
    if (fix) {
        console.log(fixedCount === 0
            ? 'Nothing to sync: every copy already matches its canonical source.'
            : `Synced ${fixedCount} cop${fixedCount === 1 ? 'y' : 'ies'} from canonical. Review the diff before committing.`);
        return;
    }
    console.log('All shared-module parity checks passed.');
}

// Exported so scripts/check-near-duplicate-modules.js can share this single
// allowlist source instead of hand-maintaining a second copy of it (#760).
// Still directly runnable as a script (`node scripts/check-shared-modules.js`),
// which is how CI and test-check-shared-modules.js's spawnSync invoke it.
if (require.main === module) {
    main();
}

module.exports = { FAMILIES, REGION_FAMILIES, main };
