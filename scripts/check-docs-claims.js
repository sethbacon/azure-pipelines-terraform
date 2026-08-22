#!/usr/bin/env node
'use strict'

// ===========================================================================
// SIGNATURE for the DOCUMENTATION-OVERCLAIM defect class.
//
// The class: a document asserts a control the repository does not implement,
// and nothing re-checks it. A security document is the worst place for it —
// it tells a reader, a reviewer and the next maintainer not to look. The
// instance that prompted this script was SECURITY.md asserting a signed,
// SBOM-attested `.vsix` published behind an environment approval when none of
// the three existed anywhere in `.github/` (#19), corroborated by an
// `@cyclonedx/cyclonedx-npm` devDependency that no workflow and no npm script
// ever invoked — so the claim survived a casual check of `package.json`.
//
// PROVENANCE. Ported from `scripts/check-docs-claims.js` in the sibling
// extensions azure-pipelines-terraform and azure-pipelines-packer, which carry
// byte-identical copies. Sections 2 and 3 are that script's checks, carried
// across with its git-ignore exemption intact. Section 1 and section 4 are new
// here, and are the reason the port was worth making: the sibling script checks
// docs against CODE (file tables, CI job lists), and the claim that went wrong
// here is a claim about WORKFLOWS.
//
// NOT ported: the sibling's section 2, which reconciles CONTRIBUTING.md's
// `<!-- ci-jobs:begin -->` region against `unit-test.yml`. This repository has
// neither file. When either lands, port it rather than reinventing it.
//
// What this script enforces
// -------------------------
//   1. SUPPLY-CHAIN CONTROL LEDGER. SECURITY.md's `<!-- controls:begin -->`
//      region must carry one row per control in CONTROLS below, each marked
//      `enforced` or `planned`, and the mark must match what the workflows
//      actually do. BIDIRECTIONAL, and the second direction is the load-bearing
//      one: `enforced` with no implementation is the original defect, and
//      `planned` with an implementation means the publish path landed (#26)
//      while the document was left behind — the claim becoming true by accident
//      is not the same as the document being correct.
//   2. FILE TABLES. A `| File | Role |` table anchored to a
//      `Tasks/<Family>/<Task>/src/` directory is a completeness claim: it must
//      name every .ts file there and no file that is absent. Prose is not a
//      completeness claim and is not checked. Inert until Tasks/ exists; the
//      enumerated counts printed at the end say so out loud, because a check
//      that silently sees nothing looks exactly like a check that passed.
//   3. REFERENCED PATHS. Any backticked repo-relative path in a checked doc
//      must exist, unless it is git-ignored (a file the docs legitimately
//      describe and the repo deliberately does not carry, e.g. configs/self.json).
//   4. CLAIM-CORROBORATING DEPENDENCIES. A tool whose mere presence in
//      package.json makes a supply-chain claim look implemented may only be
//      declared if a workflow or an npm script invokes it.
//
// Usage:  node scripts/check-docs-claims.js [repoRoot] [--json]
// Exit 0 = every checked claim holds. Exit 1 = drift, listed.
// ===========================================================================

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const JSON_OUTPUT = process.argv.includes('--json')
const ROOT = path.resolve(process.argv.filter((a) => a !== '--json')[2] || path.join(__dirname, '..'))

/** Docs whose claims are checked. A missing file is skipped, not failed. */
const DOCS = ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CLAUDE.md', 'overview.md']

const findings = []
const fail = (kind, where, message) => findings.push({ kind, where, message })

/** Counts of what was actually enumerated. An exit 0 over an empty universe is
 *  not a pass, and printing these is what tells the two apart. */
const enumerated = { controls: 0, ciJobs: 0, fileTables: 0, pathRefs: 0, claimDeps: 0, workflows: 0 }
const skipped = []

function readIfPresent(rel) {
  const full = path.join(ROOT, rel)
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n') : null
}

/* ------------------------------------------------------------------ *
 * 1. SECURITY.md's supply-chain control ledger vs the workflows.
 * ------------------------------------------------------------------ */

/**
 * Workflow bodies with whole-line comments removed. These workflows are heavily
 * commented — signature-replay.yml's header alone is forty lines of prose — and
 * a detector that fired on a comment would make writing an accurate comment
 * about a control the repo does NOT have into a build failure. Only YAML that
 * actually runs is searched. Trailing comments are left in place deliberately:
 * stripping them means guessing whether a `#` is inside a string.
 */
function workflowBodies() {
  const dir = path.join(ROOT, '.github', 'workflows')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => ({
      name: `.github/workflows/${f}`,
      text: fs
        .readFileSync(path.join(dir, f), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n'),
    }))
}

const WORKFLOWS = workflowBodies()
enumerated.workflows = WORKFLOWS.length

const pkg = (() => {
  const raw = readIfPresent('package.json')
  return raw ? JSON.parse(raw) : null
})()
const NPM_SCRIPTS = Object.values((pkg && pkg.scripts) || {}).join('\n')

/** First workflow whose runnable body matches, or null. */
function inWorkflows(re) {
  const hit = WORKFLOWS.find((w) => re.test(w.text))
  return hit ? hit.name : null
}

/**
 * The controls SECURITY.md is allowed to speak about, and how each is detected.
 * A closed set on purpose: a claim this script cannot check is a claim that
 * drifts, so an unrecognised row in the ledger is a failure rather than a pass.
 * Detection reads WORKFLOWS and npm scripts — never a document, and never a
 * dependency declaration, because being installed is not being run (see #19,
 * and section 4 below).
 */
const CONTROLS = {
  'marketplace-publish': {
    summary: 'a workflow publishes the .vsix to the Visual Studio Marketplace',
    // Two independent markers, because the estate's publish job carries both:
    // the tfx invocation itself and the azure/login step that mints the Entra
    // token it authenticates with. package.json's `package:*` scripts are NOT
    // searched — a local `tfx extension create` is the unreviewed path this
    // control is meant to replace, not evidence of the control.
    detect: () => inWorkflows(/tfx\s+extension\s+publish|publish-marketplace|azure\/login/i),
  },
  'publish-environment-approval': {
    summary: 'a job runs behind the `marketplace` GitHub Environment',
    detect: () => inWorkflows(/^\s{4,}environment:/m),
  },
  'vsix-signature': {
    summary: 'the .vsix is signed (cosign/sigstore) or carries a build-provenance attestation',
    detect: () => inWorkflows(/cosign|sigstore|attest-build-provenance/i),
  },
  'workflow-hardening': {
    summary: 'a workflow runs the workflow-hardening gate (SHA pinning, install hardening, timeouts, egress policy)',
    // The gate itself, not the properties it checks: the properties are what
    // change, and a detector that looked for `--ignore-scripts` or a SHA would
    // go green on a tree where the gate had been deleted and the flags simply
    // happened to still be there — which is the exact state this control
    // replaced (#21, #22, #23, #30). The gate is now the shared definition
    // rather than a local script, so the workflow that calls it is what proves
    // it runs.
    detect: () => inWorkflows(/workflow-hardening\.yml/),
  },
  'dependency-scan': {
    summary: 'a workflow runs a dependency vulnerability scan beyond the npm registry\'s own advisory database',
    // The scanner, not the schedule: `npm audit` is already in ci.yml and is a
    // different control (its scope is gated by check-audit-scope.js). This row
    // is about OSV coverage specifically, which is what #58 asked for and what
    // the siblings run weekly.
    //
    // Anchored to `uses:` on purpose. A bare /osv-scanner/i matched the step
    // that echoes "## OSV-Scanner results" into the job summary, so deleting the
    // scanner and keeping the heading left this row reading `enforced` and the
    // gate reporting OK — caught by mutating it, which is the only way that kind
    // of thing is ever caught. If this control is ever reimplemented as a
    // checksum-verified binary download (see SECURITY.md's residual risk about
    // the mutable image tag), this expression has to move with it.
    detect: () => inWorkflows(/uses:\s*\S*osv-scanner/i),
  },
  'sbom-attestation': {
    summary: 'an SBOM is generated and attested by a workflow',
    // Workflows only. An `sbom` npm script that no job calls satisfies section 4
    // (the declaration is honest) without being a control — conflating the two
    // is how an uninvoked generator came to stand in for an attested SBOM.
    detect: () => inWorkflows(/cyclonedx|syft|attest-sbom/i),
  },
}

const STATUSES = new Set(['enforced', 'planned'])

const security = readIfPresent('SECURITY.md')
if (!security) {
  fail('controls', 'SECURITY.md', 'not found — the supply-chain claim ledger cannot be checked and this signature would pass vacuously')
} else {
  const region = /<!--\s*controls:begin\s*-->([\s\S]*?)<!--\s*controls:end\s*-->/.exec(security)
  if (!region) {
    // Not a failure: the three extensions sharing this file adopted the ledger at
    // different times, and one that has not yet written one is not making a false
    // claim. It is recorded instead, and the enumerated count below prints 0 --
    // which is the difference between "checked, found nothing wrong" and "did not
    // check", and the whole reason those counts are printed at all.
    skipped.push('controls: SECURITY.md has no <!-- controls:begin --> region, so no supply-chain claim was checked')
  } else {
    const declared = new Map()
    for (const line of region[1].split('\n')) {
      if (!line.trimStart().startsWith('|')) continue
      const cells = line.split('|').slice(1, -1)
      if (cells.length < 2) continue
      const key = /`([a-z0-9-]+)`/.exec(cells[0])
      if (!key) continue // header row, separator row, or a prose row making no claim
      declared.set(key[1], (cells[1] || '').trim().toLowerCase())
    }

    for (const [key, status] of declared) {
      enumerated.controls++
      const control = CONTROLS[key]
      if (!control) {
        fail(
          'controls',
          `SECURITY.md -> ${key}`,
          `unrecognised control: this script has no detector for it, so the row is an unchecked claim. Add it to CONTROLS in ${path.basename(__filename)} or remove the row`,
        )
        continue
      }
      if (!STATUSES.has(status)) {
        fail('controls', `SECURITY.md -> ${key}`, `status must be one of ${[...STATUSES].join(', ')}, got ${JSON.stringify(status)}`)
        continue
      }
      const where = control.detect()
      if (status === 'enforced' && !where) {
        fail(
          'controls',
          `SECURITY.md -> ${key}`,
          `claimed as enforced, but no workflow implements it (${control.summary}). A security document that asserts an absent control is the defect this check exists for`,
        )
      }
      if (status === 'planned' && where) {
        fail(
          'controls',
          `SECURITY.md -> ${key}`,
          `recorded as planned, but ${where} now implements it (${control.summary}). Update the row to \`enforced\` in the change that landed it — a claim must not become true by accident`,
        )
      }
    }

    for (const key of Object.keys(CONTROLS)) {
      if (!declared.has(key)) {
        fail('controls', 'SECURITY.md', `the control ledger has no row for \`${key}\` (${CONTROLS[key].summary}); every control this script can check must be stated`)
      }
    }

    if (declared.size === 0) {
      fail('controls', 'SECURITY.md', 'the control ledger region parsed zero rows — the check would pass vacuously')
    }
  }
}

/* ------------------------------------------------------------------ *
 * 2. The CONTRIBUTING.md CI-job list must match the workflow it names.
 * ------------------------------------------------------------------ */
//
// The workflow is named BY THE MARKER rather than hardcoded, because the three
// extensions declare their gating jobs in different files -- unit-test.yml in
// two of them, ci.yml in the third. A constant here would have made this section
// silently inapplicable to one of them, which is the same shape of defect it
// exists to catch: a check that reads a file that is not the one doing the work.
//
//   <!-- ci-jobs:begin .github/workflows/unit-test.yml -->

/**
 * Job display names: a `name:` indented exactly four spaces is a job's name
 * (steps are nested deeper and carry a leading `- `). Matrix expressions are
 * stripped so `Build and Test X (${{ matrix.os }})` is compared as
 * `Build and Test X`, which is what a contributor-facing doc should say.
 */
function workflowJobNames(yaml) {
  const names = []
  for (const line of yaml.split('\n')) {
    const m = /^ {4}name:\s*(.+?)\s*$/.exec(line)
    if (!m) continue
    names.push(m[1].replace(/["']/g, '').replace(/\s*\(\$\{\{[^}]*\}\}\)\s*$/, '').trim())
  }
  return [...new Set(names)]
}

/**
 * Top-level job ids (2-space keys under `jobs:`). A job that declares no `name:`
 * is displayed by GitHub under its id, so it would gate a PR while being
 * invisible to workflowJobNames() above — and therefore never required in the
 * doc. Counting ids and names catches that.
 */
function workflowJobIds(yaml) {
  const body = yaml.slice(yaml.search(/^jobs:\s*$/m))
  return [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1])
}

const contributing = readIfPresent('CONTRIBUTING.md')
const ciJobsRegion = contributing
  ? /<!--\s*ci-jobs:begin\s*([^\s>]*)\s*-->([\s\S]*?)<!--\s*ci-jobs:end\s*-->/.exec(contributing)
  : null

if (!contributing) {
  skipped.push('ci-jobs: no CONTRIBUTING.md, so no documented CI job list was checked')
} else if (!ciJobsRegion) {
  skipped.push('ci-jobs: CONTRIBUTING.md has no <!-- ci-jobs:begin --> region, so no documented CI job list was checked')
} else if (!ciJobsRegion[1]) {
  fail(
    'ci-jobs',
    'CONTRIBUTING.md',
    'the <!-- ci-jobs:begin --> marker names no workflow. Write the path it documents, e.g. ' +
      '`<!-- ci-jobs:begin .github/workflows/unit-test.yml -->` — otherwise this check has to guess which file gates a pull request',
  )
} else {
  const workflowPath = ciJobsRegion[1]
  const workflow = readIfPresent(workflowPath)
  if (!workflow) {
    fail('ci-jobs', 'CONTRIBUTING.md', `${workflowPath} not found — the marker names a workflow that does not exist`)
  } else {
    const declared = workflowJobNames(workflow).sort()
    // One bullet per job, the job name in the FIRST backticked span. Reading
    // every backtick in the region instead would pull the explanatory
    // `scripts/*.js` references in as if they were job names.
    const documented = ciJobsRegion[2]
      .split('\n')
      .map((line) => /^\s*[-*]\s+`([^`]+)`/.exec(line))
      .filter(Boolean)
      .map((x) => x[1].trim())
      .sort()
    const missing = declared.filter((n) => !documented.includes(n))
    const extra = documented.filter((n) => !declared.includes(n))
    if (missing.length) fail('ci-jobs', 'CONTRIBUTING.md', `CI jobs that gate a PR but are undocumented: ${missing.join(', ')}`)
    if (extra.length) fail('ci-jobs', 'CONTRIBUTING.md', `documented CI jobs that ${workflowPath} does not declare: ${extra.join(', ')}`)
    if (declared.length === 0) fail('ci-jobs', workflowPath, 'no job names parsed — the check would pass vacuously')
    const ids = workflowJobIds(workflow)
    if (ids.length === 0) {
      fail('ci-jobs', workflowPath, 'no job ids parsed — the check would pass vacuously')
    } else if (ids.length < declared.length) {
      fail('ci-jobs', workflowPath, `parsed ${declared.length} job names but only ${ids.length} job ids — the name parser is over-matching`)
    } else {
      // Names are deduped (matrix legs share one display name), so the only safe
      // assertion is that no job is NAMELESS: every id must be able to reach a
      // name. Approximated by requiring at least one name per job block, which is
      // what a missing `name:` breaks.
      const nameLines = (workflow.match(/^ {4}name:/gm) || []).length
      if (nameLines < ids.length) {
        fail(
          'ci-jobs',
          workflowPath,
          `${ids.length - nameLines} job(s) declare no \`name:\` and would gate a PR under their job id, invisible to this check: ${ids.join(', ')}`,
        )
      }
    }
    enumerated.ciJobs = declared.length
  }
}

/* ------------------------------------------------------------------ *
 * 3. File tables must enumerate their src/ directory exactly.
 *    (Ported verbatim in behaviour from the sibling extensions.)
 * ------------------------------------------------------------------ */

/**
 * Parses the markdown table that FOLLOWS `from`, returning the backticked
 * filename in each row's first cell. Returns null when the next non-blank
 * content is not a `| File |` table, i.e. the section makes no completeness
 * claim.
 */
function fileTableAfter(text, from) {
  const header = /\n\|\s*File\s*\|/i.exec(text.slice(from))
  if (!header) return null
  // The table must belong to THIS anchor: refuse to reach past the next
  // markdown heading, or a table two sections down would be attributed here.
  const nextHeading = text.slice(from).search(/\n#{2,4} /)
  if (nextHeading >= 0 && header.index > nextHeading) return null

  const start = from + header.index + 1
  const names = []
  for (const line of text.slice(start).split('\n')) {
    if (!line.trimStart().startsWith('|')) break
    const firstCell = line.split('|')[1] ?? ''
    const named = /`([A-Za-z0-9_.-]+\.tsx?)`/.exec(firstCell)
    if (named) names.push(named[1])
  }
  return names
}

for (const doc of DOCS) {
  const text = readIfPresent(doc)
  if (!text) continue
  const anchor = /`(Tasks\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/src\/(?:[A-Za-z0-9_.-]+\/)*)`/g
  let m
  while ((m = anchor.exec(text)) !== null) {
    const dir = m[1]
    const listed = fileTableAfter(text, m.index)
    if (listed === null) continue // prose section: no completeness claim
    enumerated.fileTables++
    const full = path.join(ROOT, dir)
    if (!fs.existsSync(full)) {
      fail('file-table', `${doc} -> ${dir}`, 'the documented source directory does not exist')
      continue
    }
    const actual = fs.readdirSync(full).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts'))
    const undocumented = actual.filter((f) => !listed.includes(f)).sort()
    const phantom = listed.filter((f) => !actual.includes(f)).sort()
    if (undocumented.length) fail('file-table', `${doc} -> ${dir}`, `file table omits: ${undocumented.join(', ')}`)
    if (phantom.length) fail('file-table', `${doc} -> ${dir}`, `file table names files that do not exist: ${phantom.join(', ')}`)
  }
}

/* ------------------------------------------------------------------ *
 * 3. Referenced repo-relative paths must exist.
 * ------------------------------------------------------------------ */

/**
 * A git-ignored path is a file the docs legitimately describe but the repo
 * deliberately does not carry (`configs/self.json`, the personal publisher
 * override a maintainer creates locally). Absent-and-ignored is correct;
 * absent-and-tracked-nowhere is the drift this check is for.
 */
function isGitIgnored(rel) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', rel], { cwd: ROOT, stdio: 'ignore' })
    return true
  } catch (err) {
    // Exit 1 = not ignored (a real finding). Any other status means git could
    // not answer, and a check that cannot answer must not silently pass.
    if (err && err.status === 1) return false
    fail('path-ref', rel, `could not determine git-ignore status (is git available?): ${err && err.message}`)
    return true
  }
}

for (const doc of DOCS) {
  const text = readIfPresent(doc)
  if (!text) continue
  const ref = /`((?:Tasks|scripts|docs|configs|images|\.github)\/[A-Za-z0-9_./-]+)`/g
  const seen = new Set()
  let m
  while ((m = ref.exec(text)) !== null) {
    const rel = m[1].replace(/\/$/, '')
    // Globs and <Placeholder> templates are patterns, not paths.
    if (/[*<>{}]/.test(rel) || seen.has(rel)) continue
    // `[`docs/initiatives/`](https://github.com/other/repo/...)` names a path in
    // ANOTHER repository and says so in the href. It is not a claim about this
    // tree, and requiring it to resolve here would push writers toward vaguer
    // references — the opposite of what this signature is for.
    if (/^\]\(https?:\/\//.test(text.slice(m.index + m[0].length))) continue
    seen.add(rel)
    enumerated.pathRefs++
    if (!fs.existsSync(path.join(ROOT, rel)) && !isGitIgnored(rel)) {
      fail('path-ref', doc, `references a path that does not exist: ${rel}`)
    }
  }
}

/* ------------------------------------------------------------------ *
 * 4. A claim-corroborating dependency must actually be invoked.
 * ------------------------------------------------------------------ */

/**
 * Tools whose presence in package.json reads as evidence that a supply-chain
 * control exists. `@cyclonedx/cyclonedx-npm` was declared here, invoked by
 * nothing, and installed into every CI job — 175 transitive packages that
 * bought no control and made SECURITY.md's SBOM claim survive a spot check
 * (#19). Declaring one of these is a claim; it has to be backed by a call.
 * Keyed by package name; the value is what an invocation looks like.
 */
const CLAIM_TOOLS = {
  '@cyclonedx/cyclonedx-npm': /cyclonedx-npm/i,
  '@cyclonedx/bom': /cyclonedx-bom|\bcyclonedx\b/i,
  '@sigstore/cli': /\bsigstore\b/i,
  cosign: /\bcosign\b/i,
  syft: /\bsyft\b/i,
}

if (pkg) {
  const declared = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
  for (const [name, invocation] of Object.entries(CLAIM_TOOLS)) {
    if (!(name in declared)) continue
    enumerated.claimDeps++
    const where = inWorkflows(invocation) || (invocation.test(NPM_SCRIPTS) ? 'package.json scripts' : null)
    if (!where) {
      fail(
        'claim-dependency',
        `package.json -> ${name}`,
        'declared but invoked by no workflow and no npm script. An installed-but-uninvoked supply-chain tool corroborates a control the repository does not have: wire it into the workflow that uses it, or drop it until that workflow exists',
      )
    }
  }
}

/* ------------------------------------------------------------------ *
 * Vacuity guards. A signature that checked nothing is indistinguishable
 * from a signature that found nothing, so refuse to report the latter.
 * ------------------------------------------------------------------ */

if (enumerated.workflows === 0) {
  fail('vacuity', '.github/workflows', 'no workflow files found — every control detector would report "not implemented" for the wrong reason')
}
if (!readIfPresent('SECURITY.md') || !readIfPresent('README.md')) {
  fail('vacuity', ROOT, 'SECURITY.md and README.md are the documents this signature exists to check; both must be present')
}

/* ------------------------------------------------------------------ */

const summary =
  `enumerated: ${enumerated.controls} supply-chain control(s) over ${enumerated.workflows} workflow(s), ` +
  `${enumerated.ciJobs} documented CI job(s), ` +
  `${enumerated.pathRefs} referenced path(s), ${enumerated.fileTables} file table(s), ` +
  `${enumerated.claimDeps} claim-corroborating dependenc(ies).`

if (JSON_OUTPUT) {
  console.log(JSON.stringify({ enumerated, skipped, findings, failures: findings.length }, null, 2))
  process.exit(findings.length ? 1 : 0)
}

// Printed above the summary, not folded into it: a section that did not run is
// the one thing a count of zero cannot distinguish from a section that ran and
// found nothing.
for (const s of skipped) console.log(`  not checked here — ${s}`)
console.log(summary)

if (findings.length) {
  console.error('')
  for (const f of findings) console.error(`FAIL [${f.kind}] ${f.where}: ${f.message}`)
  console.error(`\n${findings.length} documented claim(s) do not match what this repository does.`)
  process.exit(1)
}

console.log('OK: every checked documented claim matches what this repository does.')
