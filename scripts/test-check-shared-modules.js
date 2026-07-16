#!/usr/bin/env node
// Self-test for check-shared-modules.js: confirms the shared-module parity
// gate actually catches drift, and doesn't cry wolf on a clean tree. This is
// the guard that protects the security-critical duplicated installer/HTTPS
// modules (see check-shared-modules.js's own header comment); a silent bug
// in its own FAMILIES list or diff logic would otherwise pass CI while
// verifying nothing.
//
// Runs check-shared-modules.js three times against a scratch copy of Tasks/
// (+ src/, needed by the digest-contract family below):
//   1. unmodified copy -> must exit 0
//   2. one paired file (installer family, both dirs under Tasks/) deliberately
//      diverged -> must exit non-zero
//   3. one paired file from the plan/apply digest-contract family (design
//      decision D4) deliberately diverged -> must exit non-zero. This family
//      is exercised separately from case 2 because its second directory
//      (src/tab) is NOT under Tasks/ — a bug that only resolved paths
//      relative to Tasks/ would pass case 2 while silently never comparing
//      this family at all.
// The scratch copy is removed afterwards either way.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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
} finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
}

if (failed) {
    console.error('\ncheck-shared-modules.js self-test: FAILED.');
    process.exit(1);
}
console.log('check-shared-modules.js self-test: all cases passed.');
