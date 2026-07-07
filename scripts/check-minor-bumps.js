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

let prevRef = process.argv[2];
const currRef = process.argv[3] || 'HEAD';

if (!prevRef) {
  const head = git(`rev-parse ${currRef}`);
  const tags = git('tag --sort=-v:refname')
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
  // The previous release is the newest v* tag that does not point at the commit
  // being released (which typically already carries this release's own tag).
  prevRef = tags.find((t) => {
    try {
      return git(`rev-list -n1 ${t}`) !== head;
    } catch {
      return false;
    }
  });
}

if (!prevRef) {
  console.log('check-minor-bumps: no previous release tag found; nothing to compare.');
  process.exit(0);
}

console.log(`check-minor-bumps: comparing ${prevRef} -> ${currRef}`);
let failed = false;

for (const task of TASKS) {
  let changed;
  try {
    changed = git(`diff --name-only ${prevRef} ${currRef} -- ${task}/src`);
  } catch (e) {
    console.error(`  ! ${task}: could not diff (${e.message})`);
    failed = true;
    continue;
  }
  if (!changed) {
    continue; // src unchanged since the last release; no bump required
  }
  let prevMinor;
  let currMinor;
  try {
    prevMinor = minorAt(prevRef, task);
    currMinor = minorAt(currRef, task);
  } catch (e) {
    console.error(`  ! ${task}: could not read task.json version (${e.message})`);
    failed = true;
    continue;
  }
  if (currMinor > prevMinor) {
    console.log(`  OK   ${task}: src changed, Minor ${prevMinor} -> ${currMinor}`);
  } else {
    console.error(
      `  FAIL ${task}: src changed since ${prevRef} but Minor did not increase (still ${currMinor}). ` +
      `Bump Minor in ${task}/task.json.`,
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
