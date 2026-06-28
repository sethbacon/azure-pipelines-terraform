#!/usr/bin/env node
// Enforces a single effective source of truth for the security-critical modules
// that are intentionally duplicated across tasks. Each "family" lists a set of
// task src dirs that must carry byte-identical copies of the named modules, so a
// fix (e.g. the 2030 GPG key rotation, or the credential-bearing https-pin guard)
// can never be applied to one copy and silently missed in the other. CI fails on
// any divergence.

const fs = require('fs');
const path = require('path');

// Each family: the first dir is the canonical source; every other dir's copy of
// each listed module must match it exactly.
const FAMILIES = [
    {
        // Installer download trust chain: embedded HashiCorp GPG key, the signature
        // verifier, and the raw HTTP client shared by the two installer tasks.
        dirs: [
            'Tasks/TerraformInstaller/TerraformInstallerV1/src',
            'Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src',
        ],
        modules: [
            'hashicorp-gpg-key.ts',
            'gpg-verifier.ts',
            'http-client.ts',
        ],
    },
    {
        // Credential-bearing HTTPS transport (https-pin guard + socket timeout +
        // body truncation) shared by the registry module publish (API key) and the
        // drift callback (TSM token).
        dirs: [
            'Tasks/TerraformModulePublish/TerraformModulePublishV1/src',
            'Tasks/TerraformDriftReport/TerraformDriftReportV1/src',
        ],
        modules: [
            'https-client.ts',
        ],
    },
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

for (const { dirs, modules } of FAMILIES) {
    const [canonicalDir, ...otherDirs] = dirs;
    for (const file of modules) {
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
}

if (hasError) {
    process.exit(1);
}
console.log('All shared-module parity checks passed.');
