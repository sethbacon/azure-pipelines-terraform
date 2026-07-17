#!/usr/bin/env node
// Meta-check for the task-list surfaces that are still HAND-MAINTAINED because
// they carry per-task metadata that cannot be derived from a directory scan:
//   - azure-devops-extension.json's `contributions` array (the task
//     contributions the packaged .vsix actually registers)
//   - .github/workflows/release.yml's per-task 'Generate SBOM for <Task>' steps
//   - .github/dependabot.yml's per-task npm `directory:` entries
// A forgotten entry in any one of them fails silently (a task added without a
// contribution never appears in the ADO task picker, one missing an SBOM step
// ships unattested, one missing a dependabot entry never gets dependency
// updates). This script parses all three plus the actual Tasks/*/*/ directory
// listing and asserts they agree.
//
// The other consumers of the task list — scripts/check-versions.js,
// scripts/check-minor-bumps.js, and package.json's deps/deps:prune/compile
// build steps — used to be hand-maintained too and were cross-checked here.
// They now DERIVE the list at runtime from the same Tasks/*/*/task.json scan
// (via scripts/lib/task-dirs.js and scripts/for-each-task.js), so they can no
// longer drift and are intentionally no longer cross-checked here (issue #502).

const fs = require('fs');
const path = require('path');
const { discoverTaskDirs } = require('./lib/task-dirs.js');

const repoRoot = path.resolve(__dirname, '..');

function readText(relPath) {
    return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
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

const canonical = discoverTaskDirs(repoRoot);
console.log(`Discovered ${canonical.length} task directories under Tasks/: ${canonical.join(', ')}`);

const sources = {
    "azure-devops-extension.json 'contributions'": taskDirsFromExtensionManifest(),
    ".github/workflows/release.yml 'Generate SBOM' steps": taskDirsFromReleaseSbom(),
    ".github/dependabot.yml 'directory' entries": taskDirsFromDependabot(),
};

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
console.log('check-task-list: all hand-maintained task lists agree.');
