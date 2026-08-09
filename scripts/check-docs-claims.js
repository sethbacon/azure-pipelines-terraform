#!/usr/bin/env node
// DOCUMENTED-CLAIM SIGNATURE (#205 / #206, sibling azure-pipelines-terraform).
//
// Defect class
// ------------
//   A document asserts something about the code that the code does not (or no
//   longer) says, and nothing re-checks it.
//
// This is not cosmetic. CLAUDE.md's per-task file table is the architecture doc
// both humans and coding assistants treat as ground truth; #205 was a table that
// omitted registry-allowlist.ts — the module that actually implements the
// mirror-download SSRF defense — so a change to SSRF handling could be made, and
// reviewed, without anyone consulting the module that implements it. #206 was
// CONTRIBUTING.md listing three of the six jobs that gate a PR. A doc that
// overstates or understates a control causes people to skip a check they think
// exists (or does not).
//
// What this script enforces
// -------------------------
//   1. FILE TABLES. Wherever a doc presents a `| File | Role |` table anchored to
//      a `Tasks/<Family>/<Task>/src/...` directory, that table must name EVERY
//      .ts file in that directory and no file that is absent. A table is a
//      completeness claim; prose is not, so prose sections are not checked.
//   2. CI JOBS. The `<!-- ci-jobs:begin -->`/`<!-- ci-jobs:end -->` region of
//      CONTRIBUTING.md must name exactly the jobs `unit-test.yml` declares.
//      Bidirectional: a job added to CI and not to the doc fails, and so does a
//      job named in the doc that no longer exists.
//   3. REFERENCED PATHS. Any backticked repo-relative path in a checked doc
//      (`Tasks/...`, `scripts/...`, `docs/...`, `.github/...`) must exist.
//
// Repo-agnostic: everything is derived from disk. Usage:
//
//     node scripts/check-docs-claims.js [repoRoot] [--json]
//
// Exit 0 = every checked claim holds. Exit 1 = drift, listed.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const JSON_OUTPUT = process.argv.includes('--json');
const ROOT = path.resolve(process.argv.filter((a) => a !== '--json')[2] || process.cwd());

/** Docs whose claims are checked. Missing files are skipped, not failed. */
const DOCS = ['CLAUDE.md', 'CONTRIBUTING.md', 'README.md'];

const findings = [];
const fail = (kind, where, message) => findings.push({ kind, where, message });

function readIfPresent(rel) {
    const full = path.join(ROOT, rel);
    return fs.existsSync(full) ? fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n') : null;
}

/* ------------------------------------------------------------------ *
 * 1. File tables must enumerate their src/ directory exactly.
 * ------------------------------------------------------------------ */

/**
 * Parses the markdown table that FOLLOWS `from`, returning the backticked
 * filename in each row's first cell. Returns null when the next non-blank
 * content is not a `| File |` table, i.e. the section makes no completeness
 * claim.
 */
function fileTableAfter(text, from) {
    const header = /\n\|\s*File\s*\|/i.exec(text.slice(from));
    if (!header) return null;
    // The table must belong to THIS anchor: refuse to reach past the next
    // markdown heading, or a table two sections down would be attributed here.
    const nextHeading = text.slice(from).search(/\n#{2,4} /);
    if (nextHeading >= 0 && header.index > nextHeading) return null;

    const start = from + header.index + 1;
    const names = [];
    for (const line of text.slice(start).split('\n')) {
        if (!line.trimStart().startsWith('|')) break;
        const firstCell = line.split('|')[1] ?? '';
        const named = /`([A-Za-z0-9_.-]+\.tsx?)`/.exec(firstCell);
        if (named) names.push(named[1]);
    }
    return names;
}

for (const doc of DOCS) {
    const text = readIfPresent(doc);
    if (!text) continue;
    const anchor = /`(Tasks\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/src\/(?:[A-Za-z0-9_.-]+\/)*)`/g;
    let m;
    while ((m = anchor.exec(text)) !== null) {
        const dir = m[1];
        const listed = fileTableAfter(text, m.index);
        if (listed === null) continue; // prose section: no completeness claim
        const full = path.join(ROOT, dir);
        if (!fs.existsSync(full)) {
            fail('file-table', `${doc} -> ${dir}`, 'the documented source directory does not exist');
            continue;
        }
        const actual = fs.readdirSync(full).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts'));
        const undocumented = actual.filter((f) => !listed.includes(f)).sort();
        const phantom = listed.filter((f) => !actual.includes(f)).sort();
        if (undocumented.length) {
            fail('file-table', `${doc} -> ${dir}`, `file table omits: ${undocumented.join(', ')}`);
        }
        if (phantom.length) {
            fail('file-table', `${doc} -> ${dir}`, `file table names files that do not exist: ${phantom.join(', ')}`);
        }
    }
}

/* ------------------------------------------------------------------ *
 * 2. The CONTRIBUTING.md CI-job list must match unit-test.yml.
 * ------------------------------------------------------------------ */

const WORKFLOW = '.github/workflows/unit-test.yml';
const workflow = readIfPresent(WORKFLOW);
const contributing = readIfPresent('CONTRIBUTING.md');

/**
 * Job display names from unit-test.yml: a `name:` indented exactly four spaces
 * is a job's name (steps are nested deeper and carry a leading `- `). Matrix
 * expressions are stripped so `Build and Test X (${{ matrix.os }})` is compared
 * as `Build and Test X`, which is what a contributor-facing doc should say.
 */
function workflowJobNames(yaml) {
    const names = [];
    for (const line of yaml.split('\n')) {
        const m = /^ {4}name:\s*(.+?)\s*$/.exec(line);
        if (!m) continue;
        names.push(m[1].replace(/["']/g, '').replace(/\s*\(\$\{\{[^}]*\}\}\)\s*$/, '').trim());
    }
    return [...new Set(names)];
}

/**
 * Top-level job ids (2-space keys under `jobs:`). A job that declares no `name:`
 * is displayed by GitHub under its id, so it would gate a PR while being
 * invisible to workflowJobNames() above — and therefore never required in the
 * doc. Counting ids and names catches that.
 */
function workflowJobIds(yaml) {
    const body = yaml.slice(yaml.search(/^jobs:\s*$/m));
    return [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]);
}

if (workflow && contributing) {
    const region = /<!--\s*ci-jobs:begin\s*-->([\s\S]*?)<!--\s*ci-jobs:end\s*-->/.exec(contributing);
    if (!region) {
        fail('ci-jobs', 'CONTRIBUTING.md', 'no <!-- ci-jobs:begin -->…<!-- ci-jobs:end --> region; the CI job list cannot be checked against the workflow');
    } else {
        const declared = workflowJobNames(workflow).sort();
        // One bullet per job, the job name in the FIRST backticked span. Reading
        // every backtick in the region instead would pull the explanatory
        // `scripts/*.js` references in as if they were job names.
        const documented = region[1]
            .split('\n')
            .map((line) => /^\s*[-*]\s+`([^`]+)`/.exec(line))
            .filter(Boolean)
            .map((x) => x[1].trim())
            .sort();
        const missing = declared.filter((n) => !documented.includes(n));
        const extra = documented.filter((n) => !declared.includes(n));
        if (missing.length) fail('ci-jobs', 'CONTRIBUTING.md', `CI jobs that gate a PR but are undocumented: ${missing.join(', ')}`);
        if (extra.length) fail('ci-jobs', 'CONTRIBUTING.md', `documented CI jobs that ${WORKFLOW} does not declare: ${extra.join(', ')}`);
        if (declared.length === 0) fail('ci-jobs', WORKFLOW, 'no job names parsed — the check would pass vacuously');
        const ids = workflowJobIds(workflow);
        if (ids.length === 0) {
            fail('ci-jobs', WORKFLOW, 'no job ids parsed — the check would pass vacuously');
        } else if (ids.length < declared.length) {
            fail('ci-jobs', WORKFLOW, `parsed ${declared.length} job names but only ${ids.length} job ids — the name parser is over-matching`);
        } else {
            // Names are deduped (matrix legs share one display name), so the only
            // safe assertion is that no job is NAMELESS: every id must be able to
            // reach a name. Approximated by requiring at least one name per job
            // block, which is what a missing `name:` breaks.
            const nameLines = (workflow.match(/^ {4}name:/gm) || []).length;
            if (nameLines < ids.length) {
                fail('ci-jobs', WORKFLOW, `${ids.length - nameLines} job(s) declare no \`name:\` and would gate a PR under their job id, invisible to this check: ${ids.join(', ')}`);
            }
        }
    }
} else if (contributing && !workflow) {
    fail('ci-jobs', 'CONTRIBUTING.md', `${WORKFLOW} not found`);
}

/* ------------------------------------------------------------------ *
 * 3. Referenced repo-relative paths must exist.
 * ------------------------------------------------------------------ */

/**
 * A path that is git-ignored is a file the docs legitimately describe but the
 * repo deliberately does not carry (e.g. `configs/self.json`, the personal dev
 * publisher override a contributor creates locally). Absent-and-ignored is
 * correct; absent-and-tracked-nowhere is the drift this check is for.
 */
function isGitIgnored(rel) {
    try {
        execFileSync('git', ['check-ignore', '-q', '--', rel], { cwd: ROOT, stdio: 'ignore' });
        return true;
    } catch (err) {
        // Exit 1 = not ignored (a real finding). Any other status means git could
        // not answer, and a check that cannot answer must not silently pass.
        if (err && err.status === 1) return false;
        fail('path-ref', rel, `could not determine git-ignore status (is git available?): ${err && err.message}`);
        return true;
    }
}

for (const doc of DOCS) {
    const text = readIfPresent(doc);
    if (!text) continue;
    const ref = /`((?:Tasks|scripts|docs|configs|\.github)\/[A-Za-z0-9_./-]+)`/g;
    const seen = new Set();
    let m;
    while ((m = ref.exec(text)) !== null) {
        const rel = m[1].replace(/\/$/, '');
        // Globs and `<Placeholder>` templates are patterns, not paths.
        if (/[*<>{}]/.test(rel) || seen.has(rel)) continue;
        seen.add(rel);
        if (!fs.existsSync(path.join(ROOT, rel)) && !isGitIgnored(rel)) {
            fail('path-ref', doc, `references a path that does not exist: ${rel}`);
        }
    }
}

/* ------------------------------------------------------------------ */

// A signature that checks nothing is indistinguishable from a broken signature.
if (!readIfPresent('CLAUDE.md')) {
    console.error(`FAIL: CLAUDE.md not found under ${ROOT} — the signature would pass vacuously.`);
    process.exit(1);
}

if (JSON_OUTPUT) {
    console.log(JSON.stringify({ findings, failures: findings.length }, null, 2));
    process.exit(findings.length ? 1 : 0);
}

if (findings.length) {
    for (const f of findings) {
        console.error(`FAIL [${f.kind}] ${f.where}: ${f.message}`);
    }
    console.error(`\n${findings.length} documented claim(s) do not match the code they describe.`);
    process.exit(1);
}
console.log('OK: every checked documented claim matches the code it describes.');
