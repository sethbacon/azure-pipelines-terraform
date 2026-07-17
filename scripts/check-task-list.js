#!/usr/bin/env node
// Meta-check: the 11-task list is hardcoded independently in six places --
// scripts/check-versions.js's `files` array, scripts/check-minor-bumps.js's
// `TASKS` array, package.json's deps/deps:prune/compile script families,
// azure-devops-extension.json's `contributions` array (the task contributions
// the packaged .vsix actually registers), .github/workflows/release.yml's
// per-task 'Generate SBOM for <Task>' steps, and .github/dependabot.yml's
// per-task npm `directory:` entries -- with none of them derived from a single
// manifest. A forgotten entry in any one of them currently fails silently (e.g.
// a 12th task added without updating check-versions.js's `files[]` never gets
// its version validated, one added without a contribution simply never appears
// in the ADO task picker, one missing an SBOM step ships unattested, and one
// missing a dependabot entry never gets dependency updates). This script parses
// all six sources plus the actual Tasks/*/*/ directory listing and asserts they
// all agree.

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

function readText(relPath) {
    return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

// Ground truth: every immediate subdirectory of Tasks/<Family>/ that
// contains a task.json.
function discoverTaskDirs() {
    const dirs = [];
    const familyRoot = path.join(repoRoot, 'Tasks');
    for (const family of fs.readdirSync(familyRoot, { withFileTypes: true })) {
        if (!family.isDirectory()) continue;
        const familyPath = path.join(familyRoot, family.name);
        for (const version of fs.readdirSync(familyPath, { withFileTypes: true })) {
            if (!version.isDirectory()) continue;
            const taskJson = path.join(familyPath, version.name, 'task.json');
            if (fs.existsSync(taskJson)) {
                dirs.push(`Tasks/${family.name}/${version.name}`);
            }
        }
    }
    return dirs.sort();
}

// scripts/check-versions.js: `{ path: 'Tasks/.../task.json', type: 'task' },`
function taskDirsFromCheckVersions() {
    const text = readText('scripts/check-versions.js');
    const dirs = [];
    const re = /path:\s*'([^']+)\/task\.json'\s*,\s*type:\s*'task'/g;
    let m;
    while ((m = re.exec(text))) {
        dirs.push(m[1]);
    }
    return dirs.sort();
}

// scripts/check-minor-bumps.js: `const TASKS = [ 'Tasks/...', ... ];`
function taskDirsFromMinorBumps() {
    const text = readText('scripts/check-minor-bumps.js');
    const arrayMatch = text.match(/const TASKS = \[([\s\S]*?)\];/);
    if (!arrayMatch) {
        throw new Error('check-task-list: could not find a TASKS array in check-minor-bumps.js');
    }
    return [...arrayMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

// package.json: each npm-script family (deps:npm:*, deps:prune:*, compile:*)
// should reference the exact same set of task dirs.
function taskDirsFromPackageJson() {
    const pkg = JSON.parse(readText('package.json'));
    const families = {
        'deps:npm': /--prefix\s+(Tasks\/\S+)\s+ci\b/,
        'deps:prune': /--prefix\s+(Tasks\/\S+)\s+prune\b/,
        compile: /tsc -b (Tasks\/\S+)\/tsconfig\.json/,
    };
    const result = {};
    for (const [prefix, re] of Object.entries(families)) {
        const dirs = [];
        for (const [name, cmd] of Object.entries(pkg.scripts)) {
            if (!name.startsWith(`${prefix}:`)) continue;
            const m = cmd.match(re);
            if (m) dirs.push(m[1]);
        }
        result[prefix] = dirs.sort();
    }
    return result;
}

// azure-devops-extension.json: every contribution of type
// 'ms.vss-distributed-task.task' names a task dir via properties.name.
// Two contribution ids may legitimately point at the SAME task dir (the
// legacy 'custom-terraform-release-task' id is a cosmetic carryover targeting
// the same TerraformTaskV5 folder as any newer id would — see CLAUDE.md's
// task.json schema notes), so compare the deduplicated set of dirs, not the
// contribution count.
function taskDirsFromExtensionManifest() {
    const manifest = JSON.parse(readText('azure-devops-extension.json'));
    const dirs = (manifest.contributions || [])
        .filter((c) => c.type === 'ms.vss-distributed-task.task')
        .map((c) => c.properties && c.properties.name)
        .filter(Boolean);
    return [...new Set(dirs)].sort();
}

// .github/workflows/release.yml: the sbom-and-sign job has one 'Generate SBOM
// for <Task>' step per task, each running `cd Tasks/<Family>/<Task>` before its
// `npm ci`/cyclonedx scan. The 'Generate SBOM for tab' step scans the repo-root
// bundle and has no `cd Tasks/...` line, so keying off `cd Tasks/...` naturally
// excludes it (and any future non-task SBOM step).
function taskDirsFromReleaseSbom() {
    const text = readText('.github/workflows/release.yml');
    const re = /cd (Tasks\/\S+)/g;
    const dirs = [];
    let m;
    while ((m = re.exec(text))) {
        dirs.push(m[1]);
    }
    return dirs.sort();
}

// .github/dependabot.yml: each per-task npm update entry sets
// `directory: "/Tasks/<Family>/<Task>"`. The github-actions and root-npm entries
// use `directory: "/"`, so filtering to /Tasks/ paths selects exactly the tasks
// (and ignores the non-task ecosystems). The leading slash is dropped to match
// the Tasks/... form every other source uses.
function taskDirsFromDependabot() {
    const text = readText('.github/dependabot.yml');
    const re = /directory:\s*"(\/Tasks\/[^"]+)"/g;
    const dirs = [];
    let m;
    while ((m = re.exec(text))) {
        dirs.push(m[1].replace(/^\//, ''));
    }
    return dirs.sort();
}

function setsEqual(a, b) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
}

function reportDiff(label, actual, expected) {
    const missing = expected.filter((d) => !actual.includes(d));
    const extra = actual.filter((d) => !expected.includes(d));
    if (missing.length) console.error(`  ${label}: missing ${JSON.stringify(missing)}`);
    if (extra.length) console.error(`  ${label}: unexpected extra ${JSON.stringify(extra)}`);
}

const canonical = discoverTaskDirs();
console.log(`Discovered ${canonical.length} task directories under Tasks/: ${canonical.join(', ')}`);

const sources = {
    "scripts/check-versions.js 'files'": taskDirsFromCheckVersions(),
    "scripts/check-minor-bumps.js 'TASKS'": taskDirsFromMinorBumps(),
    "azure-devops-extension.json 'contributions'": taskDirsFromExtensionManifest(),
    ".github/workflows/release.yml 'Generate SBOM' steps": taskDirsFromReleaseSbom(),
    ".github/dependabot.yml 'directory' entries": taskDirsFromDependabot(),
};

const pkgFamilies = taskDirsFromPackageJson();
for (const [family, dirs] of Object.entries(pkgFamilies)) {
    sources[`package.json '${family}:*' scripts`] = dirs;
}

let hasError = false;
for (const [label, dirs] of Object.entries(sources)) {
    if (!setsEqual(dirs, canonical)) {
        console.error(`FAIL: ${label} does not match the Tasks/ directory listing.`);
        reportDiff(label, dirs, canonical);
        hasError = true;
    } else {
        console.log(`OK: ${label} matches the Tasks/ directory listing (${dirs.length} tasks).`);
    }
}

if (hasError) {
    process.exit(1);
}
console.log('check-task-list: all task lists agree.');
