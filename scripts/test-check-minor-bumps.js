#!/usr/bin/env node
// Self-test for check-minor-bumps.js: proves the release-time Minor-bump gate
// actually fires when a task's src/ changed without a Minor bump, stays quiet
// when the bump is present, and correctly auto-discovers the previous release
// tag (the newest v*.*.* tag not at HEAD, ignoring non-semver tags). A silent
// bug here would let a security fix ship to the Marketplace while ADO agents
// keep serving the cached old code (see check-minor-bumps.js's own header).
//
// Builds throwaway git repos in a scratch dir and runs the real
// check-minor-bumps.js against each via spawnSync (cwd = the throwaway repo, so
// the script's own `git` calls operate on it), mirroring the child-process
// style of the other self-tests. The scratch dir is removed afterwards either
// way.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'check-minor-bumps.js');

// A task present under the throwaway repo's Tasks/ tree, so check-minor-bumps.js
// (which derives its task list from that directory scan) actually examines a
// change to its src/. A second, unchanged task confirms untouched tasks never
// require a bump.
const CHANGED_TASK = 'Tasks/TerraformTask/TerraformTaskV5';
const UNCHANGED_TASK = 'Tasks/TerraformInstaller/TerraformInstallerV1';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-minor-bumps-selftest-'));
let failed = false;

function git(cwd, args) {
    return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initRepo(dir) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init -q');
    git(dir, 'config user.email test@example.com');
    git(dir, 'config user.name Test');
    git(dir, 'config commit.gpgsign false');
    git(dir, 'config tag.gpgsign false');
    git(dir, 'config core.autocrlf false');
    return dir;
}

function writeTask(repo, taskDir, minor, srcBody) {
    const abs = path.join(repo, taskDir);
    fs.mkdirSync(path.join(abs, 'src'), { recursive: true });
    fs.writeFileSync(
        path.join(abs, 'task.json'),
        JSON.stringify({ id: taskDir, version: { Major: 1, Minor: minor, Patch: 0 } }, null, 2),
    );
    fs.writeFileSync(path.join(abs, 'src', 'index.ts'), srcBody);
}

// Build a repo whose base commit carries both tasks at Minor=0 and is tagged
// v1.0.0 (plus an older v0.9.0 and a non-semver 'nightly' tag on the same base
// commit, to exercise the tag-regex filter + version sort). HEAD is left on the
// base commit; callers add the release commit.
function makeBaseRepo(name) {
    const repo = initRepo(path.join(scratchDir, name));
    writeTask(repo, CHANGED_TASK, 0, 'export const v = 1;\n');
    writeTask(repo, UNCHANGED_TASK, 0, 'export const v = 1;\n');
    git(repo, 'add -A');
    git(repo, 'commit -q -m base');
    git(repo, 'tag v0.9.0');
    git(repo, 'tag v1.0.0');
    git(repo, 'tag nightly'); // non-semver: must be ignored by the tag regex
    return repo;
}

// Writes (or overwrites) a task's package.json and package-lock.json for the
// #264 dependency-change cases. `lockPackages` entries are merged into the
// lockfile's `packages` map alongside the mandatory root ('') entry every
// real npm v2/v3 lockfile carries.
function writePackageFiles(repo, taskDir, { dependencies = {}, devDependencies = {}, lockPackages = {} } = {}) {
    const abs = path.join(repo, taskDir);
    fs.writeFileSync(
        path.join(abs, 'package.json'),
        JSON.stringify({ name: taskDir, version: '1.0.0', dependencies, devDependencies }, null, 2),
    );
    fs.writeFileSync(
        path.join(abs, 'package-lock.json'),
        JSON.stringify({ name: taskDir, lockfileVersion: 3, packages: { '': { name: taskDir }, ...lockPackages } }, null, 2),
    );
}

function runCheck(cwd, args = []) {
    return spawnSync(process.execPath, [scriptPath, ...args], { cwd, encoding: 'utf8' });
}

try {
    // --- Case 1: src changed AND Minor bumped -> exit 0, with prevRef
    // auto-discovered as v1.0.0 (newest semver tag not at HEAD; 'nightly'
    // filtered out, v0.9.0 sorted below v1.0.0). ---
    {
        const repo = makeBaseRepo('bump');
        writeTask(repo, CHANGED_TASK, 1, 'export const v = 2;\n'); // src changed + Minor 0->1
        git(repo, 'add -A');
        git(repo, 'commit -q -m bump');
        const res = runCheck(repo); // no args -> auto-discovery
        const out = `${res.stdout}${res.stderr}`;
        const ok = res.status === 0
            && out.includes('comparing v1.0.0 -> HEAD')
            && out.includes(`${CHANGED_TASK}: src changed, Minor 0 -> 1`);
        if (!ok) {
            console.error('FAIL: passing branch (src changed + Minor bumped, auto-discovered prevRef) did not exit 0 cleanly.');
            console.error(`status=${res.status}`, out);
            failed = true;
        } else {
            console.log('OK: exits 0 when a changed task has its Minor bumped (prevRef auto-discovered as v1.0.0).');
        }
    }

    // --- Case 2: src changed but Minor NOT bumped -> non-zero, naming the task. ---
    {
        const repo = makeBaseRepo('nobump');
        writeTask(repo, CHANGED_TASK, 0, 'export const v = 2;\n'); // src changed, Minor stays 0
        git(repo, 'add -A');
        git(repo, 'commit -q -m nobump');
        const res = runCheck(repo);
        const out = `${res.stdout}${res.stderr}`;
        const ok = res.status !== 0
            && out.includes(CHANGED_TASK)
            && out.includes('Minor did not increase');
        if (!ok) {
            console.error('FAIL: check-minor-bumps.js did not fail when src changed without a Minor bump.');
            console.error(`status=${res.status}`, out);
            failed = true;
        } else {
            console.log('OK: exits non-zero when a task src/ changed without a Minor bump.');
        }
    }

    // --- Case 3: no previous release tag at all -> "nothing to compare", exit 0. ---
    {
        const repo = initRepo(path.join(scratchDir, 'notag'));
        writeTask(repo, CHANGED_TASK, 0, 'export const v = 1;\n');
        git(repo, 'add -A');
        git(repo, 'commit -q -m only');
        const res = runCheck(repo); // no tags -> auto-discovery finds none
        const out = `${res.stdout}${res.stderr}`;
        const ok = res.status === 0 && out.includes('no previous release tag found');
        if (!ok) {
            console.error('FAIL: check-minor-bumps.js did not no-op cleanly when no previous release tag exists.');
            console.error(`status=${res.status}`, out);
            failed = true;
        } else {
            console.log('OK: exits 0 (nothing to compare) when no previous release tag exists.');
        }
    }

    // --- Case 4 (#676): a task.json-ONLY change (e.g. flipping a security-relevant
    // input's defaultValue) with NO src/ touch at all must still require a Minor
    // bump -- proves the diff scope covers task.json, not just src/. ---
    {
        const repo = makeBaseRepo('taskjson-only-nobump');
        // Same Minor (0), same src/ content as the base commit -- only task.json's
        // extra field differs, and src/ is never rewritten in this commit at all.
        fs.writeFileSync(
            path.join(repo, CHANGED_TASK, 'task.json'),
            JSON.stringify({ id: CHANGED_TASK, version: { Major: 1, Minor: 0, Patch: 0 }, requireGpgSignature: false }, null, 2),
        );
        git(repo, 'add -A');
        git(repo, 'commit -q -m "task.json-only change"');
        const res = runCheck(repo);
        const out = `${res.stdout}${res.stderr}`;
        const ok = res.status !== 0
            && out.includes(CHANGED_TASK)
            && out.includes('Minor did not increase');
        if (!ok) {
            console.error('FAIL: check-minor-bumps.js did not catch a task.json-only change without a Minor bump (#676).');
            console.error(`status=${res.status}`, out);
            failed = true;
        } else {
            console.log('OK: catches a task.json-only change (no src/ touch) without a Minor bump (#676).');
        }
    }

    // --- Case 5 (#264): package.json's PRODUCTION `dependencies` changed, with
    // no src/task.json touch and no Minor bump -> must still fail. ---
    {
        const repo = initRepo(path.join(scratchDir, 'pkgjson-prod-dep-nobump'));
        writeTask(repo, CHANGED_TASK, 0, 'export const v = 1;\n');
        writePackageFiles(repo, CHANGED_TASK, { dependencies: { 'some-lib': '1.0.0' } });
        git(repo, 'add -A');
        git(repo, 'commit -q -m base');
        git(repo, 'tag v1.0.0');
        writePackageFiles(repo, CHANGED_TASK, { dependencies: { 'some-lib': '1.1.0' } }); // prod dep bumped
        git(repo, 'add -A');
        git(repo, 'commit -q -m "bump some-lib"');
        const res = runCheck(repo);
        const out = `${res.stdout}${res.stderr}`;
        const ok = res.status !== 0
            && out.includes(CHANGED_TASK)
            && out.includes('Minor did not increase');
        if (!ok) {
            console.error('FAIL: check-minor-bumps.js did not catch a package.json `dependencies` change without a Minor bump (#264).');
            console.error(`status=${res.status}`, out);
            failed = true;
        } else {
            console.log('OK: catches a package.json `dependencies` change (no src/task.json touch) without a Minor bump (#264).');
        }
    }

    // --- Case 6 (#264): a devDependencies-ONLY package.json change must NOT
    // require a bump. ---
    {
        const repo = initRepo(path.join(scratchDir, 'pkgjson-devdep-exempt'));
        writeTask(repo, CHANGED_TASK, 0, 'export const v = 1;\n');
        writePackageFiles(repo, CHANGED_TASK, { dependencies: { 'some-lib': '1.0.0' }, devDependencies: { 'ts-node': '1.0.0' } });
        git(repo, 'add -A');
        git(repo, 'commit -q -m base');
        git(repo, 'tag v1.0.0');
        writePackageFiles(repo, CHANGED_TASK, { dependencies: { 'some-lib': '1.0.0' }, devDependencies: { 'ts-node': '2.0.0' } }); // dev-only bump
        git(repo, 'add -A');
        git(repo, 'commit -q -m "bump ts-node (dev only)"');
        const res = runCheck(repo);
        const out = `${res.stdout}${res.stderr}`;
        const ok = res.status === 0 && out.includes('comparing v1.0.0 -> HEAD');
        if (!ok) {
            console.error('FAIL: check-minor-bumps.js incorrectly required a bump for a devDependencies-only change (#264).');
            console.error(`status=${res.status}`, out);
            failed = true;
        } else {
            console.log('OK: a devDependencies-only package.json change does not require a Minor bump (#264).');
        }
    }

    // --- Case 7 (#264): package-lock.json's PRODUCTION entry resolved version
    // moves (package.json's own declared range unchanged, e.g. `npm update`
    // resolving a caret range forward) -> must still require a bump, proving
    // the check does not stop at package.json alone. ---
    {
        const repo = initRepo(path.join(scratchDir, 'lockfile-prod-entry-nobump'));
        writeTask(repo, CHANGED_TASK, 0, 'export const v = 1;\n');
        writePackageFiles(repo, CHANGED_TASK, {
            dependencies: { 'some-lib': '^1.0.0' },
            lockPackages: { 'node_modules/some-lib': { version: '1.0.0' } },
        });
        git(repo, 'add -A');
        git(repo, 'commit -q -m base');
        git(repo, 'tag v1.0.0');
        writePackageFiles(repo, CHANGED_TASK, {
            dependencies: { 'some-lib': '^1.0.0' }, // declared range unchanged
            lockPackages: { 'node_modules/some-lib': { version: '1.0.5' } }, // resolved version moved
        });
        git(repo, 'add -A');
        git(repo, 'commit -q -m "npm update resolves some-lib forward"');
        const res = runCheck(repo);
        const out = `${res.stdout}${res.stderr}`;
        const ok = res.status !== 0
            && out.includes(CHANGED_TASK)
            && out.includes('Minor did not increase');
        if (!ok) {
            console.error('FAIL: check-minor-bumps.js did not catch a lockfile-only production version bump without a Minor bump (#264).');
            console.error(`status=${res.status}`, out);
            failed = true;
        } else {
            console.log('OK: catches a package-lock.json production-entry version bump (package.json range unchanged) without a Minor bump (#264).');
        }
    }

    // --- Case 8 (#264): a dev-only package-lock.json entry's version change
    // must NOT require a bump. ---
    {
        const repo = initRepo(path.join(scratchDir, 'lockfile-dev-entry-exempt'));
        writeTask(repo, CHANGED_TASK, 0, 'export const v = 1;\n');
        writePackageFiles(repo, CHANGED_TASK, {
            devDependencies: { 'ts-node': '^1.0.0' },
            lockPackages: { 'node_modules/ts-node': { version: '1.0.0', dev: true } },
        });
        git(repo, 'add -A');
        git(repo, 'commit -q -m base');
        git(repo, 'tag v1.0.0');
        writePackageFiles(repo, CHANGED_TASK, {
            devDependencies: { 'ts-node': '^1.0.0' },
            lockPackages: { 'node_modules/ts-node': { version: '1.0.5', dev: true } }, // dev-only bump
        });
        git(repo, 'add -A');
        git(repo, 'commit -q -m "npm update resolves ts-node forward (dev only)"');
        const res = runCheck(repo);
        const out = `${res.stdout}${res.stderr}`;
        const ok = res.status === 0 && out.includes('comparing v1.0.0 -> HEAD');
        if (!ok) {
            console.error('FAIL: check-minor-bumps.js incorrectly required a bump for a dev-only lockfile entry change (#264).');
            console.error(`status=${res.status}`, out);
            failed = true;
        } else {
            console.log('OK: a package-lock.json dev-only entry version change does not require a Minor bump (#264).');
        }
    }
} finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
}

if (failed) {
    console.error('\ncheck-minor-bumps.js self-test: FAILED.');
    process.exit(1);
}
console.log('check-minor-bumps.js self-test: all cases passed.');
