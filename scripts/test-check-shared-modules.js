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

// `--fix` mode (#300): rewrites every non-canonical copy from its canonical
// source. Cases 7 and 8 below prove it actually repairs both family kinds and
// that it leaves a region host file's surrounding code untouched.
function runFix(cwd) {
    return spawnSync(process.execPath, [scriptPath, '--fix'], { cwd, encoding: 'utf8' });
}

// Read the text strictly between a region's markers, mirroring
// check-shared-modules.js's own extractRegion() closely enough to assert on
// exact region content after a --fix run.
function readRegion(file, region) {
    const lines = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
    const open = lines.findIndex(l => l.trimStart().startsWith(`// #region shared:${region}`));
    const close = lines.findIndex(l => l.trimStart().startsWith(`// #endregion shared:${region}`));
    if (open === -1 || close === -1 || close <= open) {
        return null;
    }
    return lines.slice(open + 1, close).join('\n');
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

    // Case 6: the truncateBody() region (#407). oci-token-exchange.ts carried a
    // variant of this helper that sat outside EVERY parity mechanism before
    // #407, so this case specifically diverges THAT copy: it is the one whose
    // drift previously could not be detected at all. Asserting on the exact
    // region name proves the failure comes from the TruncateBody comparison and
    // not from some unrelated family tripping first.
    fs.cpSync(path.join(repoRoot, 'Tasks'), path.join(scratchDir, 'Tasks'), { recursive: true });
    fs.cpSync(path.join(repoRoot, 'src'), path.join(scratchDir, 'src'), { recursive: true });
    const truncateTargetFile = path.join('Tasks', 'TerraformTask', 'TerraformTaskV5', 'src', 'oci-token-exchange.ts');
    const truncateScratchTarget = path.join(scratchDir, truncateTargetFile);
    const truncateEndMarker = '// #endregion shared:TruncateBody';
    const truncateOriginal = fs.readFileSync(truncateScratchTarget, 'utf8');
    // Weaken the bound the way a careless edit would: raise the cap only here.
    fs.writeFileSync(
        truncateScratchTarget,
        truncateOriginal.replace('max = 500', 'max = 50000'),
    );

    const truncateDivergedResult = runCheck(scratchDir);
    const truncateDivergedOutput = `${truncateDivergedResult.stdout}${truncateDivergedResult.stderr}`;
    if (truncateDivergedResult.status === 0 || !truncateDivergedOutput.includes("shared region 'TruncateBody' diverged")) {
        console.error('FAIL: check-shared-modules.js did not flag a diverged shared TruncateBody region.');
        console.error(truncateDivergedResult.stdout, truncateDivergedResult.stderr);
        failed = true;
    } else {
        console.log("OK: check-shared-modules.js exits non-zero when the truncateBody bound diverges in one transport.");
    }

    // Case 7 (--fix, #300): with BOTH a whole-file family copy and a region copy
    // deliberately diverged, `--fix` must rewrite each from its canonical source
    // so a subsequent plain check passes. Asserts on exact post-fix content, not
    // merely on a zero exit, so a --fix that "succeeded" by doing nothing (or by
    // rewriting the wrong direction) still fails this case.
    fs.cpSync(path.join(repoRoot, 'Tasks'), path.join(scratchDir, 'Tasks'), { recursive: true });
    fs.cpSync(path.join(repoRoot, 'src'), path.join(scratchDir, 'src'), { recursive: true });
    const fixFamilyTarget = path.join(scratchDir, targetFile);
    const fixFamilyCanonical = path.join(scratchDir, 'Tasks', 'TerraformInstaller', 'TerraformInstallerV1', 'src', 'http-client.ts');
    const canonicalFamilyContent = fs.readFileSync(fixFamilyCanonical, 'utf8');
    fs.appendFileSync(fixFamilyTarget, '\n// check-shared-modules --fix self-test divergence marker\n');

    const fixRegionTarget = path.join(scratchDir, truncateTargetFile);
    const fixRegionCanonicalFile = path.join(scratchDir, 'Tasks', 'TerraformModulePublish', 'TerraformModulePublishV1', 'src', 'https-client.ts');
    const canonicalRegionContent = readRegion(fixRegionCanonicalFile, 'TruncateBody');
    fs.writeFileSync(fixRegionTarget, fs.readFileSync(fixRegionTarget, 'utf8').replace('max = 500', 'max = 50000'));

    // Sanity: the tree really is broken before --fix runs, so a green result
    // below cannot come from having diverged nothing at all.
    if (runCheck(scratchDir).status === 0) {
        console.error('FAIL: self-test setup error — the tree was still clean before --fix ran.');
        failed = true;
    }

    const fixResult = runFix(scratchDir);
    const postFixCheck = runCheck(scratchDir);
    const repairedFamily = fs.readFileSync(fixFamilyTarget, 'utf8');
    const repairedRegion = readRegion(fixRegionTarget, 'TruncateBody');

    if (fixResult.status !== 0) {
        console.error('FAIL: check-shared-modules.js --fix exited non-zero.');
        console.error(fixResult.stdout, fixResult.stderr);
        failed = true;
    } else if (repairedFamily !== canonicalFamilyContent) {
        console.error('FAIL: --fix did not restore the whole-file family copy to the canonical bytes.');
        failed = true;
    } else if (repairedRegion !== canonicalRegionContent) {
        console.error('FAIL: --fix did not restore the shared region to the canonical bytes.');
        failed = true;
    } else if (postFixCheck.status !== 0) {
        console.error('FAIL: the parity gate still fails after --fix repaired every copy.');
        console.error(postFixCheck.stdout, postFixCheck.stderr);
        failed = true;
    } else {
        console.log('OK: --fix rewrites both a whole-file copy and a shared region from canonical.');
    }

    // Case 8 (--fix must not clobber a region host file): splicing a region back
    // into servicenow-http.ts/oci-token-exchange.ts must replace ONLY the text
    // between the markers. A --fix implemented as a whole-file copy would pass
    // case 7's region assertion while destroying the host file, so assert the
    // surrounding code — the file's own class, unique to it — survived.
    if (!fs.readFileSync(fixRegionTarget, 'utf8').includes('class OciTokenExchangeError')) {
        console.error('FAIL: --fix clobbered the region host file\'s surrounding code.');
        failed = true;
    } else {
        console.log('OK: --fix leaves a region host file\'s surrounding code intact.');
    }
} finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
}

if (failed) {
    console.error('\ncheck-shared-modules.js self-test: FAILED.');
    process.exit(1);
}
console.log('check-shared-modules.js self-test: all cases passed.');
