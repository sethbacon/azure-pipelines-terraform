#!/usr/bin/env node
// Enforces the mandatory Minor-bump rule at release time: any task whose src/
// changed since the previous release tag MUST have its task.json Minor incremented.
// ADO agents cache tasks by Major.Minor, so a code (especially security) fix that
// ships without a Minor bump would be published to the Marketplace but never reach
// running agents. Wired into the release `guard` job; also runnable locally.
//
// Usage: node scripts/check-minor-bumps.js [prevRef] [currRef]
//   prevRef defaults to the newest v*.*.* tag that is not the current HEAD commit
//           (i.e. the previous release); currRef defaults to HEAD.
// Only changes under <task>/src count — test/doc-only changes do not require a bump.
//
// The analysis is also reused by scripts/bump-minor-versions.js, so the pieces
// below are exported via module.exports and the CLI runs only under the
// `require.main === module` guard at the bottom. The CLI output strings are
// asserted verbatim by scripts/test-check-minor-bumps.js and must not change.

const { execSync } = require('child_process');

const TASKS = [
  'Tasks/TerraformTask/TerraformTaskV5',
  'Tasks/TerraformInstaller/TerraformInstallerV1',
  'Tasks/TerraformProviderMirror/TerraformProviderMirrorV1',
  'Tasks/TerraformModulePublish/TerraformModulePublishV1',
  'Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1',
  'Tasks/TerraformPolicyCheck/TerraformPolicyCheckV1',
  'Tasks/TerraformDriftReport/TerraformDriftReportV1',
  'Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1',
  'Tasks/TerraformDocs/TerraformDocsV1',
  'Tasks/Markdown2Html/Markdown2HtmlV1',
  'Tasks/PublishKbArticle/PublishKbArticleV1',
];

function git(args) {
  return execSync(`git ${args}`, { encoding: 'utf8' }).trim();
}

function minorAt(ref, taskDir) {
  const raw = git(`show ${ref}:${taskDir}/task.json`);
  return parseInt(JSON.parse(raw).version.Minor, 10);
}

// Resolve the previous release ref for a given currRef: the newest v*.*.* tag
// that does not point at currRef's commit. Non-semver tags are filtered out and
// the remaining tags are sorted by version (newest first). Returns undefined
// when no such tag exists.
function resolvePrevRef(currRef) {
  const head = git(`rev-parse ${currRef}`);
  const tags = git('tag --sort=-v:refname')
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
  // The previous release is the newest v* tag that does not point at the commit
  // being released (which typically already carries this release's own tag).
  return tags.find((t) => {
    try {
      return git(`rev-list -n1 ${t}`) !== head;
    } catch {
      return false;
    }
  });
}

// Classify every task by whether its src/ changed between prevRef and currRef and
// whether its Minor increased. Returns one result object per task, in TASKS order:
//   { task, kind: 'unchanged' }                              — src did not change
//   { task, kind: 'ok',         prevMinor, currMinor }       — src changed, Minor bumped
//   { task, kind: 'needs-bump', prevMinor, currMinor }       — src changed, Minor NOT bumped
//   { task, kind: 'diff-error', message }                    — the diff itself failed
//   { task, kind: 'version-error', message }                 — task.json version unreadable
// `readCurrMinor(task)` supplies the "current" Minor to compare against prevRef's
// (default: the Minor committed at currRef). bump-minor-versions.js overrides it
// to read the working-tree Minor so its bump is idempotent.
function analyze({ prevRef, currRef, readCurrMinor }) {
  const readCurr = readCurrMinor || ((task) => minorAt(currRef, task));
  const results = [];
  for (const task of TASKS) {
    let changed;
    try {
      changed = git(`diff --name-only ${prevRef} ${currRef} -- ${task}/src`);
    } catch (e) {
      results.push({ task, kind: 'diff-error', message: e.message });
      continue;
    }
    if (!changed) {
      results.push({ task, kind: 'unchanged' }); // src unchanged since the last release; no bump required
      continue;
    }
    let prevMinor;
    let currMinor;
    try {
      prevMinor = minorAt(prevRef, task);
      currMinor = readCurr(task);
    } catch (e) {
      results.push({ task, kind: 'version-error', message: e.message });
      continue;
    }
    if (currMinor > prevMinor) {
      results.push({ task, kind: 'ok', prevMinor, currMinor });
    } else {
      results.push({ task, kind: 'needs-bump', prevMinor, currMinor });
    }
  }
  return results;
}

function main() {
  let prevRef = process.argv[2];
  const currRef = process.argv[3] || 'HEAD';

  if (!prevRef) {
    prevRef = resolvePrevRef(currRef);
  }

  if (!prevRef) {
    console.log('check-minor-bumps: no previous release tag found; nothing to compare.');
    process.exit(0);
  }

  console.log(`check-minor-bumps: comparing ${prevRef} -> ${currRef}`);
  let failed = false;

  for (const r of analyze({ prevRef, currRef })) {
    if (r.kind === 'diff-error') {
      console.error(`  ! ${r.task}: could not diff (${r.message})`);
      failed = true;
    } else if (r.kind === 'unchanged') {
      // no bump required
    } else if (r.kind === 'version-error') {
      console.error(`  ! ${r.task}: could not read task.json version (${r.message})`);
      failed = true;
    } else if (r.kind === 'ok') {
      console.log(`  OK   ${r.task}: src changed, Minor ${r.prevMinor} -> ${r.currMinor}`);
    } else {
      console.error(
        `  FAIL ${r.task}: src changed since ${prevRef} but Minor did not increase (still ${r.currMinor}). ` +
        `Bump Minor in ${r.task}/task.json.`,
      );
      failed = true;
    }
  }

  if (failed) {
    console.error(
      '\ncheck-minor-bumps: FAILED. Every task whose src/ changed since the last release ' +
      'must have its Minor bumped — ADO agents cache tasks by Major.Minor. See CLAUDE.md > Release Process.',
    );
    process.exit(1);
  }
  console.log('check-minor-bumps: all changed tasks have a Minor bump.');
}

module.exports = { TASKS, git, minorAt, resolvePrevRef, analyze };

if (require.main === module) {
  main();
}
