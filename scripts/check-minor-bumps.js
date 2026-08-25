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
// Changes under <task>/src OR to <task>/task.json itself count (#676 -- a
// defaultValue-only edit in task.json, e.g. flipping a security-relevant input
// like requireGpgSignature, carries the same cached-agent staleness risk as a
// src/ change and must not be able to ship without a Minor bump). A change to
// <task>/package.json's `dependencies` (not devDependencies), or to a
// non-dev-only entry in <task>/package-lock.json, counts too (#264) -- a
// runtime library bump changes the bytes bundled into the .vsix just as much
// as a src/ edit, and agents caching by Major.Minor would otherwise never see
// it. Changes under <task>/Tests or docs elsewhere still do not require a bump.
//
// The analysis is also reused by scripts/bump-minor-versions.js, so the pieces
// below are exported via module.exports and the CLI runs only under the
// `require.main === module` guard at the bottom. The CLI output strings are
// asserted verbatim by scripts/test-check-minor-bumps.js and must not change.

const { execFileSync } = require('child_process');
const { discoverTaskDirs } = require('./lib/task-dirs.js');

// The task list is DERIVED from the Tasks/*/*/task.json directory scan (see
// scripts/lib/task-dirs.js) relative to the current working directory — mirroring
// how the git calls below operate on the cwd, so the self-tests can point both at
// a throwaway repo — rather than hand-maintained here (issue #502).
function getTaskDirs() {
  return discoverTaskDirs(process.cwd());
}

// Takes an argv array (not a pre-built string) and runs it via execFileSync,
// which spawns git directly with no intervening shell -- ref/taskDir values
// (the latter ultimately from a directory-name scan of the checked-out tree,
// e.g. a PR-introduced Tasks/* folder) are passed through as literal argv
// elements and can never be interpreted as shell metacharacters, closing the
// command/argument-injection flagged on the previous execSync(`git ${args}`)
// template-string form.
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function minorAt(ref, taskDir) {
  const raw = git(['show', `${ref}:${taskDir}/task.json`]);
  return parseInt(JSON.parse(raw).version.Minor, 10);
}

// Reads and parses a JSON file at a given ref, or null when the path does not
// exist there (e.g. a task added within the compared range).
function readJsonAt(ref, filePath) {
  let raw;
  try {
    raw = git(['show', `${ref}:${filePath}`]);
  } catch {
    return null;
  }
  return JSON.parse(raw);
}

// True when a task's PRODUCTION dependency surface changed between two refs
// (#264): package.json's `dependencies` object, or any package-lock.json entry
// not exclusively reachable from devDependencies. npm's lockfile v2/v3 format
// marks a `packages` entry `dev: true` only when nothing outside
// devDependencies depends on it, which is exactly the set `npm ci --omit=dev`
// drops before it is bundled into the .vsix — so a version change confined to
// those entries (or to devDependencies in package.json) never alters what
// ships and must not by itself require a Minor bump.
function productionDependenciesChanged(prevRef, currRef, task) {
  const prevPkg = readJsonAt(prevRef, `${task}/package.json`);
  const currPkg = readJsonAt(currRef, `${task}/package.json`);
  if (JSON.stringify(prevPkg?.dependencies ?? {}) !== JSON.stringify(currPkg?.dependencies ?? {})) {
    return true;
  }

  const prevPackages = readJsonAt(prevRef, `${task}/package-lock.json`)?.packages ?? {};
  const currPackages = readJsonAt(currRef, `${task}/package-lock.json`)?.packages ?? {};
  for (const key of new Set([...Object.keys(prevPackages), ...Object.keys(currPackages)])) {
    if (key === '') continue; // the lockfile's own root project entry, not a dependency
    const prevEntry = prevPackages[key];
    const currEntry = currPackages[key];
    const prevVersion = prevEntry && !prevEntry.dev ? prevEntry.version : undefined;
    const currVersion = currEntry && !currEntry.dev ? currEntry.version : undefined;
    if (prevVersion !== currVersion) return true;
  }
  return false;
}

// Resolve the previous release ref for a given currRef: the newest v*.*.* tag
// that does not point at currRef's commit. Non-semver tags are filtered out and
// the remaining tags are sorted by version (newest first). Returns undefined
// when no such tag exists.
function resolvePrevRef(currRef) {
  const head = git(['rev-parse', currRef]);
  const tags = git(['tag', '--sort=-v:refname'])
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
  // The previous release is the newest v* tag that does not point at the commit
  // being released (which typically already carries this release's own tag).
  return tags.find((t) => {
    try {
      return git(['rev-list', '-n1', t]) !== head;
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
  for (const task of getTaskDirs()) {
    let changed;
    let dependencyFilesChanged;
    try {
      changed = git(['diff', '--name-only', prevRef, currRef, '--', `${task}/src`, `${task}/task.json`]);
      dependencyFilesChanged = git(['diff', '--name-only', prevRef, currRef, '--', `${task}/package.json`, `${task}/package-lock.json`]);
    } catch (e) {
      results.push({ task, kind: 'diff-error', message: e.message });
      continue;
    }
    if (!changed && dependencyFilesChanged) {
      // package.json/package-lock.json changed, but only a change to the
      // PRODUCTION dependency surface counts (#264) -- a devDependencies-only
      // edit never reaches the shipped .vsix.
      try {
        changed = productionDependenciesChanged(prevRef, currRef, task) ? dependencyFilesChanged : '';
      } catch (e) {
        results.push({ task, kind: 'diff-error', message: e.message });
        continue;
      }
    }
    if (!changed) {
      results.push({ task, kind: 'unchanged' }); // nothing that ships changed since the last release; no bump required
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

module.exports = { getTaskDirs, git, minorAt, resolvePrevRef, analyze, productionDependenciesChanged };

if (require.main === module) {
  main();
}
