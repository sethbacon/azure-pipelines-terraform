#!/usr/bin/env node
// `npm audit --audit-level=<level>`, with reviewed exceptions.
//
// Usage (from a directory with a package-lock.json):
//   node <repo>/scripts/npm-audit-gate.js --audit-level=moderate
//
// npm audit cannot except a single advisory, so an advisory that no published
// release fixes fails every build until upstream ships one. This gate runs
// `npm audit --json` and fails, as npm audit would, on any advisory at or above
// the level -- unless scripts/lib/npm-audit-exceptions.json accepts it. An
// exception names the advisory, the package and the affected range it was
// reviewed against, and an expiry date. It stops applying, and the gate fails
// again, when any of those no longer holds: in particular when the advisory's
// range changes, which is what happens when a patched release is published.
// SECURITY.md records why each exception was accepted.
//
// Anything the gate cannot read fails it: output that is not npm's JSON report,
// an error report (a network failure prints its code, which the CI step's retry
// recognises), an unknown severity, a malformed exceptions file.

'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { npmCli } = require('./for-each-task')

const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical']
const EXCEPTIONS_FILE = path.join(__dirname, 'lib', 'npm-audit-exceptions.json')
const EXCEPTION_KEYS = ['advisory', 'package', 'range', 'expires', 'reason']

function loadExceptions(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!parsed || !Array.isArray(parsed.exceptions) || Object.keys(parsed).length !== 1) {
    throw new Error(`${file}: expected {"exceptions": [...]}`)
  }
  for (const [i, e] of parsed.exceptions.entries()) {
    const where = `${file}: exceptions[${i}]`
    const keys = e && typeof e === 'object' ? Object.keys(e) : []
    if (keys.length !== EXCEPTION_KEYS.length || !EXCEPTION_KEYS.every((k) => keys.includes(k))) {
      throw new Error(`${where} must have exactly the keys ${EXCEPTION_KEYS.join(', ')}`)
    }
    if (!/^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/.test(e.advisory)) throw new Error(`${where}: advisory must be a GHSA id`)
    for (const k of ['package', 'range', 'reason']) {
      if (typeof e[k] !== 'string' || !e[k].trim()) throw new Error(`${where}: ${k} must be a non-empty string`)
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.expires) || new Date(`${e.expires}T00:00:00Z`).toISOString().slice(0, 10) !== e.expires) {
      throw new Error(`${where}: expires must be a date, YYYY-MM-DD`)
    }
  }
  return parsed.exceptions
}

// Each advisory in an npm 7+ `npm audit --json` report, once per affected range.
function advisoriesIn(report) {
  if (!report || typeof report.vulnerabilities !== 'object' || report.vulnerabilities === null) {
    throw new Error('not an npm audit --json report: it has no "vulnerabilities" object')
  }
  const found = new Map()
  for (const vuln of Object.values(report.vulnerabilities)) {
    for (const via of Array.isArray(vuln.via) ? vuln.via : []) {
      // A string names another vulnerable package this one depends on; that
      // package's own entry carries the advisory.
      if (!via || typeof via !== 'object') continue
      const key = `${via.url}\n${via.range}`
      if (!found.has(key)) {
        found.set(key, {
          id: String(via.url || via.source).split('/').pop(),
          name: via.name,
          severity: via.severity,
          range: via.range,
          title: via.title,
          nodes: vuln.nodes || [],
        })
      }
    }
  }
  return [...found.values()]
}

// Splits the report's advisories at or above `level` into those an exception
// accepts and those that fail the gate. `today` is YYYY-MM-DD (UTC).
function evaluate(report, exceptions, level, today) {
  const threshold = SEVERITIES.indexOf(level)
  if (threshold < 0) throw new Error(`unknown audit level '${level}'`)
  const accepted = []
  const blocking = []
  for (const adv of advisoriesIn(report)) {
    const severity = SEVERITIES.indexOf(adv.severity)
    if (severity < 0) {
      blocking.push({ adv, why: `unknown severity '${adv.severity}'` })
      continue
    }
    if (severity < threshold) continue
    const exception = exceptions.find((e) => e.advisory === adv.id)
    if (!exception) {
      blocking.push({ adv, why: 'no exception covers it' })
    } else if (exception.package !== adv.name) {
      blocking.push({ adv, why: `the exception is for ${exception.package}, not ${adv.name}` })
    } else if (exception.range !== adv.range) {
      blocking.push({
        adv,
        why: `the exception accepted the range ${exception.range}; the advisory now says ${adv.range}, usually because a patched release exists. Update the dependency and remove the exception`,
      })
    } else if (today > exception.expires) {
      blocking.push({ adv, why: `the exception expired on ${exception.expires}; review it again` })
    } else {
      accepted.push({ adv, exception })
    }
  }
  return { accepted, blocking }
}

function runNpmAudit() {
  const run = spawnSync(process.execPath, [npmCli(), 'audit', '--json'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (run.error) throw run.error
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

// Returns the exit code. `deps` replaces the npm run, the clock and the
// exceptions file in the self-test.
function main(argv, deps = {}) {
  const runAudit = deps.runAudit || runNpmAudit
  const today = deps.today || new Date().toISOString().slice(0, 10)
  const level = SEVERITIES.find((l) => argv.length === 1 && argv[0] === `--audit-level=${l}`)
  if (!level) {
    console.error(`usage: npm-audit-gate.js --audit-level=<${SEVERITIES.join('|')}>`)
    return 2
  }
  const exceptions = loadExceptions(deps.exceptionsFile || EXCEPTIONS_FILE)

  const run = runAudit()
  let report
  try {
    report = JSON.parse(run.stdout)
  } catch {
    process.stdout.write(run.stdout || '')
    process.stderr.write(run.stderr || '')
    console.log(`npm audit did not print its JSON report (exit code ${run.status}).`)
    return run.status || 1
  }
  if (report && report.error) {
    process.stderr.write(run.stderr || '')
    console.log(`npm audit failed: ${report.error.code || 'unknown error'} ${report.error.summary || ''}`.trim())
    return run.status || 1
  }

  const { accepted, blocking } = evaluate(report, exceptions, level, today)
  const describe = (adv) => `${adv.id} ${adv.name} ${adv.range} (${adv.severity}): ${adv.title} [${adv.nodes.join(', ')}]`
  for (const { adv, exception } of accepted) {
    console.log(`Accepted until ${exception.expires}: ${describe(adv)}. See scripts/lib/npm-audit-exceptions.json and SECURITY.md.`)
  }
  for (const { adv, why } of blocking) {
    console.log(`FAIL ${describe(adv)}: ${why}.`)
  }
  if (blocking.length > 0) {
    console.log(`npm audit: ${blocking.length} advisory/advisories at or above ${level} fail this gate. Run \`npm audit\` here for the dependency paths.`)
    return 1
  }
  console.log(`npm audit: no advisory at or above ${level}${accepted.length > 0 ? ` beyond the ${accepted.length} accepted above` : ''}.`)
  return 0
}

if (require.main === module) process.exit(main(process.argv.slice(2)))

module.exports = { evaluate, advisoriesIn, loadExceptions, main, SEVERITIES }
