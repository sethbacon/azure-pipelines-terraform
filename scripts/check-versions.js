#!/usr/bin/env node
// Validates that version fields exist and are well-formed in all task manifests.

const fs = require('fs');
const path = require('path');

const files = [
    { path: 'azure-devops-extension.json', type: 'extension' },
    { path: 'Tasks/TerraformTask/TerraformTaskV5/task.json', type: 'task' },
    { path: 'Tasks/TerraformInstaller/TerraformInstallerV1/task.json', type: 'task' },
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
