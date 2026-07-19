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
    // Byte-identical parity family across all three listed tasks.
    'Tasks/TerraformTask/TerraformTaskV5/src/secure-temp.js',
    'Tasks/TerraformDriftReport/TerraformDriftReportV1/src/secure-temp.js',
    'Tasks/TerraformPolicyCheck/TerraformPolicyCheckV1/src/secure-temp.js',
    // SSRF/token-exfiltration guard for the host the ADO OIDC bearer JWT is
    // exchanged with for an OCI UPST.
    'Tasks/TerraformTask/TerraformTaskV5/src/oci-token-exchange.js',
    // GPG signature verification gating trust in downloaded HashiCorp/Sentinel
    // release binaries. Byte-identical parity family across both listed tasks.
    'Tasks/TerraformInstaller/TerraformInstallerV1/src/gpg-verifier.js',
    'Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/gpg-verifier.js',
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
//   files        — [{ rel, pct, covered, total }] for this task's instrumented files
//   defaultFloor — the per-file floor for non-exception, non-tiered files
//   securityFloor — the higher per-file floor for SECURITY_TIER files
//   securityTier — the repo-global SECURITY_TIER set (of instrumented-file paths)
//   exceptions   — the repo-global EXCEPTIONS map (filtered to taskRel internally)
// Returns { failures: string[], oks: string[] } — failures non-empty means fail.
function evaluate({ taskRel, files, defaultFloor, securityFloor, securityTier, exceptions }) {
    const taskExceptions = Object.fromEntries(
        Object.entries(exceptions).filter(([file]) => file.startsWith(`${taskRel}/`)),
    );
    const seenExceptions = new Set();
    const failures = [];
    const oks = [];

    for (const { rel, pct, covered, total } of files) {
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
        if (pct < applicableFloor) {
            failures.push(
                `${rel}: lines ${pct}% is below the ${applicableFloor}% ${isSecurityTier ? 'security-tier' : 'per-file'} floor (${covered}/${total}). ` +
                'Add tests, or add a reviewed entry to EXCEPTIONS in scripts/check-per-file-coverage.js.',
            );
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

module.exports = { evaluate, DEFAULT_FLOOR, SECURITY_FLOOR, SECURITY_TIER, EXCEPTIONS };

if (require.main === module) {
    main();
}
