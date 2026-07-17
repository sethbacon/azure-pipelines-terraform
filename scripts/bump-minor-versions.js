#!/usr/bin/env node
// Auto-bumps each task's task.json Minor for every task whose src/ changed since
// the previous release without a Minor increase — the manual step in CLAUDE.md's
// Release Process, automated. ADO agents cache tasks by Major.Minor, so a code
// (especially security) fix that ships without a Minor bump would reach the
// Marketplace but never running agents. Run on the release-please Release PR by
// .github/workflows/release-pr-minor-bumps.yml; also runnable locally.
//
// Usage: node scripts/bump-minor-versions.js [prevRef]
//   prevRef defaults to the newest v*.*.* tag not at HEAD (the previous release).
//
// Reuses check-minor-bumps.js's analysis so the "which tasks need a bump" rule
// lives in exactly one place. The bump is idempotent: the analysis compares each
// task's CURRENT (working-tree) Minor against the previous release's, so a task
// already bumped since prevRef — whether by an earlier feature PR (the documented
// double-increment protection) or by a previous run of this script — is reported
// as OK and left alone. Exits 0 whether or not anything needed bumping; a second
// run makes no further change.

const fs = require('fs');
const path = require('path');
const { resolvePrevRef, analyze } = require('./check-minor-bumps.js');

// Resolve task.json paths against the current working directory (the repo root
// the CLI/workflow is invoked from), mirroring how check-minor-bumps.js's git
// calls operate on the cwd — so the self-test can point both at a throwaway repo.
const repoRoot = process.cwd();

function taskJsonPath(task) {
  return path.join(repoRoot, task, 'task.json');
}

function readWorkingTreeMinor(task) {
  const raw = fs.readFileSync(taskJsonPath(task), 'utf8');
  return parseInt(JSON.parse(raw).version.Minor, 10);
}

// Match the version object's Minor value, anchored on the Major+Minor pair within
// the "version" object so no other "Minor" key can be hit. The [^{}] runs cannot
// cross an object boundary. Capture groups: (1) everything up to and including
// "Minor":, (2) an optional opening quote, (3) the digits, (4) an optional
// closing quote — so a function replacer can bump (3) while preserving the file's
// existing quoting (string vs bare number) and every other byte.
const MINOR_RE = /("version"\s*:\s*\{[^{}]*?"Major"\s*:\s*"?\d+"?[^{}]*?"Minor"\s*:\s*)("?)(\d+)("?)/;

function bumpFile(task) {
  const file = taskJsonPath(task);
  const text = fs.readFileSync(file, 'utf8');
  if (!MINOR_RE.test(text)) {
    throw new Error(`could not locate the version.Minor field in ${task}/task.json`);
  }
  let current;
  let next;
  const updated = text.replace(MINOR_RE, (_full, prefix, openQuote, digits, closeQuote) => {
    current = parseInt(digits, 10);
    next = current + 1;
    return `${prefix}${openQuote}${next}${closeQuote}`;
  });
  fs.writeFileSync(file, updated);
  return { current, next };
}

function main() {
  const prevRef = process.argv[2] || resolvePrevRef('HEAD');

  if (!prevRef) {
    console.log('bump-minor-versions: no previous release tag found; nothing to bump.');
    process.exit(0);
  }

  console.log(`bump-minor-versions: comparing ${prevRef} -> working tree`);

  let bumped = 0;
  let failed = false;

  for (const r of analyze({ prevRef, currRef: 'HEAD', readCurrMinor: readWorkingTreeMinor })) {
    if (r.kind === 'diff-error') {
      console.error(`  ! ${r.task}: could not diff (${r.message})`);
      failed = true;
    } else if (r.kind === 'version-error') {
      console.error(`  ! ${r.task}: could not read task.json version (${r.message})`);
      failed = true;
    } else if (r.kind === 'needs-bump') {
      const { current, next } = bumpFile(r.task);
      console.log(`  bumped ${r.task}: Minor ${current} -> ${next}`);
      bumped += 1;
    }
    // 'ok' (already bumped since prevRef) and 'unchanged' need no action.
  }

  if (failed) {
    console.error('\nbump-minor-versions: FAILED to analyze one or more tasks (see above).');
    process.exit(1);
  }

  if (bumped === 0) {
    console.log('bump-minor-versions: no tasks needed a Minor bump.');
  } else {
    console.log(`bump-minor-versions: bumped ${bumped} task(s).`);
  }
}

module.exports = { bumpFile, MINOR_RE };

if (require.main === module) {
  main();
}
