#!/usr/bin/env node
'use strict'

// ===========================================================================
// SIGNATURE for the SHARED-MODULE VERSION DRIFT defect class.
//
// The class: an extension's sibling tasks resolve DIFFERENT versions of the
// same shared security package, so a fix released in the package reaches some
// tasks and not others, and no check says so. The extension family enforces
// byte-identical shared SOURCE modules (check-shared-modules.js) but nothing
// held the shared DEPENDENCIES in lockstep: on 2026-09-05 one commit of
// azure-pipelines-terraform carried three resolved versions of
// @4cloudguru/pipeline-task-core (0.7.1, 0.7.2, 0.8.0) and two of
// @4cloudguru/pipeline-task-ado across its tasks, and check-proxy-parity.js --
// a per-feature MINIMUM -- was green (azure-pipelines-terraform#1108).
//
// What this script enforces
// -------------------------
//   For each SHARED package, every Tasks/<Family>/<Task> that depends on it
//   (dependencies, not devDependencies) must:
//     1. declare the SAME range in package.json as every other task, and
//     2. resolve to the SAME version in package-lock.json as every other task,
//        with exactly ONE copy of the package in that task's lock (a nested
//        second copy is how a range mismatch between this package and another
//        shared package that depends on it manifests -- see the 0.x caret
//        trap recorded in the ledger for entry 1110).
//   A task that does not depend on the package is not a site. A repository in
//   which NO task depends on any shared package is reported with `scanned` so
//   an empty universe is distinguishable from a walk that looked nowhere.
//
// The unit is (package x task). The identity of a site is
// `Tasks/<Family>/<Task>:pin:<package>`, which is what the replay ledger
// records; the message says which of the two invariants failed and against
// which version the fleet agrees on.
//
// Usage:  node scripts/check-shared-module-pins.js [repoRoot] [--json]
// Exit 0 = every task in lockstep. Exit 1 = drift, listed. Exit 2 = could not run.
// ===========================================================================

const fs = require('node:fs')
const path = require('node:path')

const JSON_OUTPUT = process.argv.includes('--json')
const ROOT = path.resolve(process.argv.filter((a) => a !== '--json')[2] || path.join(__dirname, '..'))

/** The packages whose fixes must reach every task at once. */
const SHARED = ['@4cloudguru/pipeline-task-core', '@4cloudguru/pipeline-task-ado']

const findings = []
const fail = (site, message) => findings.push({ site, message })

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    return { __error: err.message }
  }
}

/** Every Tasks/<Family>/<Task> with a package.json, sorted. */
function tasks() {
  const out = []
  const tasksDir = path.join(ROOT, 'Tasks')
  if (!fs.existsSync(tasksDir)) return out
  for (const family of fs.readdirSync(tasksDir).sort()) {
    const familyDir = path.join(tasksDir, family)
    if (!fs.statSync(familyDir).isDirectory()) continue
    for (const leaf of fs.readdirSync(familyDir).sort()) {
      const dir = path.join(familyDir, leaf)
      if (fs.existsSync(path.join(dir, 'package.json'))) out.push({ label: `Tasks/${family}/${leaf}`, dir })
    }
  }
  return out
}

/** Every lock entry for `pkg` in a v2/v3 lockfile: [{ path, version }]. */
function lockCopies(lock, pkg) {
  const copies = []
  for (const [key, entry] of Object.entries(lock.packages || {})) {
    if (key === `node_modules/${pkg}` || key.endsWith(`/node_modules/${pkg}`)) {
      copies.push({ path: key, version: entry && entry.version })
    }
  }
  return copies
}

const enumerated = []
const rows = [] // { pkg, task, range, locked, copies }
const scanned = tasks().length

for (const task of tasks()) {
  const pkgJson = readJson(path.join(task.dir, 'package.json'))
  if (pkgJson.__error) {
    fail(`${task.label}:pin`, `package.json could not be parsed: ${pkgJson.__error}`)
    continue
  }
  const deps = pkgJson.dependencies || {}
  const lockPath = path.join(task.dir, 'package-lock.json')
  const lock = fs.existsSync(lockPath) ? readJson(lockPath) : null
  for (const pkg of SHARED) {
    if (!(pkg in deps)) continue
    const site = `${task.label}:pin:${pkg}`
    enumerated.push(site)
    if (!lock || lock.__error) {
      fail(site, `declares ${pkg} but has no parseable package-lock.json${lock ? ` (${lock.__error})` : ''}`)
      rows.push({ pkg, task: task.label, range: deps[pkg], locked: null, copies: 0, site })
      continue
    }
    const copies = lockCopies(lock, pkg)
    const top = copies.find((c) => c.path === `node_modules/${pkg}`)
    rows.push({ pkg, task: task.label, range: deps[pkg], locked: top ? top.version : null, copies: copies.length, site })
    if (!top) {
      fail(site, `declares ${pkg} ${deps[pkg]} but package-lock.json has no top-level node_modules/${pkg} entry`)
    } else if (copies.length > 1) {
      fail(
        site,
        `resolves ${copies.length} copies of ${pkg} (${copies.map((c) => `${c.version} at ${c.path}`).join(', ')}) -- a nested copy means a range somewhere excludes the hoisted version, and the delegated code runs whichever copy is nested`,
      )
    }
  }
}

// Lockstep: within each package, every task must agree on range AND locked version.
for (const pkg of SHARED) {
  const mine = rows.filter((r) => r.pkg === pkg && r.locked)
  if (mine.length === 0) continue
  const byLocked = new Map()
  const byRange = new Map()
  for (const r of mine) {
    byLocked.set(r.locked, (byLocked.get(r.locked) || []).concat(r.task))
    byRange.set(r.range, (byRange.get(r.range) || []).concat(r.task))
  }
  const majority = (m) => [...m.entries()].sort((a, b) => b[1].length - a[1].length || String(b[0]).localeCompare(String(a[0])))[0][0]
  if (byLocked.size > 1) {
    const fleet = majority(byLocked)
    for (const r of mine) {
      if (r.locked !== fleet) {
        fail(r.site, `resolves ${pkg}@${r.locked} while ${byLocked.get(fleet).length} sibling task(s) resolve ${fleet} -- a fix shipped in ${fleet} has not reached this task`)
      }
    }
  }
  if (byRange.size > 1) {
    const fleet = majority(byRange)
    for (const r of mine) {
      if (r.range !== fleet) {
        fail(r.site, `declares ${pkg} ${r.range} while ${byRange.get(fleet).length} sibling task(s) declare ${fleet}; Dependabot moves each task separately, so a range that differs today resolves differently tomorrow`)
      }
    }
  }
}

const summary = `enumerated: ${enumerated.length} (package x task) pin(s) across ${scanned} task manifest(s); ${SHARED.length} shared package(s) checked.`

if (JSON_OUTPUT) {
  console.log(JSON.stringify({ enumerated, scanned, rows, findings, failures: findings.length }, null, 2))
  process.exit(findings.length ? 1 : 0)
}

console.log(summary)
for (const r of rows) console.log(`  ${r.task.padEnd(56)} ${r.pkg.padEnd(34)} ${String(r.range).padEnd(9)} -> ${r.locked}${r.copies > 1 ? ` (${r.copies} copies)` : ''}`)
if (findings.length) {
  console.error('')
  for (const f of findings) console.error(`FAIL ${f.site}: ${f.message}`)
  console.error(`\n${findings.length} shared-module pin(s) out of lockstep.`)
  process.exit(1)
}
if (enumerated.length === 0) console.log('  (no task depends on a shared package here -- universe empty by composition)')
console.log('OK: every task resolves the same version of each shared package.')
