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
const targetFile = path.join('Tasks', 'TerraformTask', 'TerraformTaskV5', 'task.json');

// check-versions.js resolves the repository from its OWN location, not the
// working directory, so a scratch tree has to carry a copy of the script for the
// mutation below to be what the gate reads.
function runCheck(dir) {
    return spawnSync(process.execPath, [path.join(dir, 'scripts', 'check-versions.js')], { cwd: dir, encoding: 'utf8' });
}

// Everything the gate reads: the manifests it compares, the declaration it
// measures Tasks/ against, and the packaging overrides carrying the publish
// identity.
const SCRATCH_INPUTS = [
    'azure-devops-extension.json',
    'task-universe.json',
    '.release-please-manifest.json',
];
const SCRATCH_TREES = ['Tasks', 'configs', 'scripts'];

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-versions-selftest-'));
let failed = false;

try {
    for (const file of SCRATCH_INPUTS) {
        fs.copyFileSync(path.join(repoRoot, file), path.join(scratchDir, file));
    }
    for (const tree of SCRATCH_TREES) {
        fs.cpSync(path.join(repoRoot, tree), path.join(scratchDir, tree), { recursive: true });
    }

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
