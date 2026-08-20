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
//   prose-mention                a mid-line mention of the SPACED spelling is
//                                prose, and release-please agrees
//   hyphenated-footer-alone      a real hyphenated footer is ONE declaration
//                                and must not be rejected
//   abacdb5-accidental-declaration
//                                THE regression: release-please reads the
//                                hyphenated token mid-sentence, so prose that
//                                merely names it declares a breaking change
//   two-mid-line-mentions        two of those in one PR is two declarations
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

    // Indent comes from the first NON-BLANK line of the block. Taking it
    // from `runAt + 1` unconditionally would turn a block that merely opens
    // with a blank line -- which is what deleting the `set -euo pipefail`
    // line leaves behind -- into "block is empty", and this file would then
    // report that instead of running the cases against the guard it still has.
    let firstBody = runAt + 1;
    while (firstBody < body.length && body[firstBody].trim() === '') firstBody += 1;
    const indent = /^(\s+)/.exec(body[firstBody] || '');
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
report(
     extracted.script.includes("grep -cE '^BREAKING CHANGE:'"),
     'the extracted script counts the spaced spelling only at the start of a line',
);
report(
     extracted.script.includes("grep -oF 'BREAKING-CHANGE:'"),
     'the extracted script counts the hyphenated spelling anywhere in the body',
);

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

// The verbatim body of azure-pipelines-terraform abacdb5 -- the commit that
// ADDED this guard. One sentence in it NAMES the hyphenated spelling of the
// token, mid-line, as prose describing what the guard detects. release-please
// read that as a real declaration, took the remainder of the line as the
// description, and proposed 2.0.0 over a 1.14.4 release whose honest successor
// was 1.14.5 -- with a changelog entry reading "` spelling". The guard, counting
// only line-anchored matches, said 0 and let it through.
//
// It is load bearing that this is the WHOLE body and not just that sentence: it
// also names the SPACED spelling mid-line, which release-please does not read.
// The only count that is right for it is 1.
const ABACDB5_BODY = [
    "ci: count breaking-change declarations across the commits being squashed (#974)",
    "",
    "This repo squash-merges with `squash_merge_commit_message=COMMIT_MESSAGES`",
    "(re-verified on the live repo), so every commit body in a PR is concatenated",
    "into ONE merge commit -- and release-please keeps only the FIRST",
    "`BREAKING CHANGE:` footer of that commit, reading a `!` marker only from its",
    "header. A second declaration anywhere in the PR is dropped in silence: no",
    "changelog entry, no upgrade note, and nothing failing to say so.",
    "terraform-registry-backend v4.0.0 shipped two undocumented breaking changes",
    "exactly this way, and it reaches further from here: this extension publishes to",
    "the VS Marketplace, where the release notes are a pipeline author's only signal",
    "that a task changed incompatibly, and ADO agents cache tasks by Major.Minor.",
    "",
    "Five other suite repos carry this guard; the two ADO extensions did not. The",
    "only `BREAKING` matches here were prose inside",
    "`.github/commit-message-check/verify.mjs`, which parses the SINGLE message this",
    "PR would squash and asks whether release-please can read it at all -- it never",
    "counts declarations across the set being concatenated. The two are the halves of",
    "one pair and neither subsumes the other: a perfectly parseable squash can still",
    "swallow a second footer, and a single-footer PR can still be unparseable.",
    "",
    "Ported from `azure-pipelines-release-docs`, which took it from",
    "`terraform-registry-backend` and added the self-test. The self-test EXTRACTS the",
    "bash out of pr-checks.yml rather than copying it -- a copy drifts from the thing",
    "it claims to prove, which is the same defect one level up -- and runs it against",
    "fixture commit histories with `gh` stubbed. It runs in the already-required",
    "`Lint GitHub Actions` job, so the proof blocks a merge from the day it lands.",
    "",
    "Mutation-proved against the committed workflow, each rejection asserted by name:",
    "two footers, two `!` headers, three footers and the `BREAKING-CHANGE:` spelling",
    "are rejected; the single-declaration, no-declaration, many-clean-commits,",
    "prose-mention and footer-plus-`!`-in-one-commit shapes pass untouched. Five",
    "mutations of the guard were each seen failing the test: dropping the hyphen",
    "spelling, making the footer and `!` additive, raising the threshold to 2,",
    "renaming the job (the vacuity contract), and dropping `set -euo pipefail`.",
    "",
    "That last one is a case the source implementation could not see, so this port",
    "adds it: without `set -euo pipefail` a failed `gh api` leaves an empty commit",
    "list behind and the job reports \"declarations in this PR: 0\" and goes green. The",
    "new `gh-unavailable` case stubs a failing `gh` and requires the guard to fail",
    "closed.",
    "",
    "No task.json touched, and no existing job renamed or split.",
    "",
    "BRANCH PROTECTION: this adds one NEW context, `Breaking-change footers survive",
    "the squash`, which has to be added to main's required checks by hand. Until then",
    "the job reports on every PR without blocking one -- the same state as",
    "`release-please can read the merged commit`, the other half of the pair.",
    "",
    "Closes #966",
].join('\n');

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
    // CORRECTED. This case used to assert that ANY mid-line mention is prose,
    // and it pinned a model release-please does not implement. Only the SPACED
    // spelling is ignored mid-line; the hyphenated one is matched anywhere, and
    // asserting otherwise is exactly what let abacdb5 through -- that body is
    // rejected below. What survives here is the half that is true, and it has to
    // survive: a guard that failed a sentence release-please reads as prose would
    // be routed around and then deleted.
    //
    // The mention is in the BODY, not the subject. The old fixture was a
    // single-line message, so it never exercised the body at all.
    expectPass(
        'prose-mention',
        ['docs: explain the footer rule\n\nA line that merely says BREAKING CHANGE: in the middle of a\nsentence is prose, and release-please never reads it as a footer.'],
        ['declarations in this PR: 0'],
    );
    // The hyphenated spelling written as a real footer IS a real declaration, and
    // one of them is what the squash can carry. Rejecting it would be the
    // over-count mirror of the bug this change fixes, and an over-counting guard
    // gets bypassed and then deleted just as surely as a blind one.
    expectPass(
        'hyphenated-footer-alone',
        ['feat: rework the mirror download path\n\nBREAKING-CHANGE: the input is no longer optional'],
        ['declarations in this PR: 1'],
    );

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
    // THE regression, and the reason this file changed. abacdb5 is the commit
    // that ADDED this guard; a sentence in its body naming the hyphenated
    // spelling was read by release-please as a declaration, which proposed 2.0.0
    // over 1.14.4 with a changelog entry reading "` spelling". The guard counted
    // it 0 and passed it.
    //
    // The count asserted here is 1, and that number is load bearing in BOTH
    // directions: 0 is the under-count that shipped, and 2 is what merely
    // un-anchoring the old expression would give, because this body also names
    // the spaced spelling mid-line and release-please does not read that.
    expectRejection(
        'abacdb5-accidental-declaration',
        [ABACDB5_BODY],
        ['declarations in this PR: 1', 'off the start of a line'],
        ['A breaking change nobody declared'],
    );
    // Two of them in one PR: two notes, and the squash keeps one. This is the
    // shape the old `prose-mention` assertion declared acceptable.
    expectRejection(
        'two-mid-line-mentions',
        [
            'docs: describe the footer rule\n\nprose naming BREAKING-CHANGE: once',
            'docs: describe it again\n\nmore prose naming BREAKING-CHANGE: twice',
        ],
        ['declarations in this PR: 2', 'off the start of a line'],
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
