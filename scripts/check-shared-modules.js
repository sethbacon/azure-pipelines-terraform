#!/usr/bin/env node
// Enforces a single effective source of truth for the security-critical modules
// that are intentionally duplicated between the two installer tasks. The embedded
// HashiCorp GPG public key, the signature verifier, and the HTTP client must stay
// byte-identical across tasks so a fix (e.g. the 2030 GPG key rotation) can never be
// applied to one copy and silently missed in the other. CI fails on any divergence.

const fs = require('fs');
const path = require('path');

// Tasks that carry the shared modules. The first entry is the canonical source;
// every other task's copy must match it exactly.
const TASK_SRC_DIRS = [
    'Tasks/TerraformInstaller/TerraformInstallerV1/src',
    'Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src',
];

// Modules that must remain identical across all of the dirs above.
const SHARED_MODULES = [
    'hashicorp-gpg-key.ts',
    'gpg-verifier.ts',
    'http-client.ts',
];

// Normalize line endings so a CRLF checkout never reads as drift; the bytes that
// matter (the key material, the verification logic) are still compared exactly.
function read(relDir, file) {
    const full = path.resolve(relDir, file);
    if (!fs.existsSync(full)) {
        return { ok: false, full };
    }
    return { ok: true, full, content: fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n') };
}

let hasError = false;
const [canonicalDir, ...otherDirs] = TASK_SRC_DIRS;

for (const file of SHARED_MODULES) {
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
            console.error(`FAIL: ${file} diverged between ${canonicalDir} and ${dir}`);
            console.error(`      reconcile both copies (canonical: ${base.full})`);
            hasError = true;
        } else {
            console.log(`OK: ${file} identical (${canonicalDir} == ${dir})`);
        }
    }
}

if (hasError) {
    process.exit(1);
}
console.log('All shared-module parity checks passed.');
