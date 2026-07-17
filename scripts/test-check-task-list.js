#!/usr/bin/env node
// Self-test for check-task-list.js: proves the meta-gate that keeps the six
// hardcoded task lists (check-versions.js `files`, check-minor-bumps.js `TASKS`,
// package.json deps/prune/compile scripts, azure-devops-extension.json
// `contributions`, release.yml `Generate SBOM` steps, dependabot.yml
// `directory` entries) in agreement with the Tasks/ directory listing actually
// fails when a source drifts, and does NOT false-positive on the one legitimate
// duplication (two contributions pointing at the same task folder — the real
// `custom-terraform-release-task` carryover). A silent bug here would let a task
// silently drop out of a source (e.g. never get its version validated) while CI
// stays green.
//
// check-task-list.js resolves every source relative to its OWN directory
// (path.resolve(__dirname, '..')), NOT the cwd, so each case builds a small
// synthetic repo — a copy of the real script plus hand-written minimal sources —
// and runs THAT copy. The scratch dir is removed afterwards either way.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const realScript = path.join(repoRoot, 'scripts', 'check-task-list.js');

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-task-list-selftest-'));
let failed = false;

// The canonical task set every source agrees on in the passing case.
const CANONICAL = ['Tasks/Alpha/AlphaV1', 'Tasks/Beta/BetaV1', 'Tasks/Gamma/GammaV1'];

// Build a self-contained mini-repo under `caseDir`. Each source's task list can
// be overridden independently to model drift; anything omitted defaults to the
// canonical set. `taskDirs` is the Tasks/ ground truth discoverTaskDirs() reads.
function buildRepo(caseDir, opts = {}) {
    const taskDirs = opts.taskDirs || CANONICAL;
    const versionsTasks = opts.versionsTasks || CANONICAL;
    const minorTasks = opts.minorTasks || CANONICAL;
    const pkgTasks = opts.pkgTasks || CANONICAL;
    const contribDirs = opts.contribDirs || CANONICAL;
    const sbomTasks = opts.sbomTasks || CANONICAL;
    const dependabotTasks = opts.dependabotTasks || CANONICAL;

    fs.mkdirSync(path.join(caseDir, 'scripts'), { recursive: true });
    // The script under test, run from inside this synthetic repo.
    fs.copyFileSync(realScript, path.join(caseDir, 'scripts', 'check-task-list.js'));

    // Ground truth: Tasks/<Family>/<Version>/task.json for each task dir.
    for (const t of taskDirs) {
        const abs = path.join(caseDir, t);
        fs.mkdirSync(abs, { recursive: true });
        fs.writeFileSync(
            path.join(abs, 'task.json'),
            JSON.stringify({ id: t, version: { Major: 1, Minor: 0, Patch: 0 } }, null, 2),
        );
    }

    // scripts/check-versions.js — only the `files` entries matter to the parser.
    const versionsLines = versionsTasks.map((t) => `    { path: '${t}/task.json', type: 'task' },`).join('\n');
    fs.writeFileSync(
        path.join(caseDir, 'scripts', 'check-versions.js'),
        `const files = [\n    { path: 'azure-devops-extension.json', type: 'extension' },\n${versionsLines}\n];\n`,
    );

    // scripts/check-minor-bumps.js — only the TASKS array matters to the parser.
    const minorLines = minorTasks.map((t) => `  '${t}',`).join('\n');
    fs.writeFileSync(
        path.join(caseDir, 'scripts', 'check-minor-bumps.js'),
        `const TASKS = [\n${minorLines}\n];\n`,
    );

    // package.json — the deps:npm:* / deps:prune:* / compile:* script families.
    const scripts = {};
    pkgTasks.forEach((t, i) => {
        scripts[`deps:npm:t${i}`] = `npm --prefix ${t} ci --ignore-scripts`;
        scripts[`deps:prune:t${i}`] = `npm --prefix ${t} prune --omit=dev`;
        scripts[`compile:t${i}`] = `tsc -b ${t}/tsconfig.json`;
    });
    fs.writeFileSync(path.join(caseDir, 'package.json'), JSON.stringify({ scripts }, null, 2));

    // azure-devops-extension.json — task contributions naming each dir.
    const contributions = contribDirs.map((t, i) => ({
        id: `task-${i}`,
        type: 'ms.vss-distributed-task.task',
        properties: { name: t },
    }));
    fs.writeFileSync(path.join(caseDir, 'azure-devops-extension.json'), JSON.stringify({ contributions }, null, 2));

    // .github/workflows/release.yml — one 'Generate SBOM for <Task>' step per
    // task (keyed off its `cd Tasks/...` line) plus a non-task 'Generate SBOM
    // for tab' step that must be ignored (no `cd Tasks/...`).
    fs.mkdirSync(path.join(caseDir, '.github', 'workflows'), { recursive: true });
    const sbomSteps = sbomTasks
        .map(
            (t, i) => `      - name: Generate SBOM for T${i}\n        run: |\n          cd ${t}\n          npm ci --omit=dev --ignore-scripts\n`,
        )
        .join('');
    fs.writeFileSync(
        path.join(caseDir, '.github', 'workflows', 'release.yml'),
        `jobs:\n  sbom-and-sign:\n    steps:\n${sbomSteps}      - name: Generate SBOM for tab\n        run: npx --no-install cyclonedx-npm --output-file sbom-tab.cdx.json\n`,
    );

    // .github/dependabot.yml — one npm update entry per task
    // (`directory: "/Tasks/..."`) plus the non-task github-actions and root-npm
    // entries (`directory: "/"`) that must be ignored.
    const dependabotEntries = dependabotTasks
        .map(
            (t) => `  - package-ecosystem: "npm"\n    directory: "/${t}"\n    schedule:\n      interval: "weekly"\n`,
        )
        .join('');
    fs.writeFileSync(
        path.join(caseDir, '.github', 'dependabot.yml'),
        `version: 2\nupdates:\n  - package-ecosystem: "github-actions"\n    directory: "/"\n    schedule:\n      interval: "weekly"\n${dependabotEntries}  - package-ecosystem: "npm"\n    directory: "/"\n    schedule:\n      interval: "weekly"\n`,
    );

    return caseDir;
}

function runCheck(caseDir) {
    return spawnSync(process.execPath, [path.join(caseDir, 'scripts', 'check-task-list.js')], { encoding: 'utf8' });
}

let caseCounter = 0;
function makeCaseDir() {
    caseCounter += 1;
    const dir = path.join(scratchDir, `case-${caseCounter}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

try {
    // --- Case 1: every source agrees -> exit 0. ---
    {
        const dir = buildRepo(makeCaseDir());
        const res = runCheck(dir);
        const out = `${res.stdout}${res.stderr}`;
        if (res.status !== 0 || !out.includes('all task lists agree')) {
            console.error('FAIL: check-task-list.js did not pass when every source agrees.');
            console.error(`status=${res.status}`, out);
            failed = true;
        } else {
            console.log('OK: exits 0 when all task-list sources agree.');
        }
    }

    // --- Case 2: a source (check-versions.js `files`) is missing a task -> fail. ---
    {
        const dir = buildRepo(makeCaseDir(), { versionsTasks: CANONICAL.slice(1) });
        const res = runCheck(dir);
        const out = `${res.stdout}${res.stderr}`;
        if (res.status === 0 || !out.includes("check-versions.js 'files'")) {
            console.error('FAIL: check-task-list.js did not flag a source missing a task.');
            console.error(`status=${res.status}`, out);
            failed = true;
        } else {
            console.log('OK: exits non-zero when a source (check-versions files) is missing a task.');
        }
    }

    // --- Case 3: the contributions source is missing an entry -> fail. ---
    {
        const dir = buildRepo(makeCaseDir(), { contribDirs: CANONICAL.slice(1) });
        const res = runCheck(dir);
        const out = `${res.stdout}${res.stderr}`;
        if (res.status === 0 || !out.includes("'contributions'")) {
            console.error('FAIL: check-task-list.js did not flag the contributions source missing an entry.');
            console.error(`status=${res.status}`, out);
            failed = true;
        } else {
            console.log('OK: exits non-zero when the contributions source is missing an entry.');
        }
    }

    // --- Case 4: a legitimate DUPLICATE contribution (two contributions pointing
    // at the same task folder, like the real custom-terraform-release-task
    // carryover) must NOT false-positive: the check dedupes contribution dirs. ---
    {
        const dir = buildRepo(makeCaseDir(), { contribDirs: [...CANONICAL, CANONICAL[0]] });
        const res = runCheck(dir);
        const out = `${res.stdout}${res.stderr}`;
        if (res.status !== 0 || !out.includes('all task lists agree') || out.includes('FAIL')) {
            console.error('FAIL: check-task-list.js false-positived on a legitimate duplicate contribution.');
            console.error(`status=${res.status}`, out);
            failed = true;
        } else {
            console.log('OK: exits 0 (no false positive) on a legitimate duplicate contribution.');
        }
    }

    // --- Case 5: release.yml is missing a task's SBOM step -> fail. ---
    {
        const dir = buildRepo(makeCaseDir(), { sbomTasks: CANONICAL.slice(1) });
        const res = runCheck(dir);
        const out = `${res.stdout}${res.stderr}`;
        if (res.status === 0 || !out.includes('release.yml')) {
            console.error('FAIL: check-task-list.js did not flag release.yml missing a task SBOM step.');
            console.error(`status=${res.status}`, out);
            failed = true;
        } else {
            console.log('OK: exits non-zero when release.yml is missing a task SBOM step.');
        }
    }

    // --- Case 6: dependabot.yml is missing a task directory -> fail. ---
    {
        const dir = buildRepo(makeCaseDir(), { dependabotTasks: CANONICAL.slice(1) });
        const res = runCheck(dir);
        const out = `${res.stdout}${res.stderr}`;
        if (res.status === 0 || !out.includes('dependabot.yml')) {
            console.error('FAIL: check-task-list.js did not flag dependabot.yml missing a task directory.');
            console.error(`status=${res.status}`, out);
            failed = true;
        } else {
            console.log('OK: exits non-zero when dependabot.yml is missing a task directory.');
        }
    }
} finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
}

if (failed) {
    console.error('\ncheck-task-list.js self-test: FAILED.');
    process.exit(1);
}
console.log('check-task-list.js self-test: all cases passed.');
