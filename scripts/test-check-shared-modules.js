#!/usr/bin/env node
// Self-test for check-shared-modules.js: confirms the shared-module parity
// gate actually catches drift, and doesn't cry wolf on a clean tree. This is
// the guard that protects the security-critical duplicated installer/HTTPS
// modules (see check-shared-modules.js's own header comment); a silent bug
// in its own FAMILIES list or diff logic would otherwise pass CI while
// verifying nothing.
//
// Runs check-shared-modules.js five times against a scratch copy of Tasks/
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
//   4. the shared ProxyTunnelAgent REGION (a marked block inside a file that is
//      NOT a whole-file copy — servicenow-http.ts) diverged inside its markers
//      -> must exit non-zero, proving the REGION_FAMILIES comparison is wired in.
//   5. a region marker deleted from one copy -> must exit non-zero (fail closed):
//      a removed marker must be a hard failure, never a silently skipped check.
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

// Escape a literal string for safe interpolation into a RegExp.
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

    // Case 4: reset to a fully clean tree, then diverge ONLY the shared
    // ProxyTunnelAgent REGION inside the ServiceNow transport (servicenow-http.ts
    // is gated solely by REGION_FAMILIES, not any whole-file family) by inserting
    // a line between its markers. With the tree otherwise pristine, a non-zero
    // exit here can only come from the region comparison.
    fs.cpSync(path.join(repoRoot, 'Tasks'), path.join(scratchDir, 'Tasks'), { recursive: true });
    fs.cpSync(path.join(repoRoot, 'src'), path.join(scratchDir, 'src'), { recursive: true });
    const regionTargetFile = path.join('Tasks', 'PublishKbArticle', 'PublishKbArticleV1', 'src', 'servicenow-http.ts');
    const regionScratchTarget = path.join(scratchDir, regionTargetFile);
    const regionEndMarker = '// #endregion shared:ProxyTunnelAgent';

    const regionOriginal = fs.readFileSync(regionScratchTarget, 'utf8');
    fs.writeFileSync(
        regionScratchTarget,
        regionOriginal.replace(regionEndMarker, `        // check-shared-modules self-test region divergence\r\n${regionEndMarker}`),
    );

    const regionDivergedResult = runCheck(scratchDir);
    const regionDivergedOutput = `${regionDivergedResult.stdout}${regionDivergedResult.stderr}`;
    if (regionDivergedResult.status === 0 || !regionDivergedOutput.includes("shared region 'ProxyTunnelAgent' diverged")) {
        console.error('FAIL: check-shared-modules.js did not flag a diverged shared ProxyTunnelAgent region.');
        console.error(regionDivergedResult.stdout, regionDivergedResult.stderr);
        failed = true;
    } else {
        console.log("OK: check-shared-modules.js exits non-zero when a shared region's content diverges.");
    }

    // Case 5 (fail closed): reset, then DELETE the #endregion marker from the
    // ServiceNow copy. A removed marker must be a hard failure, never a silently
    // skipped check — otherwise deleting a marker would disable the gate unseen.
    fs.cpSync(path.join(repoRoot, 'Tasks'), path.join(scratchDir, 'Tasks'), { recursive: true });
    fs.cpSync(path.join(repoRoot, 'src'), path.join(scratchDir, 'src'), { recursive: true });
    const regionClean = fs.readFileSync(regionScratchTarget, 'utf8');
    // Remove the marker line plus its trailing newline, tolerating either CRLF
    // (Windows working tree) or LF (ubuntu-latest CI checkout) endings — a
    // hardcoded `\r\n` would be a no-op on an LF checkout, leaving the marker in
    // place so the gate never fails closed and this self-test case flips red.
    fs.writeFileSync(
        regionScratchTarget,
        regionClean.replace(new RegExp(`${escapeRegExp(regionEndMarker)}\\r?\\n`), ''),
    );

    const missingMarkerResult = runCheck(scratchDir);
    const missingMarkerOutput = `${missingMarkerResult.stdout}${missingMarkerResult.stderr}`;
    if (missingMarkerResult.status === 0 || !missingMarkerOutput.includes(regionEndMarker)) {
        console.error('FAIL: check-shared-modules.js did not fail closed when a region marker was deleted.');
        console.error(missingMarkerResult.stdout, missingMarkerResult.stderr);
        failed = true;
    } else {
        console.log('OK: check-shared-modules.js fails closed when a shared-region marker is deleted.');
    }
} finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
}

if (failed) {
    console.error('\ncheck-shared-modules.js self-test: FAILED.');
    process.exit(1);
}
console.log('check-shared-modules.js self-test: all cases passed.');
