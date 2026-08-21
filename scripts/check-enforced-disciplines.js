#!/usr/bin/env node
// ===========================================================================
// SIGNATURE for the "documented-but-unenforced discipline" defect class.
//
// The class: a rule the project relies on is written down (CLAUDE.md, a task
// manifest, a .nycrc exclude list, a release checklist) but nothing in CI ever
// asserts it, so it holds only while a human remembers it. Every instance in
// this batch had that shape:
//
//   * task.json declares a Node20_1 fallback execution handler, but no CI leg
//     ever ran the compiled output under Node 20 (packer #208).
//   * .nycrc.json excludes src/index.js from the coverage metric AND no test
//     file requires it, so the entry point -- including the SIGTERM/SIGINT
//     credential-scrub wiring -- is neither measured nor executed (#189).
//   * CLAUDE.md documents "bump the task.json Minor for every changed task"
//     but check-versions.js only validates the fields are well-formed (#192).
//   * the Marketplace publish passes a minted Entra token on argv and has no
//     bounded retry, so one upstream 503 burns a release (#109 + the v1.2.7
//     publish failure).
//
// Rather than fix four instances, this script ENUMERATES the whole class from
// disk on every run and fails the build when any site regresses. Adding a task
// automatically adds its rows; nothing has to be remembered.
//
// Usage: node scripts/check-enforced-disciplines.js [repoRoot]   (default: cwd)
//
// Exemptions live in EXEMPTIONS below and are BIDIRECTIONAL: an exemption whose
// site now passes is itself a failure, so the table can never quietly outlive
// the reason it was added.
// ===========================================================================

const fs = require('fs');
const path = require('path');
const { discoverTaskDirs } = require('./lib/task-dirs.js');

const repoRoot = path.resolve(process.argv[2] || '.');

// ---------------------------------------------------------------------------
// Exemptions: `${checkId}::${site}` -> reason verified by reading code.
// ---------------------------------------------------------------------------
const EXEMPTIONS = {};

// ---------------------------------------------------------------------------
// Small helpers (no YAML/JSON5 dependency: these scripts run before any
// `npm ci` in CI's check jobs, so they must stay dependency-free).
// ---------------------------------------------------------------------------

function readIfExists(file) {
    const full = path.join(repoRoot, file);
    return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
}

function readJsonIfExists(file) {
    const raw = readIfExists(file);
    return raw === null ? null : JSON.parse(raw);
}

function walkFiles(dir, filter, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkFiles(full, filter, out);
        else if (filter(entry.name)) out.push(full);
    }
    return out;
}

/**
 * Splits a workflow file into its top-level job blocks.
 * Returns a Map of jobId -> the raw text of that job (including its `name:`),
 * so callers can ask "does the job that builds <taskDir> also set up Node 20?"
 * without pulling in a YAML parser.
 */
function parseJobs(text) {
    const jobs = new Map();
    if (!text) return jobs;
    const lines = text.split(/\r?\n/);
    const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
    if (jobsAt === -1) return jobs;
    let current = null;
    let buffer = [];
    for (let i = jobsAt + 1; i < lines.length; i++) {
        const line = lines[i];
        const start = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
        if (start) {
            if (current) jobs.set(current, buffer.join('\n'));
            current = start[1];
            buffer = [line];
            continue;
        }
        if (/^\S/.test(line) && line.trim() !== '') break; // left the jobs: mapping
        if (current) buffer.push(line);
    }
    if (current) jobs.set(current, buffer.join('\n'));
    return jobs;
}

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does `text` reference the module at repo-relative `target` (e.g. 'src/index.js')?
 *
 * Both spellings the mock-runner suites in these repos actually use must match,
 * or the signature reports a false FAIL on a task that IS exercising its entry
 * point (this happened on the first run against azure-pipelines-terraform, whose
 * PublishKbArticle/ModulePublish/ProviderMirror suites all use the second form):
 *   1. a single path literal:   require('../src/index') / '../../src/index.js'
 *   2. path.join segments:      path.join(__dirname, '..', 'src', 'index.js')
 */
function referencesTarget(text, target) {
    const segments = target.split('/');
    const joined = segments.map(escapeRe).join('[/\\\\]');
    const singleLiteral = new RegExp(`['"\`][^'"\`]*${joined.replace(/\\\.js$/, '')}(\\.js)?['"\`]`);
    const asSegments = new RegExp(
        segments
            .map((s, i) => `['"\`]${escapeRe(i === segments.length - 1 ? s.replace(/\.js$/, '') : s)}(\\.js)?['"\`]`)
            .join('\\s*,\\s*'),
    );
    return singleLiteral.test(text) || asSegments.test(text);
}

/** All `node-version:` values declared inside a job block, as integer majors. */
function nodeMajorsIn(jobText) {
    const majors = new Set();
    for (const m of jobText.matchAll(/node-version:\s*["']?(\d+)/g)) {
        majors.add(parseInt(m[1], 10));
    }
    return majors;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------
const findings = [];
function record(check, site, ok, detail) {
    findings.push({ check, site, ok, detail });
}

const tasks = discoverTaskDirs(repoRoot);
if (tasks.length === 0) {
    console.error(`FAIL: no task directories found under ${path.join(repoRoot, 'Tasks')} — the signature would trivially pass over an empty universe.`);
    process.exit(1);
}

// The workflows that RUN the per-task tests: unit-test.yml in the sibling
// extensions, ci.yml here. release.yml is deliberately not read -- it sets Node
// up to BUILD, and a build is not an exercise of the test suite.
const ciJobs = new Map();
for (const wf of ['unit-test.yml', 'ci.yml']) {
    const text = readIfExists(`.github/workflows/${wf}`);
    if (!text) continue;
    for (const [id, body] of parseJobs(text)) ciJobs.set(`${wf}:${id}`, body);
}

// A repo may name one job per task, or fan every task out through a single
// runner. Under the second shape no job mentions any task directory, so matching
// only on the path would report a fully-tested repo as untested.
const fanOutScripts = Object.entries((readJsonIfExists('package.json') || {}).scripts || {})
    .filter(([, cmd]) => /for-each-task(?:\.js)?\s+(?:test|smoke)\b/.test(cmd))
    .map(([name]) => name);
const runsEveryTask = (text) => fanOutScripts.some((s) => text.includes(`npm run ${s}`));

for (const task of tasks) {
    const manifest = readJsonIfExists(`${task}/task.json`);
    const execution = (manifest && manifest.execution) || {};
    const handlers = Object.keys(execution);

    // --- DISCIPLINE 1: the declared entry point is actually exercised by a test.
    // A task.json `execution` target is a production contract: it is the file the
    // ADO agent runs. If no test ever loads it, its signal/cleanup wiring and its
    // input plumbing are unverified no matter how well the modules it calls are
    // covered.
    const targets = [...new Set(handlers.map((h) => execution[h] && execution[h].target).filter(Boolean))];
    const testFiles = walkFiles(path.join(repoRoot, task, 'Tests'), (n) => n.endsWith('.ts'));
    for (const target of targets) {
        const moduleRef = target.replace(/\.js$/, ''); // src/index.js -> src/index (for the message only)
        const referenced = testFiles.some((f) => referencesTarget(fs.readFileSync(f, 'utf8'), target));
        record(
            'entry-point-exercised',
            `${task} -> ${target}`,
            referenced,
            referenced
                ? `referenced by a file under ${task}/Tests`
                : `no file under ${task}/Tests references ${moduleRef}; the execution entry point is never loaded by any test`,
        );
    }

    // --- DISCIPLINE 2: the entry point is inside the coverage metric.
    // Excluding it makes the ratcheted floor silently stop describing the file
    // the agent actually runs.
    const nycPath = `${task}/.nycrc.json`;
    const nyc = readJsonIfExists(nycPath);
    if (nyc) {
        const excludes = nyc.exclude || [];
        for (const target of targets) {
            const excluded = excludes.includes(target);
            record(
                'entry-point-in-coverage',
                `${task} -> ${target}`,
                !excluded,
                excluded
                    ? `${nycPath} excludes ${target} from the coverage metric`
                    : `${target} is measured by ${nycPath}`,
            );
        }
    }

    // --- DISCIPLINE 3: every declared execution handler is exercised in CI.
    // Shipping a Node20_1 fallback that CI never runs means the agents least
    // able to recover (older/air-gapped, no Node 24 runner) are the ones that
    // discover a Node-20-incompatible dependency first.
    const jobsForTask = [...ciJobs.entries()].filter(([, text]) => text.includes(task) || runsEveryTask(text));
    const exercised = new Set();
    for (const [, text] of jobsForTask) {
        for (const major of nodeMajorsIn(text)) exercised.add(major);
    }
    for (const handler of handlers) {
        const m = handler.match(/^Node(\d+)(?:_\d+)?$/);
        if (!m) {
            record('execution-handler-exercised', `${task} -> ${handler}`, true, 'non-Node handler: not a Node-runtime discipline');
            continue;
        }
        const major = parseInt(m[1], 10);
        const ok = exercised.has(major);
        record(
            'execution-handler-exercised',
            `${task} -> ${handler}`,
            ok,
            ok
                ? `Node ${major} runs in ${jobsForTask.map(([id]) => id).join(', ')}`
                : `task.json declares the ${handler} handler but no test-workflow job for ${task} sets up Node ${major} (jobs seen: ${jobsForTask.map(([id]) => id).join(', ') || 'none'})`,
        );
    }
}

// --- DISCIPLINE 4: the Minor-bump rule is machine-enforced, in depth.
// ADO agents cache tasks by Major.Minor: a security fix published without a
// Minor bump reaches the Marketplace but never a running agent. Three layers,
// because the first two are advisory-in-practice (a broken auto-bump workflow
// is invisible; a merge gate can be bypassed by an admin merge).
{
    const workflowsDir = path.join(repoRoot, '.github', 'workflows');
    const workflowTexts = walkFiles(workflowsDir, (n) => n.endsWith('.yml') || n.endsWith('.yaml'))
        .map((f) => ({ name: path.basename(f), text: fs.readFileSync(f, 'utf8') }));
    const prChecks = readIfExists('.github/workflows/pr-checks.yml') || '';
    const releaseYml = readIfExists('.github/workflows/release.yml') || '';

    const layers = [
        {
            name: 'script',
            ok: fs.existsSync(path.join(repoRoot, 'scripts', 'check-minor-bumps.js')),
            detail: 'scripts/check-minor-bumps.js must exist (the rule itself)',
        },
        {
            name: 'auto-bump-workflow',
            ok: workflowTexts.some((w) => w.text.includes('bump-minor-versions.js')),
            detail: 'a workflow must run scripts/bump-minor-versions.js on the Release PR',
        },
        {
            name: 'pr-merge-gate',
            ok: prChecks.includes('check-minor-bumps.js'),
            detail: '.github/workflows/pr-checks.yml must run scripts/check-minor-bumps.js as a merge gate',
        },
        {
            name: 'tag-time-guard',
            ok: releaseYml.includes('check-minor-bumps.js'),
            detail: '.github/workflows/release.yml must run scripts/check-minor-bumps.js before it builds',
        },
    ];
    for (const layer of layers) {
        record('minor-bump-enforced', `repo -> ${layer.name}`, layer.ok, layer.detail);
    }
}

// --- DISCIPLINE 5: the Marketplace publish is resilient and keeps the token
// off argv. Both are release-pipeline rules that were previously only comments.
{
    const releaseYml = readIfExists('.github/workflows/release.yml') || '';
    // Matched against the same path the wrapper check below looks for: a bare
    // `publish-marketplace.js` substring also matches test-publish-marketplace.js,
    // which made a job that merely runs the wrapper's own unit test look like an
    // unguarded publish.
    const publishJobs = [...parseJobs(releaseYml).entries()].filter(
        ([, text]) => /tfx\s+extension\s+publish/.test(text) || text.includes('scripts/publish-marketplace.js'),
    );
    if (publishJobs.length === 0) {
        record('marketplace-publish-retry', 'release.yml -> publish job', false, 'no job in release.yml publishes the extension; the signature cannot verify the publish disciplines');
    }
    for (const [jobId, text] of publishJobs) {
        const viaWrapper = text.includes('scripts/publish-marketplace.js');
        record(
            'marketplace-publish-retry',
            `release.yml -> ${jobId}`,
            viaWrapper,
            viaWrapper
                ? 'publishes through scripts/publish-marketplace.js (bounded retry on transient upstream failures)'
                : 'invokes tfx directly with no bounded retry: one transient 5xx/timeout burns the release and orphans the draft (v1.2.7)',
        );
        const tokenOnArgv = /--token\s+["'$]/.test(text);
        record(
            'marketplace-token-off-argv',
            `release.yml -> ${jobId}`,
            !tokenOnArgv,
            tokenOnArgv
                ? 'the minted Entra token is passed as a CLI argument, exposing it in /proc/<pid>/cmdline for the process lifetime (CWE-214)'
                : 'the token is not passed on argv',
        );
    }
}

// ---------------------------------------------------------------------------
// Report + exemption reconciliation
// ---------------------------------------------------------------------------
let failed = false;
const usedExemptions = new Set();
const byCheck = new Map();
for (const f of findings) {
    if (!byCheck.has(f.check)) byCheck.set(f.check, []);
    byCheck.get(f.check).push(f);
}

for (const [check, rows] of byCheck) {
    console.log(`\n[${check}]`);
    for (const row of rows) {
        const key = `${check}::${row.site}`;
        const exemption = EXEMPTIONS[key];
        if (row.ok) {
            if (exemption) {
                // Bidirectional: a stale exemption is itself a finding, so the
                // table cannot outlive the reason it was added.
                console.error(`  STALE-EXEMPTION ${row.site}: now passes, but is still exempted ("${exemption}"). Remove the EXEMPTIONS entry.`);
                usedExemptions.add(key);
                failed = true;
            } else {
                console.log(`  OK   ${row.site}: ${row.detail}`);
            }
            continue;
        }
        if (exemption) {
            usedExemptions.add(key);
            console.log(`  EXEMPT ${row.site}: ${row.detail} — exempted: ${exemption}`);
            continue;
        }
        console.error(`  FAIL ${row.site}: ${row.detail}`);
        failed = true;
    }
}

for (const key of Object.keys(EXEMPTIONS)) {
    if (!usedExemptions.has(key)) {
        console.error(`\nFAIL: EXEMPTIONS has an entry for '${key}', but the signature enumerated no such site. Remove it (the site was renamed or deleted).`);
        failed = true;
    }
}

if (failed) {
    console.error(
        '\ncheck-enforced-disciplines: FAILED. A rule this project relies on is documented or declared but not enforced. ' +
        'Enforce it (add the CI leg / the test / the guard) or add a justified EXEMPTIONS entry.',
    );
    process.exit(1);
}

console.log(`\ncheck-enforced-disciplines: all ${findings.length} enumerated disciplines are enforced (${tasks.length} task(s)).`);
