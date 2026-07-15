#!/usr/bin/env node
// Self-test for check-versions.js: confirms the version-format gate actually
// catches a malformed task.json, and doesn't cry wolf on a clean tree. A
// silent bug in this script would let a task ship without the version fields
// ADO agents rely on to detect a cache-worthy update.
//
// Runs check-versions.js twice against a scratch copy of the manifest files:
//   1. unmodified copy -> must exit 0
//   2. one task.json deliberately missing its Minor version field -> must
//      exit non-zero
// The scratch copy is removed afterwards either way.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'check-versions.js');
const targetFile = path.join('Tasks', 'TerraformTask', 'TerraformTaskV5', 'task.json');

function runCheck(cwd) {
    return spawnSync(process.execPath, [scriptPath], { cwd, encoding: 'utf8' });
}

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-versions-selftest-'));
let failed = false;

try {
    fs.copyFileSync(
        path.join(repoRoot, 'azure-devops-extension.json'),
        path.join(scratchDir, 'azure-devops-extension.json'),
    );
    fs.cpSync(path.join(repoRoot, 'Tasks'), path.join(scratchDir, 'Tasks'), { recursive: true });

    const cleanResult = runCheck(scratchDir);
    if (cleanResult.status !== 0) {
        console.error('FAIL: check-versions.js exited non-zero on an unmodified copy.');
        console.error(cleanResult.stdout, cleanResult.stderr);
        failed = true;
    } else {
        console.log('OK: check-versions.js exits 0 on a valid tree.');
    }

    const scratchTarget = path.join(scratchDir, targetFile);
    const taskJson = JSON.parse(fs.readFileSync(scratchTarget, 'utf8'));
    delete taskJson.version.Minor;
    fs.writeFileSync(scratchTarget, JSON.stringify(taskJson, null, 4));

    const brokenResult = runCheck(scratchDir);
    if (brokenResult.status === 0) {
        console.error('FAIL: check-versions.js exited 0 despite a task.json missing its Minor version field.');
        failed = true;
    } else {
        console.log('OK: check-versions.js exits non-zero on a malformed version field.');
    }
} finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
}

if (failed) {
    console.error('\ncheck-versions.js self-test: FAILED.');
    process.exit(1);
}
console.log('check-versions.js self-test: all cases passed.');
