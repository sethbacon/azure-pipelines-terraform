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
        // Credential-bearing HTTPS transport shared by the registry module publish
        // (API key) and the drift callback (TSM token). The transport itself now
        // comes from @4cloudguru/pipeline-task-core; what these two copies still
        // share is the task-side wiring the package refuses to own -- reading the
        // agent's proxy configuration, registering the credential with the log
        // masker, and the body/timeout/rejectUnauthorized arguments handed to it.
        // Still a real comparison of two real files: a change to how either task
        // constructs its client must land in both.
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

// The installer family and the credential-bearing family above are deliberately
// NOT merged. They sit on different transport primitives (fetch+AbortController
// vs raw https.request+req.setTimeout) and different trust models: the installer
// family downloads public release artifacts and sends no credential, while the
// second attaches a bearer token/API key to every request. Both now consume
// @4cloudguru/pipeline-task-core, so the implementations are single-sourced even
// though the two client shapes stay distinct.
//
// REGION FAMILIES REMOVED. This script used to carry a second mechanism,
// REGION_FAMILIES, which byte-compared a marked block inside files that were not
// whole-file copies. It existed for exactly three blocks -- the CONNECT-tunnelling
// ProxyTunnelAgent class, the request-timeout/response-cap constants, and
// truncateBody -- hand-copied across the two https-client.ts files,
// PublishKbArticleV1's servicenow-http.ts and TerraformTaskV5's
// oci-token-exchange.ts. All three now come from @4cloudguru/pipeline-task-core,
// and so does the https-only guard that never made it into any gate at all.
//
// The mechanism went with them rather than being left declaring nothing. That is
// not tidiness: a family that compares nothing prints the same "checks passed"
// as one that compared four files and found no drift, which is the trap #949
// came close to -- retiring http-client.ts emptied its families, and they only
// kept working because the shims stayed. An empty REGION_FAMILIES would have
// been that failure one level up, in the mechanism instead of a family.
//
// The reason the regions existed also stopped applying. PublishKbArticle is
// moving to azure-pipelines-release-docs, where a gate in THIS repository cannot
// see it; that move is what forced the extraction. Had the regions survived it,
// they would have quietly stopped comparing anything real. If a future block
// genuinely has to be duplicated into a file that is not a whole-file copy,
// restore the mechanism from this file's history -- deliberately, with the
// self-test cases that proved it fails closed.

// Region families: unlike FAMILIES (whole-file byte-identity), each entry names a
// marked region that must stay byte-identical across files that are otherwise NOT
// whole-file copies. A `// #region shared:<name>` ... `// #endregion shared:<name>`
// pair brackets the shared block in every listed file, and the text strictly
// between the markers is compared byte-for-byte (line endings normalized as
// below). This lets a complex class be duplicated verbatim into a file that has
// its own surrounding code and still be gated. Fail-closed: a missing, duplicated,
// or out-of-order marker in ANY listed file is a hard failure, so deleting a
// marker can never silently skip the check.
// Normalize line endings so a CRLF checkout never reads as drift; the bytes that
// matter (the key material, the verification logic) are still compared exactly.
function read(relDir, file) {
    const full = path.resolve(relDir, file);
    if (!fs.existsSync(full)) {
        return { ok: false, full };
    }
    return { ok: true, full, content: fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n') };
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

/**
 * A family that compares NOTHING must never report the same thing as a family
 * that compared four files and found no drift.
 *
 * This is the #949 lesson made mechanical. Retiring http-client.ts into a
 * package left its families enumerating shims; had the shims not remained, the
 * `dirs` lists would have collapsed to one entry each and every loop below would
 * have run zero comparisons while the script still printed "All shared-module
 * parity checks passed." A single-directory family is not a weak check, it is an
 * absent one wearing the same output.
 *
 * So: at least one family, at least two directories in each, at least one module
 * in each. A family that no longer has a job should be DELETED (and its removal
 * explained), never left declaring a set it cannot compare.
 *
 * Exported so the self-test can drive it with synthetic inputs -- the failure it
 * describes cannot be staged by editing the repo tree, only by editing this list.
 */
function assertFamiliesAreComparable(families) {
    const problems = [];
    if (!Array.isArray(families) || families.length === 0) {
        problems.push('FAMILIES is empty: nothing is gated, and every run would pass vacuously.');
        return problems;
    }
    families.forEach((family, index) => {
        const label = `FAMILIES[${index}]${family?.dirs?.[0] ? ` (${family.dirs[0]})` : ''}`;
        const dirs = Array.isArray(family?.dirs) ? family.dirs : [];
        const modules = Array.isArray(family?.modules) ? family.modules : [];
        if (dirs.length < 2) {
            problems.push(
                `${label} names ${dirs.length} director${dirs.length === 1 ? 'y' : 'ies'}: ` +
                'a family needs at least two to compare anything. Delete the family if it no longer has a job.',
            );
        }
        if (modules.length === 0) {
            problems.push(`${label} lists no modules, so it compares nothing.`);
        }
    });
    return problems;
}

function main(argv = process.argv.slice(2)) {
    // `--fix` rewrites every non-canonical copy from its canonical source
    // instead of failing on divergence (#300). A missing canonical or a broken
    // region marker is still a hard failure even under --fix: there is nothing
    // trustworthy to sync FROM, so repairing would be a guess.
    const fix = argv.includes('--fix');
    let hasError = false;
    let fixedCount = 0;

    // Before comparing anything, check there IS something to compare.
    const structuralProblems = assertFamiliesAreComparable(FAMILIES);
    if (structuralProblems.length > 0) {
        for (const problem of structuralProblems) {
            console.error(`FAIL: ${problem}`);
        }
        process.exit(1);
    }

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

    if (hasError) {
        process.exit(1);
    }
    if (fix) {
        console.log(fixedCount === 0
            ? 'Nothing to sync: every copy already matches its canonical source.'
            : `Synced ${fixedCount} cop${fixedCount === 1 ? 'y' : 'ies'} from canonical. Review the diff before committing.`);
        return;
    }
    const comparisons = FAMILIES.reduce(
        (total, { dirs, modules }) => total + (dirs.length - 1) * modules.length,
        0,
    );
    // Says how much was compared, not merely that nothing failed: "found no
    // drift" and "compared nothing" must not print the same line.
    console.log(
        `All shared-module parity checks passed (${FAMILIES.length} families, ${comparisons} file comparisons).`,
    );
}

// Exported so scripts/check-near-duplicate-modules.js can share this single
// allowlist source instead of hand-maintaining a second copy of it (#760).
// Still directly runnable as a script (`node scripts/check-shared-modules.js`),
// which is how CI and test-check-shared-modules.js's spawnSync invoke it.
if (require.main === module) {
    main();
}

module.exports = { FAMILIES, assertFamiliesAreComparable, main };
