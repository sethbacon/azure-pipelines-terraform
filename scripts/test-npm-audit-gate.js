#!/usr/bin/env node
// Self-test for npm-audit-gate.js: an exception accepts exactly the advisory it
// was reviewed against, and the gate fails on everything else -- another
// advisory, a changed range, an expired or mismatched exception, an unknown
// severity, an unreadable report, an npm error. Runs main() with a fake npm
// audit, so no network is needed; the real exceptions file is validated too.

'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { main, loadExceptions } = require('./npm-audit-gate')

const PICOMATCH = {
  source: 1247710,
  name: 'picomatch',
  dependency: 'picomatch',
  title: 'picomatch vulnerable to ReDoS through single-branch repeated extglobs',
  url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
  severity: 'high',
  range: '<=4.0.7',
}
const OTHER = {
  source: 1,
  name: 'left-pad',
  dependency: 'left-pad',
  title: 'something else',
  url: 'https://github.com/advisories/GHSA-2222-3333-4444',
  severity: 'moderate',
  range: '<1.0.1',
}

// The shape npm 11 prints: the advisory on its own package's entry, and the
// packages that depend on it naming that package as a string.
function report(...advisories) {
  const vulnerabilities = {}
  for (const adv of advisories) {
    vulnerabilities[adv.name] = { name: adv.name, severity: adv.severity, via: [adv], nodes: [`node_modules/${adv.name}`] }
  }
  vulnerabilities.tinyglobby = { name: 'tinyglobby', severity: 'high', via: ['picomatch'], nodes: ['node_modules/tinyglobby'] }
  return JSON.stringify({ auditReportVersion: 2, vulnerabilities })
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-audit-gate-'))
function exceptionsFile(entries) {
  const file = path.join(dir, `exceptions-${Math.random().toString(36).slice(2)}.json`)
  fs.writeFileSync(file, JSON.stringify({ exceptions: entries }))
  return file
}
const accepted = {
  advisory: 'GHSA-fc5q-39xc-vjpf',
  package: 'picomatch',
  range: '<=4.0.7',
  expires: '2026-12-17',
  reason: 'test',
}

function run(argv, { stdout = report(), status = 0, stderr = '', exceptions = [accepted], today = '2026-11-17' } = {}) {
  const lines = []
  const log = console.log
  const err = console.error
  const write = process.stdout.write
  const writeErr = process.stderr.write
  console.log = (...a) => lines.push(a.join(' '))
  console.error = (...a) => lines.push(a.join(' '))
  process.stdout.write = (s) => lines.push(String(s)) || true
  process.stderr.write = (s) => lines.push(String(s)) || true
  try {
    const code = main(argv, { runAudit: () => ({ status, stdout, stderr }), today, exceptionsFile: exceptionsFile(exceptions) })
    return { code, out: lines.join('\n') }
  } finally {
    console.log = log
    console.error = err
    process.stdout.write = write
    process.stderr.write = writeErr
  }
}

const cases = [
  ['a clean report passes', () => {
    const r = run(['--audit-level=moderate'], { stdout: report() })
    assert.strictEqual(r.code, 0, r.out)
  }],
  ['the accepted advisory passes, and is named in the log', () => {
    const r = run(['--audit-level=moderate'], { stdout: report(PICOMATCH), status: 1 })
    assert.strictEqual(r.code, 0, r.out)
    assert.match(r.out, /Accepted until 2026-12-17: GHSA-fc5q-39xc-vjpf picomatch <=4\.0\.7 \(high\)/)
  }],
  ['another advisory at the level still fails', () => {
    const r = run(['--audit-level=moderate'], { stdout: report(PICOMATCH, OTHER), status: 1 })
    assert.strictEqual(r.code, 1, r.out)
    assert.match(r.out, /FAIL GHSA-2222-3333-4444 left-pad <1\.0\.1 \(moderate\).*no exception covers it/)
  }],
  ['an advisory below the level is ignored', () => {
    const r = run(['--audit-level=high'], { stdout: report(OTHER), status: 1 })
    assert.strictEqual(r.code, 0, r.out)
  }],
  ['a changed range ends the exception (a patched release exists)', () => {
    const r = run(['--audit-level=moderate'], { stdout: report({ ...PICOMATCH, range: '<4.0.8' }), status: 1 })
    assert.strictEqual(r.code, 1, r.out)
    assert.match(r.out, /now says <4\.0\.8/)
  }],
  ['an expired exception fails', () => {
    const r = run(['--audit-level=moderate'], { stdout: report(PICOMATCH), status: 1, today: '2026-12-18' })
    assert.strictEqual(r.code, 1, r.out)
    assert.match(r.out, /expired on 2026-12-17/)
  }],
  ['an exception for another package does not apply', () => {
    const r = run(['--audit-level=moderate'], { stdout: report({ ...PICOMATCH, name: 'micromatch' }), status: 1 })
    assert.strictEqual(r.code, 1, r.out)
    assert.match(r.out, /the exception is for picomatch, not micromatch/)
  }],
  ['an unknown severity fails', () => {
    const r = run(['--audit-level=critical'], { stdout: report({ ...OTHER, severity: 'severe' }), status: 1 })
    assert.strictEqual(r.code, 1, r.out)
    assert.match(r.out, /unknown severity 'severe'/)
  }],
  ['an npm error fails and prints its code, so the CI retry can recognise a network failure', () => {
    const r = run(['--audit-level=moderate'], {
      stdout: JSON.stringify({ error: { code: 'ECONNRESET', summary: 'network read ECONNRESET' } }),
      status: 1,
    })
    assert.strictEqual(r.code, 1, r.out)
    assert.match(r.out, /ECONNRESET/)
  }],
  ['output that is not the JSON report fails', () => {
    const r = run(['--audit-level=moderate'], { stdout: 'npm error something', status: 1 })
    assert.strictEqual(r.code, 1, r.out)
  }],
  ['a report without "vulnerabilities" fails', () => {
    assert.throws(() => run(['--audit-level=moderate'], { stdout: '{"auditReportVersion":2}' }), /no "vulnerabilities" object/)
  }],
  ['a missing or unknown --audit-level is a usage error', () => {
    assert.strictEqual(run([]).code, 2)
    assert.strictEqual(run(['--audit-level=severe']).code, 2)
    assert.strictEqual(run(['--audit-level=moderate', '--omit=dev']).code, 2)
  }],
  ['a malformed exception is refused', () => {
    for (const bad of [
      { ...accepted, expires: '2026-02-30' },
      { ...accepted, advisory: 'CVE-2026-1' },
      { ...accepted, reason: ' ' },
      { advisory: accepted.advisory, package: 'picomatch', range: '<=4.0.7', expiry: '2026-12-17', reason: 'typo' },
    ]) {
      assert.throws(() => run(['--audit-level=moderate'], { exceptions: [bad] }), /exceptions\[0\]/, JSON.stringify(bad))
    }
  }],
  ['the repository exceptions file is valid', () => {
    loadExceptions(path.join(__dirname, 'lib', 'npm-audit-exceptions.json'))
  }],
]

let failed = 0
try {
  for (const [name, fn] of cases) {
    try {
      fn()
      console.log(`ok - ${name}`)
    } catch (e) {
      failed++
      console.log(`not ok - ${name}\n${e.stack}`)
    }
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
if (failed > 0) {
  console.log(`npm-audit-gate.js self-test: ${failed} of ${cases.length} case(s) failed.`)
  process.exit(1)
}
console.log(`npm-audit-gate.js self-test: all ${cases.length} cases passed.`)
