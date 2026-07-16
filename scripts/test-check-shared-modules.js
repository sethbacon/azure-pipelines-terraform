#!/usr/bin/env node
// Self-test for check-shared-modules.js: confirms the shared-module parity
// gate actually catches drift, and doesn't cry wolf on a clean tree. This is
// the guard that protects the security-critical duplicated installer/HTTPS
// modules (see check-shared-modules.js's own header comment); a silent bug
// in its own FAMILIES list or diff logic would otherwise pass CI while
// verifying nothing.
//
// Runs check-shared-modules.js twice against a scratch copy of Tasks/:
//   1. unmodified copy -> must exit 0
//   2. one paired file deliberately diverged -> must exit non-zero
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

function runCheck(cwd) {
    return spawnSync(process.execPath, [scriptPath], { cwd, encoding: 'utf8' });
}

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-shared-modules-selftest-'));
let failed = false;

try {
    fs.cpSync(path.join(repoRoot, 'Tasks'), path.join(scratchDir, 'Tasks'), { recursive: true });

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
} finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
}

if (failed) {
    console.error('\ncheck-shared-modules.js self-test: FAILED.');
    process.exit(1);
}
console.log('check-shared-modules.js self-test: all cases passed.');
