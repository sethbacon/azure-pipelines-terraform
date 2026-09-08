#!/usr/bin/env node
'use strict'

// Self-test for check-docs-claims.js's required-status-check-provenance
// surface (azure-pipelines-terraform#1120): a `<!-- required-checks:begin -->`
// table names, per required commit-status/check-run context, the workflow
// that produces it -- and that workflow must actually be ABLE to post it, not
// merely exist. That script had no self-test at all before this; this file
// covers only the new surface, table-driven, rather than re-deriving the
// other four claim surfaces this script already checks.
//
// Every case builds a minimal fixture repository (a README with the table
// under test, plus whatever check-docs-claims.js needs to avoid a vacuity
// failure), runs the real script as a SUBPROCESS, and asserts on its --json
// `findings` -- filtered to this surface, so drift in the other claim
// surfaces (controls, ci-jobs, file-table, third-party-notices) can never
// make this test flaky.
//
// Case 2 (`renamed`) IS the mutation this script's own header says to run:
// "rename the documented workflow -> the gate goes red". Deleting the
// workflow file from the fixture is the same defect a real `git mv` of
// release-pr-guard.yml would produce.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync, execFileSync } = require('node:child_process')

const SCRIPT = path.join(__dirname, 'check-docs-claims.js')
const CONTEXT = 'release-guard/link-regrade'
const WORKFLOW_REL = '.github/workflows/release-pr-guard.yml'

let failures = 0
const report = (ok, msg) => {
  if (ok) console.log(`  OK   ${msg}`)
  else {
    console.error(`  FAIL ${msg}`)
    failures += 1
  }
}

/**
 * A minimal repo root: a git tree (isGitIgnored() shells out to `git`),
 * SECURITY.md (avoids the vacuity guard), and a README carrying the
 * required-checks table under test. `workflowBody` is written at
 * WORKFLOW_REL unless omitted (the "renamed/deleted" mutation).
 */
function fixture(name, { workflowBody } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `docs-claims-${name}-`))
  execFileSync('git', ['init', '-q'], { cwd: root })
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true })
  fs.writeFileSync(path.join(root, 'SECURITY.md'), '# Security\n')
  fs.writeFileSync(
    path.join(root, 'README.md'),
    [
      '# Fixture',
      '',
      '<!-- required-checks:begin -->',
      '| Context | Workflow |',
      '| --- | --- |',
      `| \`${CONTEXT}\` | \`${WORKFLOW_REL}\` |`,
      '<!-- required-checks:end -->',
      '',
    ].join('\n'),
  )
  if (workflowBody !== undefined) {
    fs.writeFileSync(path.join(root, WORKFLOW_REL), workflowBody)
  }
  return root
}

function run(root) {
  const r = spawnSync(process.execPath, [SCRIPT, root, '--json'], { encoding: 'utf8' })
  try {
    return JSON.parse(r.stdout)
  } catch {
    throw new Error(`unparseable output for ${root}:\n${r.stdout}\n${r.stderr}`)
  }
}

const surfaceFindings = (j) => j.findings.filter((f) => f.kind === 'path-ref' && f.message.includes(CONTEXT))

// ── 1. clean: the documented workflow declares statuses: write ───────────
{
  const root = fixture('clean', {
    workflowBody: ['name: Release PR Guard', 'jobs:', '  closing-keywords:', '    name: Release PR closes only what it completes', '    permissions:', '      statuses: write', '    runs-on: ubuntu-latest', '    steps: []', ''].join('\n'),
  })
  const hits = surfaceFindings(run(root))
  report(hits.length === 0, 'a workflow that declares statuses: write satisfies the documented context')
}

// ── 2. mutation: the documented workflow has been renamed/deleted ────────
{
  const root = fixture('renamed', {})
  const hits = surfaceFindings(run(root))
  report(hits.length === 1 && /does not exist/.test(hits[0].message), 'a renamed/deleted workflow is reported, by name, against this exact context')
}

// ── 3. workflow exists but can post neither a status nor a matching check run
{
  const root = fixture('cannot-post', {
    workflowBody: ['name: Release PR Guard', 'jobs:', '  closing-keywords:', '    name: Some Unrelated Job', '    permissions:', '      contents: read', '    runs-on: ubuntu-latest', '    steps: []', ''].join('\n'),
  })
  const hits = surfaceFindings(run(root))
  report(hits.length === 1 && /cannot post this context/.test(hits[0].message), 'a workflow with neither statuses: write nor a matching job name is reported')
}

// ── 4. a job literally named for the context also satisfies the claim (the
//      check-run shape, as opposed to the commit-status shape case 1 covers)
{
  const root = fixture('job-name-match', {
    workflowBody: ['name: Release PR Guard', 'jobs:', '  regrade:', `    name: ${CONTEXT}`, '    permissions:', '      contents: read', '    runs-on: ubuntu-latest', '    steps: []', ''].join('\n'),
  })
  const hits = surfaceFindings(run(root))
  report(hits.length === 0, 'a job named exactly for the context satisfies the claim without statuses: write')
}

console.log(failures ? `\n${failures} case(s) failed.` : '\nAll cases passed.')
process.exit(failures ? 1 : 0)
