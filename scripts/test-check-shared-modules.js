#!/usr/bin/env node
// Self-test for check-shared-modules.js: confirms the shared-module parity
// gate actually catches drift, and doesn't cry wolf on a clean tree. This is
// the guard that protects the security-critical duplicated installer/HTTPS
// modules (see check-shared-modules.js's own header comment); a silent bug
// in its own FAMILIES list or diff logic would otherwise pass CI while
// verifying nothing.
//
// Runs check-shared-modules.js against a scratch copy of Tasks/ (+ src/, needed
// by the digest-contract family below):
//   1. unmodified copy -> must exit 0
//   2. one paired file (installer family, both dirs under Tasks/) deliberately
//      diverged -> must exit non-zero
//   3. one paired file from the plan/apply digest-contract family (design
//      decision D4) deliberately diverged -> must exit non-zero. This family
//      is exercised separately from case 2 because its second directory
//      (src/tab) is NOT under Tasks/ -- a bug that only resolved paths
//      relative to Tasks/ would pass case 2 while silently never comparing
//      this family at all.
//   4. `--fix` repairs a diverged copy from its canonical source, asserted on
//      exact post-fix bytes so a --fix that "succeeded" by doing nothing still
//      fails.
//   5. the NON-VACUITY guard: a family that can compare nothing must be a hard
//      failure, not a silent pass. Driven directly with synthetic families
//      rather than through the scratch tree, because the failure it describes
//      cannot be staged by editing files -- only by editing the FAMILIES list.
// The scratch copy is removed afterwards either way.
//
// Cases for REGION_FAMILIES were removed with that mechanism: every block it
// gated now comes from @4cloudguru/pipeline-task-core, no file in the tree
// carries a `// #region shared:` marker, and a self-test asserting on a
// mechanism with no members would itself be the vacuous check this file exists
// to prevent.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { FAMILIES, assertFamiliesAreComparable } = require('./check-shared-modules.js');

const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'check-shared-modules.js');
// A real byte-identical pair enforced by check-shared-modules.js's FAMILIES
// list (the installer trust-chain family); PolicyAgentInstallerV1's copy is
// not the canonical one, so diverging it exercises the comparison branch.
const targetFile = path.join('Tasks', 'PolicyAgentInstaller', 'PolicyAgentInstallerV1', 'src', 'http-client.ts');
// The plan/apply digest-contract family's non-canonical copy (src/tab/,
// repo-root — not under Tasks/). See case 3 in the header comment above.
const digestFamilyTargetFile = path.join('src', 'tab', 'caps.ts');

function runCheck(cwd) {
    return spawnSync(process.execPath, [scriptPath], { cwd, encoding: 'utf8' });
}

// `--fix` mode (#300): rewrites every non-canonical copy from its canonical
// source. Cases 7 and 8 below prove it actually repairs both family kinds and
// that it leaves a region host file's surrounding code untouched.
function runFix(cwd) {
    return spawnSync(process.execPath, [scriptPath, '--fix'], { cwd, encoding: 'utf8' });
}

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-shared-modules-selftest-'));
let failed = false;

try {
    fs.cpSync(path.join(repoRoot, 'Tasks'), path.join(scratchDir, 'Tasks'), { recursive: true });
    // The digest-contract family (digest-schema.ts / caps.ts) pairs a task copy
    // under Tasks/ with the repo-root tab copy under src/tab, so the scratch tree
    // must include src/ for check-shared-modules.js to find both copies on the
    // clean run. The divergence case below still targets a Tasks/ file.
    fs.cpSync(path.join(repoRoot, 'src'), path.join(scratchDir, 'src'), { recursive: true });

    const cleanResult = runCheck(scratchDir);
    if (cleanResult.status !== 0) {
        console.error('FAIL: check-shared-modules.js exited non-zero on an unmodified copy.');
        console.error(cleanResult.stdout, cleanResult.stderr);
        failed = true;
    } else {
        console.log('OK: check-shared-modules.js exits 0 on a matching tree.');
    }

    const scratchTarget = path.join(scratchDir, targetFile);
    fs.appendFileSync(scratchTarget, '\n// check-shared-modules self-test divergence marker\n');

    const divergedResult = runCheck(scratchDir);
    if (divergedResult.status === 0) {
        console.error('FAIL: check-shared-modules.js exited 0 despite a deliberately diverged copy.');
        failed = true;
    } else {
        console.log('OK: check-shared-modules.js exits non-zero on a diverged copy.');
    }

    // Case 3: revert the first divergence, then diverge only the digest-contract
    // family's non-Tasks/ copy, to prove that family specifically is enforced
    // (not just families whose second directory happens to live under Tasks/).
    fs.cpSync(path.join(repoRoot, 'Tasks'), path.join(scratchDir, 'Tasks'), { recursive: true });
    const digestFamilyScratchTarget = path.join(scratchDir, digestFamilyTargetFile);
    fs.appendFileSync(digestFamilyScratchTarget, '\n// check-shared-modules self-test divergence marker\n');

    const digestFamilyDivergedResult = runCheck(scratchDir);
    if (digestFamilyDivergedResult.status === 0) {
        console.error('FAIL: check-shared-modules.js exited 0 despite the digest-contract family (src/tab) being deliberately diverged.');
        failed = true;
    } else {
        console.log('OK: check-shared-modules.js exits non-zero on a diverged digest-contract family copy (src/tab).');
    }

    // Case 4 (--fix, #300): with a whole-file family copy deliberately diverged,
    // `--fix` must rewrite it from its canonical source so a subsequent plain
    // check passes. Asserts on exact post-fix content, not merely on a zero exit,
    // so a --fix that "succeeded" by doing nothing (or by rewriting the wrong
    // direction) still fails this case.
    fs.cpSync(path.join(repoRoot, 'Tasks'), path.join(scratchDir, 'Tasks'), { recursive: true });
    fs.cpSync(path.join(repoRoot, 'src'), path.join(scratchDir, 'src'), { recursive: true });
    const fixFamilyTarget = path.join(scratchDir, targetFile);
    const fixFamilyCanonical = path.join(scratchDir, 'Tasks', 'TerraformInstaller', 'TerraformInstallerV1', 'src', 'http-client.ts');
    const canonicalFamilyContent = fs.readFileSync(fixFamilyCanonical, 'utf8');
    fs.appendFileSync(fixFamilyTarget, '\n// check-shared-modules --fix self-test divergence marker\n');

    // Sanity: the tree really is broken before --fix runs, so a green result
    // below cannot come from having diverged nothing at all.
    if (runCheck(scratchDir).status === 0) {
        console.error('FAIL: self-test setup error — the tree was still clean before --fix ran.');
        failed = true;
    }

    const fixResult = runFix(scratchDir);
    const postFixCheck = runCheck(scratchDir);
    const repairedFamily = fs.readFileSync(fixFamilyTarget, 'utf8');

    if (fixResult.status !== 0) {
        console.error('FAIL: check-shared-modules.js --fix exited non-zero.');
        console.error(fixResult.stdout, fixResult.stderr);
        failed = true;
    } else if (repairedFamily !== canonicalFamilyContent) {
        console.error('FAIL: --fix did not restore the whole-file family copy to the canonical bytes.');
        failed = true;
    } else if (postFixCheck.status !== 0) {
        console.error('FAIL: the parity gate still fails after --fix repaired every copy.');
        console.error(postFixCheck.stdout, postFixCheck.stderr);
        failed = true;
    } else {
        console.log('OK: --fix rewrites a whole-file copy from canonical.');
    }

    // Case 5 (non-vacuity): a family that compares NOTHING must be a hard
    // failure. Retiring a module into a shared package is what empties a family
    // (#949), and a one-directory family prints exactly what a clean four-file
    // comparison prints. Driven directly, because no edit to the scratch tree
    // can produce a malformed FAMILIES list.
    const vacuousCases = [
        { label: 'an empty FAMILIES list', families: [] },
        { label: 'a single-directory family', families: [{ dirs: ['Tasks/A/src'], modules: ['x.ts'] }] },
        { label: 'a family listing no modules', families: [{ dirs: ['Tasks/A/src', 'Tasks/B/src'], modules: [] }] },
    ];
    for (const { label, families } of vacuousCases) {
        const problems = assertFamiliesAreComparable(families);
        if (problems.length === 0) {
            console.error(`FAIL: assertFamiliesAreComparable accepted ${label}, which compares nothing.`);
            failed = true;
        } else {
            console.log(`OK: ${label} is rejected (${problems[0]}).`);
        }
    }

    // ...and the real list must satisfy it, or every case above is theatre.
    const realProblems = assertFamiliesAreComparable(FAMILIES);
    if (realProblems.length > 0) {
        console.error('FAIL: the repo\'s own FAMILIES list is not comparable:');
        for (const problem of realProblems) console.error(`      ${problem}`);
        failed = true;
    } else {
        console.log(`OK: the repo's own ${FAMILIES.length} families each compare at least two directories.`);
    }
} finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
}

if (failed) {
    console.error('\ncheck-shared-modules.js self-test: FAILED.');
    process.exit(1);
}
console.log('check-shared-modules.js self-test: all cases passed.');
