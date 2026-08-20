#!/usr/bin/env node
// Mutation self-test for the "Breaking-change footers survive the squash" job
// in .github/workflows/pr-checks.yml (#966).
//
// Same contract as every other self-test in scripts/, and the reason this one
// exists at all: that guard is a shell script embedded in YAML. actionlint
// checks its syntax, zizmor checks the workflow around it, and nothing runs
// it. It was ported from terraform-registry-backend by way of
// azure-pipelines-release-docs, and in the five estate repos that carry it, it
// has never had a test — so a regex edit, a lost `set -euo pipefail`, or a
// silently renamed job would leave a green required context asserting nothing.
// That is this estate's most expensive failure mode and it is what this file
// refuses.
//
// HOW. The `run:` block is EXTRACTED from the workflow file rather than copied
// here: a copy would drift from the thing it claims to prove, which is the same
// defect one level up. `gh` is stubbed with a script that prints a fixture
// commit history, so no network and no repository are involved.
//
// Cases, and the property each one pins:
//   clean-single / clean-none    an ordinary PR is not obstructed
//   two-footers                  THE case — release-please keeps the first
//                                and drops the rest (registry-backend v4.0.0)
//   two-bang-headers             the `!` marker counted the same way
//   footer-plus-bang-one-commit  a footer and a `!` in ONE commit is ONE
//                                declaration, not two — the footer wins
//   hyphen-spelling              `BREAKING-CHANGE:` is the same token
//   prose-mention                a mid-line mention is prose, not a footer
//   summary-names-the-commits    the failure says WHICH commits, in the job
//                                summary a reviewer actually reads
//   gh-unavailable               it FAILS CLOSED when it cannot read the
//                                commit list — an unreadable history counted
//                                as zero declarations is a green context
//                                asserting nothing, and it is what a lost
//                                `set -euo pipefail` degrades to
//   job-present                  the vacuity contract: if the job or its
//                                script cannot be found, this test fails
//                                rather than passing over nothing

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'pr-checks.yml');
const JOB_KEY = 'breaking-change-footers';

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'breaking-change-footers-selftest-'));

let failures = 0;
const report = (ok, message) => {
    if (ok) {
        console.log(`  OK   ${message}`);
    } else {
        console.error(`  FAIL ${message}`);
        failures += 1;
    }
};

/* ------------------------------------------------------------------ *
 * Extract the guard from the workflow.
 * ------------------------------------------------------------------ */

/** The dedented body of the `run: |` block inside job `key`. */
function extractRunBlock(yaml, key) {
    const lines = yaml.split(/\r?\n/);
    const start = lines.findIndex((line) => new RegExp(`^  ${key}:\\s*$`).test(line));
    if (start === -1) return { error: `no job \`${key}:\` in ${path.relative(process.cwd(), WORKFLOW)}` };

    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        if (/^  [A-Za-z0-9_.-]+:\s*$/.test(lines[i])) {
            end = i;
            break;
        }
    }

    const body = lines.slice(start, end);
    const runAt = body.findIndex((line) => /^\s+run:\s*\|\s*$/.test(line));
    if (runAt === -1) return { error: `job \`${key}\` has no \`run: |\` block` };

    const indent = /^(\s+)/.exec(body[runAt + 1] || '');
    if (!indent) return { error: `job \`${key}\`'s \`run: |\` block is empty` };

    const script = [];
    for (let i = runAt + 1; i < body.length; i++) {
        const line = body[i];
        if (line.trim() === '') {
            script.push('');
            continue;
        }
        if (!line.startsWith(indent[1])) break;
        script.push(line.slice(indent[1].length));
    }
    return { script: script.join('\n') };
}

const extracted = extractRunBlock(fs.readFileSync(WORKFLOW, 'utf8'), JOB_KEY);
if (extracted.error) {
    console.error(`  FAIL vacuity: ${extracted.error}`);
    console.error('\ntest-breaking-change-footers: the guard this file exists to prove could not be found, which is a failure and not a pass.');
    process.exit(1);
}
report(true, `extracted the guard from ${JOB_KEY} (${extracted.script.split('\n').length} lines)`);
// The extraction has to be of the REAL script, not of an empty match that then
// "passes" every case below.
report(/BREAKING\[ -\]CHANGE:/.test(extracted.script), 'the extracted script contains the footer-matching expression');

const scriptPath = path.join(workRoot, 'guard.sh');
fs.writeFileSync(scriptPath, extracted.script);

/* ------------------------------------------------------------------ *
 * A `gh` that prints a fixture history instead of calling GitHub.
 * ------------------------------------------------------------------ */

const binDir = path.join(workRoot, 'bin');
fs.mkdirSync(binDir);
fs.writeFileSync(path.join(binDir, 'gh'), '#!/bin/sh\ncat "$FIXTURE_COMMITS"\n', { mode: 0o755 });

// The other `gh`: one that fails the way the real one does on an API error, a
// revoked token or a rate limit. The guard must not read that as "no breaking
// changes here".
const failingBinDir = path.join(workRoot, 'bin-failing');
fs.mkdirSync(failingBinDir);
fs.writeFileSync(
    path.join(failingBinDir, 'gh'),
    '#!/bin/sh\necho "gh: HTTP 403: Resource not accessible by integration" >&2\nexit 1\n',
    { mode: 0o755 },
);

let fixtureSeq = 0;
function runGuard(commits, stubDir = binDir) {
    const dir = path.join(workRoot, `case-${(fixtureSeq += 1)}`);
    fs.mkdirSync(dir);
    const fixture = path.join(dir, 'commits.json');
    fs.writeFileSync(fixture, `${commits.map((c, i) => JSON.stringify({ sha: `abc00${i}`, msg: c })).join('\n')}\n`);
    const summary = path.join(dir, 'summary.md');
    fs.writeFileSync(summary, '');

    const result = spawnSync('bash', [scriptPath], {
        cwd: dir,
        encoding: 'utf8',
        env: {
            ...process.env,
            PATH: `${stubDir}${path.delimiter}${process.env.PATH}`,
            FIXTURE_COMMITS: fixture,
            GH_TOKEN: 'stub',
            PR_NUMBER: '123',
            REPO: 'sethbacon/azure-pipelines-terraform',
            GITHUB_STEP_SUMMARY: summary,
        },
    });
    return {
        status: result.status,
        output: `${result.stdout || ''}${result.stderr || ''}`,
        summary: fs.readFileSync(summary, 'utf8'),
    };
}

function expectPass(label, commits, mustSay = []) {
    const { status, output } = runGuard(commits);
    if (status !== 0) {
        report(false, `${label}: exited ${status} on a PR it should accept\n${output}`);
        return;
    }
    const missing = mustSay.filter((w) => !output.includes(w));
    if (missing.length > 0) {
        report(false, `${label}: passed but never said ${missing.map((m) => JSON.stringify(m)).join(', ')}\n${output}`);
        return;
    }
    report(true, `${label}: exits 0${mustSay.length ? ` saying ${mustSay.map((w) => JSON.stringify(w)).join(' + ')}` : ''}`);
}

function expectRejection(label, commits, mustSay, mustSummarise = []) {
    const { status, output, summary } = runGuard(commits);
    if (status === 0) {
        report(false, `${label}: exited 0 on a PR that would lose a breaking change\n${output}`);
        return;
    }
    const wanted = Array.isArray(mustSay) ? mustSay : [mustSay];
    const missing = wanted.filter((w) => !output.includes(w));
    if (missing.length > 0) {
        report(false, `${label}: failed but never mentioned ${missing.map((m) => JSON.stringify(m)).join(', ')}\n${output}`);
        return;
    }
    const unsummarised = mustSummarise.filter((w) => !summary.includes(w));
    if (unsummarised.length > 0) {
        report(false, `${label}: failed without putting ${unsummarised.map((m) => JSON.stringify(m)).join(', ')} in the job summary\n${summary}`);
        return;
    }
    report(true, `${label}: exits ${status} naming ${wanted.map((w) => JSON.stringify(w)).join(' + ')}`);
}

const FOOTER = 'BREAKING CHANGE: the provider-mirror input is no longer optional';

try {
    console.log('\npull requests this guard must not obstruct:');
    expectPass('clean-none', ['fix: correct the registry allowlist check'], ['declarations in this PR: 0', 'at most one declaration']);
    expectPass('clean-single', [`feat: rework the mirror download path\n\n${FOOTER}`], ['declarations in this PR: 1']);
    expectPass('clean-many-commits', ['ci: pin an action', 'docs: fix a link', 'test: cover the parser'], ['declarations in this PR: 0']);
    // The shape called out as the false positive to avoid: a `!` header and a
    // footer in the SAME commit describe ONE breaking change, because
    // release-please reads the footer and the header is the marker for it.
    expectPass('footer-plus-bang-one-commit', [`feat!: rework the mirror download path\n\n${FOOTER}`], ['declarations in this PR: 1']);
    // A mention inside a paragraph is prose. Only a line that STARTS with the
    // token is a footer, and a guard that fired on prose would be routed around.
    expectPass('prose-mention', ['docs: explain that a BREAKING CHANGE: footer is kept only once'], ['declarations in this PR: 0']);

    console.log('\nmutations — the squash losing a declaration (#966):');
    // THE case: registry-backend v4.0.0 published two breaking changes and
    // documented one.
    expectRejection(
        'two-footers',
        [`feat: drop the V4 task\n\n${FOOTER}`, 'feat: require a service connection\n\nBREAKING CHANGE: the PAT input is gone'],
        ['declares 2 breaking changes', 'the squash keeps only the first'],
        ['**2** breaking changes', 'abc000', 'abc001'],
    );
    expectRejection(
        'two-bang-headers',
        ['feat!: drop the V4 task', 'fix(auth)!: require a service connection'],
        ['declares 2 breaking changes'],
        ['drop the V4 task', 'require a service connection'],
    );
    // Both spellings of the token are the spec's. A guard blind to the hyphen
    // would be routed around by the first person who writes it that way.
    expectRejection(
        'hyphen-spelling',
        [`feat: drop the V4 task\n\n${FOOTER}`, 'feat: require a service connection\n\nBREAKING-CHANGE: the PAT input is gone'],
        ['declares 2 breaking changes'],
    );
    // Three, which is the registry-backend PR that started this rule.
    expectRejection(
        'three-footers',
        [`feat: a\n\n${FOOTER}`, 'feat: b\n\nBREAKING CHANGE: b changed', 'feat: c\n\nBREAKING CHANGE: c changed'],
        ['declares 3 breaking changes'],
        ['The other 2 would ship with no changelog entry'],
    );
    console.log('\nthe guard has to fail closed, not quiet:');
    // `set -euo pipefail` is the whole of this property. Without it the failed
    // `gh api` leaves an empty commits.ndjson behind, the loop counts nothing,
    // and the job reports "declarations in this PR: 0" and goes green — a
    // required context that has stopped looking, which is indistinguishable
    // from a clean tree. This is the one mutation the ported test could not see.
    {
        const { status, output } = runGuard(['feat: anything at all'], failingBinDir);
        report(
            status !== 0 && !output.includes('declarations in this PR: 0'),
            status !== 0 && !output.includes('declarations in this PR: 0')
                ? `gh-unavailable: exits ${status} rather than counting an unreadable history as zero`
                : `gh-unavailable: exited ${status} when \`gh\` failed, so an unreadable commit list passes as clean\n${output}`,
        );
    }
} finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
}

if (failures > 0) {
    console.error(`\ntest-breaking-change-footers: ${failures} case(s) failed.`);
    process.exit(1);
}
console.log('\ntest-breaking-change-footers: the guard counts every declaration the squash would drop, and passes the shapes it must not obstruct.');
