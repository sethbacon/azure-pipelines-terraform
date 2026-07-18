#!/usr/bin/env node
// Self-test for bump-minor-versions.js: proves the release-time auto-bump edits
// exactly the tasks whose src/ changed since the previous release without a Minor
// increase, leaves everything else byte-for-byte untouched, preserves each file's
// existing quoting (string vs bare number), is idempotent, and never
// double-bumps a task already bumped since the previous release. A bug here would
// either miss a bump (a fix reaches the Marketplace but not running agents, which
// cache by Major.Minor) or double-bump (Minor drifts ahead of reality).
//
// Builds throwaway git repos in a scratch dir and runs the real
// bump-minor-versions.js against each via spawnSync (cwd = the throwaway repo, so
// both its git analysis and its task.json reads/writes operate on that repo),
// mirroring the child-process style of the other self-tests. The scratch dir is
// removed afterwards either way.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'bump-minor-versions.js');

// All three live under the throwaway repo's Tasks/ tree, so bump-minor-versions.js
// (via check-minor-bumps.js's directory-derived task list) actually examines
// their src/ changes.
const CHANGED_TASK = 'Tasks/TerraformTask/TerraformTaskV5';
const UNCHANGED_TASK = 'Tasks/TerraformInstaller/TerraformInstallerV1';
const BARE_TASK = 'Tasks/TerraformProviderMirror/TerraformProviderMirrorV1';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bump-minor-versions-selftest-'));
let failed = false;

function check(cond, okMsg, failMsg, extra) {
    if (cond) {
        console.log(`OK: ${okMsg}`);
    } else {
        console.error(`FAIL: ${failMsg}`);
        if (extra !== undefined) {
            console.error(extra);
        }
        failed = true;
    }
}

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

// A realistic task.json (4-space indent, Major/Minor/Patch), with either quoted
// string version fields (the repo's actual format, the CRITICAL case for
// byte-preservation) or bare numbers (the other shape the bumper must handle).
function taskJsonText(minor, quoted) {
    const major = quoted ? '"1"' : '1';
    const min = quoted ? `"${minor}"` : `${minor}`;
    const patch = quoted ? '"0"' : '0';
    return [
        '{',
        '    "id": "example-task",',
        '    "name": "Example",',
        '    "friendlyName": "Example Task",',
        '    "version": {',
        `        "Major": ${major},`,
        `        "Minor": ${min},`,
        `        "Patch": ${patch}`,
        '    },',
        '    "minimumAgentVersion": "4.265.1"',
        '}',
        '',
    ].join('\n');
}

function writeTask(repo, taskDir, jsonText, srcBody) {
    const abs = path.join(repo, taskDir);
    fs.mkdirSync(path.join(abs, 'src'), { recursive: true });
    fs.writeFileSync(path.join(abs, 'task.json'), jsonText);
    fs.writeFileSync(path.join(abs, 'src', 'index.ts'), srcBody);
}

function writeSrc(repo, taskDir, body) {
    fs.writeFileSync(path.join(repo, taskDir, 'src', 'index.ts'), body);
}

function writeTaskJson(repo, taskDir, jsonText) {
    fs.writeFileSync(path.join(repo, taskDir, 'task.json'), jsonText);
}

function readTaskJson(repo, taskDir) {
    return fs.readFileSync(path.join(repo, taskDir, 'task.json'), 'utf8');
}

function readMinor(repo, taskDir) {
    return parseInt(JSON.parse(readTaskJson(repo, taskDir)).version.Minor, 10);
}

function runBump(cwd, args = []) {
    return spawnSync(process.execPath, [scriptPath, ...args], { cwd, encoding: 'utf8' });
}

// Base repo carrying the given tasks at their initial Minor, committed and tagged
// v1.0.0 (plus an older v0.9.0 and a non-semver 'nightly' tag on the same commit,
// to exercise the tag-regex filter + version sort in prevRef auto-discovery).
// HEAD is left on the base commit; callers add the change commit.
function makeBaseRepo(name, tasks) {
    const repo = initRepo(path.join(scratchDir, name));
    for (const t of tasks) {
        writeTask(repo, t.dir, taskJsonText(t.minor, t.quoted), 'export const v = 1;\n');
    }
    git(repo, 'add -A');
    git(repo, 'commit -q -m base');
    git(repo, 'tag v0.9.0');
    git(repo, 'tag v1.0.0');
    git(repo, 'tag nightly'); // non-semver: must be ignored by the tag regex
    return repo;
}

try {
    // --- Case (a): bumps exactly the changed task; leaves unchanged tasks alone.
    // Also serves as the fixture for the idempotency check (b). ---
    const repoA = makeBaseRepo('bump-basic', [
        { dir: CHANGED_TASK, minor: 5, quoted: true },
        { dir: UNCHANGED_TASK, minor: 5, quoted: true },
    ]);
    const unchangedBefore = readTaskJson(repoA, UNCHANGED_TASK);
    // Change only CHANGED_TASK's src (no Minor bump), commit.
    writeSrc(repoA, CHANGED_TASK, 'export const v = 2;\n');
    git(repoA, 'add -A');
    git(repoA, 'commit -q -m change');

    const resA = runBump(repoA); // no args -> prevRef auto-discovered as v1.0.0
    const outA = `${resA.stdout}${resA.stderr}`;
    check(
        resA.status === 0 && outA.includes(`bumped ${CHANGED_TASK}: Minor 5 -> 6`),
        'bumps the changed task (Minor 5 -> 6), exit 0, prevRef auto-discovered.',
        'expected a clean bump of the changed task from Minor 5 to 6.',
        `status=${resA.status}\n${outA}`,
    );
    check(
        readMinor(repoA, CHANGED_TASK) === 6,
        'changed task task.json now reads Minor 6.',
        `changed task Minor should be 6 but is ${readMinor(repoA, CHANGED_TASK)}.`,
    );
    check(
        readMinor(repoA, UNCHANGED_TASK) === 5 && readTaskJson(repoA, UNCHANGED_TASK) === unchangedBefore,
        'unchanged task is left byte-for-byte untouched.',
        'unchanged task task.json was modified but should not have been.',
    );

    // --- Case (c) (byte preservation) reuses repoA's post-bump changed file: the
    // ONLY difference from the pre-bump bytes is the Minor digit; quoting + all
    // other bytes are preserved. ---
    const changedAfterA = readTaskJson(repoA, CHANGED_TASK);
    const changedBeforeA = taskJsonText(5, true); // what was committed
    check(
        changedAfterA === changedBeforeA.replace('"Minor": "5"', '"Minor": "6"'),
        'quoted-string version fields are preserved byte-for-byte except the bumped number.',
        'the bumped file differs from the original by more than just the Minor digit (quoting/formatting drift).',
        `before:\n${JSON.stringify(changedBeforeA)}\nafter:\n${JSON.stringify(changedAfterA)}`,
    );

    // --- Case (b): idempotent second run makes no further change. ---
    const changedSnapshot = readTaskJson(repoA, CHANGED_TASK);
    const resB = runBump(repoA);
    const outB = `${resB.stdout}${resB.stderr}`;
    check(
        resB.status === 0 && outB.includes('no tasks needed a Minor bump'),
        'second run is a no-op (exit 0, "no tasks needed a Minor bump").',
        'second run did not report a clean no-op.',
        `status=${resB.status}\n${outB}`,
    );
    check(
        readTaskJson(repoA, CHANGED_TASK) === changedSnapshot && readMinor(repoA, CHANGED_TASK) === 6,
        'second run left the already-bumped task.json unchanged (still Minor 6).',
        'second run changed the task.json again (double-bump).',
    );

    // --- Case (c, bare numbers): a task using bare-number version fields keeps
    // bare numbers after the bump (no quotes introduced). ---
    const repoC = makeBaseRepo('bump-bare', [
        { dir: BARE_TASK, minor: 8, quoted: false },
    ]);
    writeSrc(repoC, BARE_TASK, 'export const v = 2;\n');
    git(repoC, 'add -A');
    git(repoC, 'commit -q -m change');
    const bareBefore = taskJsonText(8, false);
    const resC = runBump(repoC);
    const outC = `${resC.stdout}${resC.stderr}`;
    const bareAfter = readTaskJson(repoC, BARE_TASK);
    check(
        resC.status === 0
        && bareAfter === bareBefore.replace('"Minor": 8', '"Minor": 9')
        && bareAfter.includes('"Minor": 9')
        && !bareAfter.includes('"Minor": "9"'),
        'bare-number version fields stay bare after the bump (no quoting introduced).',
        'bare-number task.json was not preserved (typing changed or wrong value).',
        `status=${resC.status}\nafter:\n${JSON.stringify(bareAfter)}`,
    );

    // --- Case (d): a task already manually bumped since prevRef is NOT
    // double-bumped (documented double-increment protection). ---
    const repoD = makeBaseRepo('bump-already', [
        { dir: CHANGED_TASK, minor: 0, quoted: true },
    ]);
    // Change src AND bump the Minor to 1 in the same commit (as a feature PR would).
    writeSrc(repoD, CHANGED_TASK, 'export const v = 2;\n');
    writeTaskJson(repoD, CHANGED_TASK, taskJsonText(1, true));
    git(repoD, 'add -A');
    git(repoD, 'commit -q -m "change + manual bump"');
    const resD = runBump(repoD);
    const outD = `${resD.stdout}${resD.stderr}`;
    check(
        resD.status === 0
        && outD.includes('no tasks needed a Minor bump')
        && !outD.includes(`bumped ${CHANGED_TASK}`)
        && readMinor(repoD, CHANGED_TASK) === 1,
        'a task already bumped since prevRef is not double-bumped (stays Minor 1).',
        'an already-bumped task was bumped again (double-increment).',
        `status=${resD.status}\n${outD}`,
    );
} finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
}

if (failed) {
    console.error('\nbump-minor-versions.js self-test: FAILED.');
    process.exit(1);
}
console.log('bump-minor-versions.js self-test: all cases passed.');
