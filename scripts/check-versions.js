#!/usr/bin/env node
// Validates that version fields exist and are well-formed in all task manifests.
//
// The task list is DERIVED from the Tasks/*/*/task.json directory scan (see
// scripts/lib/task-dirs.js), not hand-maintained here, so a newly added task is
// validated automatically and can never be silently omitted (issue #502). The
// extension manifest is the one fixed, non-task entry.

const fs = require('fs');
const path = require('path');
const { discoverTaskDirs } = require('./lib/task-dirs.js');

const files = [
    { path: 'azure-devops-extension.json', type: 'extension' },
    ...discoverTaskDirs(process.cwd()).map((dir) => ({ path: `${dir}/task.json`, type: 'task' })),
];

let hasError = false;

for (const file of files) {
    const fullPath = path.resolve(file.path);
    if (!fs.existsSync(fullPath)) {
        console.error(`FAIL: ${file.path} does not exist`);
        hasError = true;
        continue;
    }

    const json = JSON.parse(fs.readFileSync(fullPath, 'utf8'));

    if (file.type === 'extension') {
        const version = json.version;
        if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
            console.error(`FAIL: ${file.path} has invalid version: ${version}`);
            hasError = true;
        } else {
            console.log(`OK: ${file.path} version=${version}`);
        }
    } else {
        const v = json.version;
        if (!v || !v.Major || !v.Minor || v.Patch === undefined) {
            console.error(`FAIL: ${file.path} has missing version fields`);
            hasError = true;
        } else {
            console.log(`OK: ${file.path} version=${v.Major}.${v.Minor}.${v.Patch}`);
        }
    }
}

if (hasError) {
    process.exit(1);
}
console.log('All version checks passed.');
