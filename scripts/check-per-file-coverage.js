#!/usr/bin/env node
// Per-file line-coverage floor for a single task.
//
// WHY: each task's .nycrc.json enforces only TASK-WIDE average thresholds. An
// average lets a security-critical module sit at ~0% real coverage as long as
// well-covered siblings pull the blended number over the bar — exactly how
// TerraformInstallerV1's gpg-verifier.ts (exercised only through mocks) hid
// under an otherwise-green gate (issue #590). nyc's own `perFile` applies one
// blanket threshold to every file, which is too blunt (type-only and thin glue
// files legitimately sit low). This gate instead enforces a per-file LINES floor
// with an explicit, reviewed exceptions map for the handful of files below it.
//
// TIERING (issue #655): a single flat floor still lets a security-critical
// file ship with a large fraction of its lines never executed, as long as it
// clears the general floor. Files named in SECURITY_TIER below are held to a
// higher SECURITY_FLOOR instead of DEFAULT_FLOOR; a tiered file that falls
// below its floor gets a reviewed, commented EXCEPTIONS entry (never a silent
// lowering of the tier itself).
//
// HOW IT RUNS: wired as each task's `posttest:coverage` npm script, so it fires
// automatically right after `npm run test:coverage` (which CI runs per task) and
// reads that task's coverage/coverage-summary.json (nyc's json-summary reporter,
// added to every .nycrc.json). It identifies the current task from the working
// directory, so no per-task list lives here.
//
// Usage: node <repo>/scripts/check-per-file-coverage.js   (cwd = the task dir)
//
// The classification logic is the pure, exported evaluate() below; main() only
// does IO (read summary, resolve the task, exit). scripts/test-check-per-file-
// coverage.js exercises evaluate() directly.

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

// The per-file lines floor every instrumented src file must clear unless it has
// an explicit exception below. Chosen from the real per-file numbers on main:
// the lowest non-exception file sits at ~63%, so 60 is a defensible floor that
// catches a genuine coverage collapse without churning on thin-but-fine files.
const DEFAULT_FLOOR = 60;

// A single flat floor lets a security-critical file ship with ~40% of its
// lines never executed by a test, as long as it clears 60% (issue #655).
// SECURITY_TIER files (below) are held to this higher floor instead. Chosen
// from the real numbers on main (2026-07-18): every SECURITY_TIER file not
// listed in EXCEPTIONS already clears 93%+, so 80 is a real, non-aspirational
// floor for this tier, not a target the code hasn't reached yet.
const SECURITY_FLOOR = 80;

// The LINES floor above still lets a SECURITY_TIER file ship with whole
// functions or large conditional branches never executed by any test (issue
// #777): lines can be fully hit by a single happy-path call that never enters
// an OS-specific chmod/DACL path, an error branch, or an unused helper. Every
// SECURITY_TIER file is therefore ALSO held to a functions- and a branches-
// coverage floor. Chosen from the real per-file numbers on main (2026-07-23):
// the lowest tiered functions% is 60 (hcp-terraform-command-handler.js) and
// the lowest tiered branches% is 57.14 (secure-temp.js in three tasks), so 50
// is a real, non-aspirational floor below the current worst tiered file for
// each metric — it catches a genuine functions/branches collapse without
// churning on files that are merely thin. DEFAULT_FLOOR (non-tiered) files keep
// the lines-only gate; they legitimately include type-only and thin glue files
// whose functions/branches numbers are noisy and low by nature.
const SECURITY_FUNCTIONS_FLOOR = 50;
const SECURITY_BRANCHES_FLOOR = 50;

// Files held to SECURITY_FLOOR instead of DEFAULT_FLOOR: the credential-
// handling, trust-verification, and redaction modules the Recommendation in
// issue #655 names, plus every byte-identical parity-family copy of each
// (scripts/check-shared-modules.js) so a tier can never end up applied to only
// one copy of a shared module. Keys are repo-relative paths to the
// INSTRUMENTED file, same convention as EXCEPTIONS below.
const SECURITY_TIER = new Set([
    // "The single most security-critical module" per its own header: the
    // fail-closed redaction core standing between raw plan/state values and a
    // build-attachment-visible (not secret-masked) pipeline artifact.
    'Tasks/TerraformTask/TerraformTaskV5/src/results/redact.js',
    // Owner-only 0600 + O_EXCL (Unix) / restrictive icacls DACL (Windows)
    // secure-temp-file primitive guarding WIF/OCI credential material.
    // Byte-identical parity family across all four listed tasks (Batch E
    // round 1: ProviderMirror's copy was missing from this tier despite
    // check-shared-modules.js already tracking it as the same parity family).
    'Tasks/TerraformTask/TerraformTaskV5/src/secure-temp.js',
    'Tasks/TerraformDriftReport/TerraformDriftReportV1/src/secure-temp.js',
    'Tasks/TerraformPolicyCheck/TerraformPolicyCheckV1/src/secure-temp.js',
    'Tasks/TerraformProviderMirror/TerraformProviderMirrorV1/src/secure-temp.js',
    // SSRF/token-exfiltration guard for the host the ADO OIDC bearer JWT is
    // exchanged with for an OCI UPST.
    'Tasks/TerraformTask/TerraformTaskV5/src/oci-token-exchange.js',
    // GPG signature verification gating trust in downloaded HashiCorp/Sentinel
    // release binaries. Byte-identical parity family across both listed tasks.
    'Tasks/TerraformInstaller/TerraformInstallerV1/src/gpg-verifier.js',
    'Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/gpg-verifier.js',

    // Audit id23 (2026-07-20, extends issue #590): the per-file floor mechanism
    // itself is sound, but it originally covered only the 7 files above -- these
    // additional credential-transport and trust-verification modules are just as
    // security-critical and were left at DEFAULT_FLOOR with no per-file guarantee.
    //
    // cosign keyless/cert-identity anchor gating trust in downloaded OpenTofu
    // release binaries -- the direct sibling of the already-tiered gpg-verifier.js.
    'Tasks/TerraformInstaller/TerraformInstallerV1/src/cosign-verifier.js',
    // Credential-bearing HTTPS transports (TSM callback token / registry API key,
    // including the skipTlsVerify branch). Byte-identical parity family across
    // both listed tasks (scripts/check-shared-modules.js).
    'Tasks/TerraformDriftReport/TerraformDriftReportV1/src/https-client.js',
    'Tasks/TerraformModulePublish/TerraformModulePublishV1/src/https-client.js',
    // The hand-tracked (not whole-file parity-gated) ServiceNow credential
    // transport sibling of the https-client.js family above.
    'Tasks/PublishKbArticle/PublishKbArticleV1/src/servicenow-http.js',
    // Registry API-key Bearer transport, including the skipTlsVerify branch.
    'Tasks/TerraformModulePublish/TerraformModulePublishV1/src/http.js',
    // KB stored-XSS fail-closed gate: the URI-scheme allowlist shared by both
    // sanitizer/validator layers (byte-identical parity family, #446 lineage)...
    'Tasks/Markdown2Html/Markdown2HtmlV1/src/uri-scheme-guard.js',
    'Tasks/PublishKbArticle/PublishKbArticleV1/src/uri-scheme-guard.js',
    // ...and the independent fail-closed HTML validator itself (the `force`-input
    // bypass path's gate).
    'Tasks/PublishKbArticle/PublishKbArticleV1/src/html-validate.js',
    // Git-clone token handling (http.extraheader, ref/subdir validation) for the
    // policy-source repo.
    'Tasks/TerraformPolicyCheck/TerraformPolicyCheckV1/src/policy-source.js',
    // .terraformrc / HCL generation from operator-supplied mirror inputs.
    'Tasks/TerraformProviderMirror/TerraformProviderMirrorV1/src/config-generator.js',
    // OIDC host allowlist + minting shared by all four cloud handlers' WIF paths.
    'Tasks/TerraformTask/TerraformTaskV5/src/id-token-generator.js',

    // Issue #755: the per-cloud command handlers that actually write the
    // credential material id-token-generator.js/oci-token-exchange.js mint --
    // PEM private keys, OCI PAR-embedding backend config, and WIF/ARM_* tokens
    // -- to disk and/or the child process environment. Tiering the minting
    // helpers above but not these was an inconsistent gap: a regression here is
    // just as exposure-relevant as one in the helpers that feed them.
    'Tasks/TerraformTask/TerraformTaskV5/src/azure-terraform-command-handler.js',
    'Tasks/TerraformTask/TerraformTaskV5/src/aws-terraform-command-handler.js',
    'Tasks/TerraformTask/TerraformTaskV5/src/gcp-terraform-command-handler.js',
    'Tasks/TerraformTask/TerraformTaskV5/src/oci-terraform-command-handler.js',
    // Batch E round 1 (#755 missed sibling): same credential-to-env pattern as
    // the four handlers above -- applyBackendEnv() reads backendHCPToken,
    // setSecret()s it, then writes it to TF_TOKEN_app_terraform_io. Left out of
    // the original #755 pass alongside them despite fitting its rationale
    // exactly. generic-terraform-command-handler.js handles no credentials at
    // all and correctly stays untiered.
    'Tasks/TerraformTask/TerraformTaskV5/src/hcp-terraform-command-handler.js',
    // Batch E round 1 (#755 missed sibling): the shared PEM parsing/validation
    // helper the gcp and oci handlers above call (normalizePem) before that
    // normalized private-key material is written to disk/env -- as exposure-
    // relevant as the already-tiered id-token-generator.js/oci-token-
    // exchange.js minting helpers it sits alongside.
    'Tasks/TerraformTask/TerraformTaskV5/src/pem-normalizer.js',
    // The single credential-to-process.env channel every provider handler
    // funnels secret values through (setEnvironmentVariable / setSecret /
    // trackedSecretValues) -- the same rationale as the handlers above.
    'Tasks/TerraformTask/TerraformTaskV5/src/environment-variables.js',
    // PublishKbArticleV1's ServiceNow credential path: auth.js builds the
    // Basic/OAuth Authorization header (setSecret point-of-read for the
    // password/token), and servicenow-client.js is the sole caller that sends
    // it -- the direct sibling of the already-tiered servicenow-http.js
    // transport and uri-scheme-guard.js validator in this same pipeline.
    'Tasks/PublishKbArticle/PublishKbArticleV1/src/auth.js',
    'Tasks/PublishKbArticle/PublishKbArticleV1/src/servicenow-client.js',

    // Issue #776: the shared pre-signed-URL / operator-mirror-URL credential
    // redaction module (CWE-532) standing between a registry download_url or a
    // userinfo-bearing mirror URL and the (non-secret-masked) build log. It is
    // byte-identical across all four consuming tasks (scripts/check-shared-
    // modules.js) and is the direct sibling of the already-tiered redact.js /
    // uri-scheme-guard.js redaction modules, yet was left at DEFAULT_FLOOR --
    // where three of the four copies sat ~20 branch-points below
    // TerraformProviderMirror's until #776 ported its thorough
    // UrlSecretRedactionL0 suite to all four.
    'Tasks/TerraformInstaller/TerraformInstallerV1/src/url-secret-redaction.js',
    'Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/url-secret-redaction.js',
    'Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src/url-secret-redaction.js',
    'Tasks/TerraformProviderMirror/TerraformProviderMirrorV1/src/url-secret-redaction.js',
]);

// Files allowed BELOW their applicable floor (DEFAULT_FLOOR, or SECURITY_FLOOR
// for a SECURITY_TIER file), each with its own (lower) minimum so a listed
// file still cannot silently collapse to zero. Keys are repo-relative paths to
// the INSTRUMENTED file (the compiled .js nyc measures). Keep this map tiny
// and justified — every entry is reviewed, and the gate FAILS a stale entry
// (see evaluate) so exceptions cannot outlive their reason.
//
//   floor: the per-file lines minimum for this file (0 = exercised-incidentally
//          / nothing-meaningful-to-cover; a positive value still guards against
//          regression below the level reached today).
const EXCEPTIONS = {
    // STRUCTURAL — digest-schema.ts is the shared plan/apply digest CONTRACT
    // (byte-identical copy in src/tab/, gated by check-shared-modules.js). It is
    // almost entirely TypeScript type declarations that compile away; the single
    // remaining executable line is a schema-version constant with no branch or
    // behavior to unit-test. Permanent, low-value-to-cover exception.
    'Tasks/TerraformTask/TerraformTaskV5/src/results/digest-schema.js': {
        floor: 0,
        note: 'types-only shared contract; nothing meaningful to unit-test',
    },
    // (The DriftReport/PolicyCheck secure-temp.js exceptions added with the
    // tiered floors were removed once the #634 direct suites lifted both
    // copies above the 80% SECURITY_FLOOR — the gate itself fails on a stale
    // exception, by design.)
};

// Pure classifier. Inputs:
//   taskRel      — repo-relative task dir, e.g. 'Tasks/Foo/FooV1'
//   files        — [{ rel, pct, covered, total, funcsPct, funcsCovered,
//                  funcsTotal, branchPct, branchCovered, branchTotal }] for this
//                  task's instrumented files
//   defaultFloor — the per-file LINES floor for non-exception, non-tiered files
//   securityFloor — the higher per-file LINES floor for SECURITY_TIER files
//   securityFunctionsFloor — the per-file FUNCTIONS floor for SECURITY_TIER files (#777)
//   securityBranchesFloor — the per-file BRANCHES floor for SECURITY_TIER files (#777)
//   securityTier — the repo-global SECURITY_TIER set (of instrumented-file paths)
//   exceptions   — the repo-global EXCEPTIONS map (filtered to taskRel internally)
// Returns { failures: string[], oks: string[] } — failures non-empty means fail.
function evaluate({ taskRel, files, defaultFloor, securityFloor, securityFunctionsFloor, securityBranchesFloor, securityTier, exceptions }) {
    const taskExceptions = Object.fromEntries(
        Object.entries(exceptions).filter(([file]) => file.startsWith(`${taskRel}/`)),
    );
    const seenExceptions = new Set();
    const failures = [];
    const oks = [];

    for (const { rel, pct, covered, total, funcsPct, funcsCovered, funcsTotal, branchPct, branchCovered, branchTotal } of files) {
        // A tiered file's OWN floor — used both to gate non-exception files and,
        // for an exception file, to decide whether it has become stale. Using
        // the file's real tier here (rather than always defaultFloor) is what
        // stops a SECURITY_TIER exception file from being flagged "stale" the
        // moment it merely clears the general 60% floor while still sitting
        // below its actual 80% security floor.
        const isSecurityTier = securityTier.has(rel);
        const applicableFloor = isSecurityTier ? securityFloor : defaultFloor;
        const exception = taskExceptions[rel];
        if (exception) {
            seenExceptions.add(rel);
            if (pct < exception.floor) {
                failures.push(
                    `${rel}: lines ${pct}% is below its exception floor ${exception.floor}% (${covered}/${total}).`,
                );
            } else if (pct >= applicableFloor) {
                failures.push(
                    `${rel}: lines ${pct}% now clears the ${applicableFloor}% floor — ` +
                    `remove its stale entry from EXCEPTIONS in scripts/check-per-file-coverage.js (${exception.note}).`,
                );
            } else {
                oks.push(`exempt ${rel}: ${pct}% >= floor ${exception.floor}% (${exception.note})`);
            }
            continue;
        }
        const fileFailures = [];
        if (pct < applicableFloor) {
            fileFailures.push(
                `${rel}: lines ${pct}% is below the ${applicableFloor}% ${isSecurityTier ? 'security-tier' : 'per-file'} floor (${covered}/${total}). ` +
                'Add tests, or add a reviewed entry to EXCEPTIONS in scripts/check-per-file-coverage.js.',
            );
        }
        // #777: a SECURITY_TIER file is additionally held to a functions- and a
        // branches-coverage floor, so it cannot pass with whole functions or
        // conditional branches never executed while its lines number looks fine.
        // A lines-EXCEPTIONS file is a reviewed, lines-focused carve-out handled
        // in the branch above (no tiered file is excepted today); DEFAULT_FLOOR
        // files keep the lines-only gate.
        if (isSecurityTier) {
            if (funcsPct < securityFunctionsFloor) {
                fileFailures.push(
                    `${rel}: functions ${funcsPct}% is below the ${securityFunctionsFloor}% security-tier functions floor (${funcsCovered}/${funcsTotal}). ` +
                    'Add tests that call the uncovered function(s).',
                );
            }
            if (branchPct < securityBranchesFloor) {
                fileFailures.push(
                    `${rel}: branches ${branchPct}% is below the ${securityBranchesFloor}% security-tier branches floor (${branchCovered}/${branchTotal}). ` +
                    'Add tests that exercise the uncovered branch(es).',
                );
            }
        }
        if (fileFailures.length) {
            failures.push(...fileFailures);
        } else {
            oks.push(`OK ${rel}: ${pct}%${isSecurityTier ? ' (security tier)' : ''}`);
        }
    }

    // A listed exception whose file no longer appears (renamed/removed/excluded)
    // is dead weight — fail so the map stays honest.
    for (const rel of Object.keys(taskExceptions)) {
        if (!seenExceptions.has(rel)) {
            failures.push(
                `${rel}: listed in EXCEPTIONS but not present in this task's coverage summary — ` +
                'remove the dangling entry from scripts/check-per-file-coverage.js.',
            );
        }
    }

    return { failures, oks };
}

function toRepoRel(absPath) {
    return path.relative(repoRoot, absPath).split(path.sep).join('/');
}

// Turn a nyc coverage-summary.json object into evaluate()'s `files` array.
function filesFromSummary(summary) {
    const files = [];
    for (const [absFile, metrics] of Object.entries(summary)) {
        if (absFile === 'total') continue;
        files.push({
            rel: toRepoRel(absFile),
            pct: metrics.lines.pct,
            covered: metrics.lines.covered,
            total: metrics.lines.total,
            funcsPct: metrics.functions.pct,
            funcsCovered: metrics.functions.covered,
            funcsTotal: metrics.functions.total,
            branchPct: metrics.branches.pct,
            branchCovered: metrics.branches.covered,
            branchTotal: metrics.branches.total,
        });
    }
    return files;
}

function main() {
    const taskRel = toRepoRel(process.cwd());
    const summaryPath = path.join(process.cwd(), 'coverage', 'coverage-summary.json');

    if (!fs.existsSync(summaryPath)) {
        console.error(
            `check-per-file-coverage: no coverage summary at ${summaryPath}. ` +
            'Ensure .nycrc.json includes the "json-summary" reporter and this runs after test:coverage.',
        );
        process.exit(1);
    }

    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    const { failures, oks } = evaluate({
        taskRel,
        files: filesFromSummary(summary),
        defaultFloor: DEFAULT_FLOOR,
        securityFloor: SECURITY_FLOOR,
        securityFunctionsFloor: SECURITY_FUNCTIONS_FLOOR,
        securityBranchesFloor: SECURITY_BRANCHES_FLOOR,
        securityTier: SECURITY_TIER,
        exceptions: EXCEPTIONS,
    });

    for (const line of oks) console.log(`  ${line}`);

    if (failures.length) {
        console.error(`\ncheck-per-file-coverage: FAILED for ${taskRel}:`);
        for (const f of failures) console.error(`  FAIL ${f}`);
        process.exit(1);
    }
    console.log(`check-per-file-coverage: all files in ${taskRel} meet the per-file floor.`);
}

module.exports = { evaluate, DEFAULT_FLOOR, SECURITY_FLOOR, SECURITY_FUNCTIONS_FLOOR, SECURITY_BRANCHES_FLOOR, SECURITY_TIER, EXCEPTIONS };

if (require.main === module) {
    main();
}
