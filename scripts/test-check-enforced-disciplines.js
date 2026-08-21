#!/usr/bin/env node
// Table-driven self-test for scripts/check-enforced-disciplines.js — the
// signature for the "documented-but-unenforced discipline" defect class.
//
// The whole point of that signature is to make a rule fail loudly instead of
// depending on someone remembering it, so a signature that cannot itself be
// SEEN failing is the same defect one level up. Every row below builds a
// throwaway repo, violates exactly ONE discipline, and asserts the signature
// exits non-zero naming that site — and the baseline row asserts a fully
// compliant repo exits 0, so the rows are not passing because the script fails
// on everything.
//
// The fixture is a miniature of the real repo layout (Tasks/<Family>/<Version>/
// task.json + src + Tests, .github/workflows/{unit-test,pr-checks,release}.yml,
// scripts/check-minor-bumps.js), which is why one `mutate` function per row is
// enough to express a violation.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'check-enforced-disciplines.js');
const libPath = path.join(repoRoot, 'scripts', 'lib', 'task-dirs.js');
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-enforced-disciplines-selftest-'));

const TASK = 'Tasks/DemoTask/DemoTaskV1';
let failed = false;

function write(root, rel, content) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

/** A fixture repo in which every enumerated discipline is enforced. */
function makeCompliantRepo(name) {
    const root = path.join(scratchDir, name);
    // The signature requires its own scripts/lib/task-dirs.js next to it.
    write(root, 'scripts/check-enforced-disciplines.js', fs.readFileSync(scriptPath, 'utf8'));
    write(root, 'scripts/lib/task-dirs.js', fs.readFileSync(libPath, 'utf8'));
    write(root, 'scripts/check-minor-bumps.js', '// stub: presence is what the signature checks\n');
    write(root, 'scripts/bump-minor-versions.js', '// stub\n');
    write(root, 'scripts/publish-marketplace.js', '// stub\n');

    write(root, `${TASK}/task.json`, JSON.stringify({
        id: 'demo',
        version: { Major: 1, Minor: 2, Patch: 0 },
        execution: { Node24: { target: 'src/index.js' }, Node20_1: { target: 'src/index.js' } },
    }, null, 2));
    write(root, `${TASK}/src/index.ts`, 'export const demo = 1;\n');
    write(root, `${TASK}/.nycrc.json`, JSON.stringify({ exclude: ['src/**/*.d.ts'] }, null, 2));
    write(root, `${TASK}/Tests/EntryPointL0.ts`, "import '../src/index';\n");

    write(root, '.github/workflows/unit-test.yml', `---
name: CI
on:
  pull_request:
    branches: [main]
jobs:
  build-and-test-demo:
    name: Build and Test Demo
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ${TASK}
    steps:
      - uses: actions/setup-node@v0
        with:
          node-version: "24"
      - run: npm test
      - uses: actions/setup-node@v0
        with:
          node-version: "20"
      - run: node src/index.js
`);
    write(root, '.github/workflows/pr-checks.yml', `---
name: PR Checks
on:
  pull_request:
    branches: [main]
jobs:
  release-pr-minor-bumps:
    name: Release PR Minor Bumps
    runs-on: ubuntu-latest
    steps:
      - run: node scripts/check-minor-bumps.js
`);
    write(root, '.github/workflows/release-pr-minor-bumps.yml', `---
name: Auto-bump
on:
  pull_request:
    branches: [main]
jobs:
  auto-bump:
    name: Auto-bump
    runs-on: ubuntu-latest
    steps:
      - run: node scripts/bump-minor-versions.js
`);
    write(root, '.github/workflows/release.yml', `---
name: Release
on:
  push:
    tags:
      - 'v*'
jobs:
  guard:
    name: Guard
    runs-on: ubuntu-latest
    steps:
      - run: node scripts/check-minor-bumps.js
  publish-marketplace:
    name: Publish to VS Marketplace
    runs-on: ubuntu-latest
    environment: marketplace
    steps:
      - run: node scripts/publish-marketplace.js --vsix "$VSIX_FILE"
`);
    return root;
}

function runSignature(root) {
    const res = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-enforced-disciplines.js'), root], { encoding: 'utf8' });
    return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

function check(cond, okMsg, failMsg, extra) {
    if (cond) {
        console.log(`OK: ${okMsg}`);
    } else {
        console.error(`FAIL: ${failMsg}`);
        if (extra !== undefined) console.error(extra);
        failed = true;
    }
}

// Each row inverts ONE discipline. `expect` is a substring the failure output
// must contain, so a row cannot pass on an unrelated failure.
const CASES = [
    {
        name: 'entry-point-exercised',
        why: 'a task whose declared execution target no test ever loads',
        mutate: (root) => fs.rmSync(path.join(root, TASK, 'Tests', 'EntryPointL0.ts')),
        expect: 'the execution entry point is never loaded by any test',
    },
    {
        name: 'entry-point-in-coverage',
        why: 'a task that carves its entry point out of the coverage metric',
        mutate: (root) => write(root, `${TASK}/.nycrc.json`, JSON.stringify({ exclude: ['src/**/*.d.ts', 'src/index.js'] }, null, 2)),
        expect: 'excludes src/index.js from the coverage metric',
    },
    {
        name: 'execution-handler-exercised',
        why: 'a declared Node20_1 fallback handler that no CI job ever runs',
        mutate: (root) => {
            const p = path.join(root, '.github/workflows/unit-test.yml');
            fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('          node-version: "20"\n      - run: node src/index.js\n', ''));
        },
        // "test-workflow" rather than "unit-test.yml": the gate reads whichever
        // of unit-test.yml / ci.yml a repo keeps its task tests in.
        expect: 'declares the Node20_1 handler but no test-workflow job',
    },
    {
        name: 'minor-bump-enforced/script',
        why: 'the Minor-bump rule with no script implementing it',
        mutate: (root) => fs.rmSync(path.join(root, 'scripts', 'check-minor-bumps.js')),
        expect: 'scripts/check-minor-bumps.js must exist',
    },
    {
        name: 'minor-bump-enforced/auto-bump-workflow',
        why: 'the Minor bumps left to a human to apply on the Release PR',
        mutate: (root) => fs.rmSync(path.join(root, '.github/workflows/release-pr-minor-bumps.yml')),
        expect: 'must run scripts/bump-minor-versions.js on the Release PR',
    },
    {
        name: 'minor-bump-enforced/pr-merge-gate',
        why: 'a Release PR that can merge without the bumps',
        mutate: (root) => {
            const p = path.join(root, '.github/workflows/pr-checks.yml');
            fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('node scripts/check-minor-bumps.js', 'echo skip'));
        },
        expect: 'pr-checks.yml must run scripts/check-minor-bumps.js as a merge gate',
    },
    {
        name: 'minor-bump-enforced/tag-time-guard',
        why: 'a tag that can build and publish without the bumps',
        mutate: (root) => {
            const p = path.join(root, '.github/workflows/release.yml');
            fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('      - run: node scripts/check-minor-bumps.js\n', '      - run: echo skip\n'));
        },
        expect: 'release.yml must run scripts/check-minor-bumps.js before it builds',
    },
    {
        name: 'marketplace-publish-retry',
        why: 'a publish with no bounded retry (the v1.2.7 503 that burned a release)',
        mutate: (root) => {
            const p = path.join(root, '.github/workflows/release.yml');
            fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(
                '      - run: node scripts/publish-marketplace.js --vsix "$VSIX_FILE"',
                '      - run: ./node_modules/.bin/tfx extension publish --vsix "$VSIX_FILE" --auth-type pat',
            ));
        },
        expect: 'no bounded retry',
    },
    {
        name: 'marketplace-token-off-argv',
        why: 'the minted Entra token passed to tfx as a CLI argument',
        mutate: (root) => {
            const p = path.join(root, '.github/workflows/release.yml');
            fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(
                '      - run: node scripts/publish-marketplace.js --vsix "$VSIX_FILE"',
                '      - run: ./node_modules/.bin/tfx extension publish --vsix "$VSIX_FILE" --auth-type pat --token "$ENTRA_TOKEN"',
            ));
        },
        expect: 'passed as a CLI argument',
    },
];

try {
    // Baseline: a compliant fixture must PASS, or every row below is vacuous.
    {
        const root = makeCompliantRepo('compliant');
        const { status, out } = runSignature(root);
        check(status === 0, 'a fully compliant repo passes the signature', `the compliant baseline fixture failed (exit ${status})`, out);
    }

    for (const c of CASES) {
        const root = makeCompliantRepo(c.name.replace(/\//g, '-'));
        c.mutate(root);
        const { status, out } = runSignature(root);
        check(
            status !== 0 && out.includes(c.expect),
            `${c.name}: the signature fires on ${c.why}`,
            `${c.name}: expected a non-zero exit mentioning '${c.expect}', got exit ${status}`,
            out,
        );
    }

    // An empty universe must not pass silently: a signature that enumerates
    // nothing is indistinguishable from one that found no problems.
    {
        const root = path.join(scratchDir, 'no-tasks');
        write(root, 'scripts/check-enforced-disciplines.js', fs.readFileSync(scriptPath, 'utf8'));
        write(root, 'scripts/lib/task-dirs.js', fs.readFileSync(libPath, 'utf8'));
        const { status, out } = runSignature(root);
        check(
            status !== 0 && out.includes('empty universe'),
            'a repo with no task directories fails rather than trivially passing',
            `expected a non-zero exit on an empty universe, got exit ${status}`,
            out,
        );
    }
} finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
}

if (failed) {
    console.error('\ncheck-enforced-disciplines.js self-test: FAILED.');
    process.exit(1);
}
console.log('\ncheck-enforced-disciplines.js self-test: all cases passed.');
