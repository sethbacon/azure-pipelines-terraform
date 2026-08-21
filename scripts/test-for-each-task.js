#!/usr/bin/env node
'use strict'

// Runtime self-test for the per-task npm spawn in scripts/for-each-task.js.
//
// WHY THIS ONE RUNS ON BOTH MATRIX LEGS. Every other self-test in this
// repository is a static gate proving a static gate, and runs once, on ubuntu,
// in "Check Version Consistency" or "Lint GitHub Actions". This one cannot be:
// the finding it closes is that `Tasks/` has never existed, so `npm()` has been
// called ZERO times on either leg, and the windows-2025 context has been
// reporting green over a code path it has never executed (#45). A static check
// that the source no longer says `npm.cmd` — which is what
// scripts/check-workflow-hardening.js now enforces, mutation-proved in
// scripts/test-workflow-hardening.js — is worth having and is not the same
// thing as knowing the replacement works on Windows.
//
// So this file executes the real exported `npm()` against the real npm, in the
// "Build and Test (${{ matrix.os }})" job, on both legs, on every pull request.
// If the resolution order is wrong for a Windows runner's layout, this fails on
// the PR that changes it rather than on the day the first task lands.
//
// It is an EXECUTION test, not a mutation test, and the distinction matters:
// reintroduce the platform ternary and this file still passes on ubuntu,
// because `npm` off PATH is perfectly launchable there. Only the windows leg
// would catch it. That is why the reintroduction is separately barred by a
// static gate that runs on every leg and is mutation-proved
// (check-workflow-hardening.js / test-workflow-hardening.js) — the two are
// complements, not duplicates. What this file does catch on either platform is
// a spawn that no longer works at all: point 3 below fails naming the cause.
//
// It asserts three things and observes a fourth:
//
//   1. npmCli() resolves to an existing npm-cli.js — a .js file run under node,
//      never a .cmd/.bat wrapper and never a PATH lookup.
//   2. Both resolution branches work HERE: with npm_execpath set (how CI calls
//      it, through `npm run`) and with it unset (a bare `node scripts/...`).
//      Each is checked in its own child process, because the resolution is
//      memoised per process.
//   3. npm(['--version']) — the exact function every ACTIONS entry calls —
//      completes. On the pre-fix code this is the call that threw on win32.
//   4. On Windows only, and WITHOUT asserting either way: what the old
//      `execFileSync('npm.cmd', …)` actually does on this runner. The audit
//      could not determine from Linux whether it raises EINVAL (the
//      CVE-2024-27980 hardening) or silently reaches cmd.exe quoting (the
//      BatBadBut reading). Both readings condemn the old code, so this records
//      the answer in the log rather than making the build depend on it.

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')

const MODULE = path.join(__dirname, 'for-each-task.js')
const { npm, npmCli } = require(MODULE)

let failures = 0
const report = (ok, message) => {
  if (ok) console.log(`  OK   ${message}`)
  else {
    console.error(`  FAIL ${message}`)
    failures += 1
  }
}

console.log(`platform: ${process.platform}, node ${process.version}`)

// ── 1. The entrypoint resolves to npm's own JS ───────────────────────────────
let cli = null
try {
  cli = npmCli()
} catch (err) {
  report(false, `npmCli() threw: ${err.message}`)
}

if (cli) {
  report(path.basename(cli) === 'npm-cli.js', `npmCli() resolved to an npm-cli.js: ${cli}`)
  report(fs.existsSync(cli), `the resolved entrypoint exists on disk: ${cli}`)
  report(!/\.(cmd|bat)$/i.test(cli), 'the resolved entrypoint is not a .cmd/.bat wrapper')
}

// ── 2. Both resolution branches, each in a clean process ─────────────────────
function resolveIn(label, env) {
  const child = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(MODULE)}).npmCli())`], {
    encoding: 'utf8',
    env,
  })
  if (child.status !== 0) {
    report(false, `${label}: the child could not resolve npm-cli.js — ${(child.stderr || '').trim()}`)
    return null
  }
  const resolved = child.stdout.trim()
  report(fs.existsSync(resolved), `${label}: resolved ${resolved}`)
  return resolved
}

const withoutExecpath = { ...process.env }
delete withoutExecpath.npm_execpath
const bundled = resolveIn('npm_execpath unset (a bare `node scripts/for-each-task.js`)', withoutExecpath)

if (bundled) {
  const viaEnv = resolveIn('npm_execpath set (how `npm run deps` calls it)', { ...process.env, npm_execpath: bundled })
  report(viaEnv === bundled, 'npm_execpath is honoured verbatim — the child is the same npm as the parent')
}

// ── 3. The real npm(), the function every ACTIONS entry calls ────────────────
try {
  npm(['--version', '--no-update-notifier'], { stdio: 'ignore' })
  const version = execFileSync(process.execPath, [cli, '--version', '--no-update-notifier'], { encoding: 'utf8' }).trim()
  report(/^\d+\.\d+\.\d+/.test(version), `npm(['--version']) completed under process.execPath — npm ${version}`)
} catch (err) {
  report(false, `npm(['--version']) threw, which is the #45 defect itself: ${err.message}`)
}

// ── 4. Windows only: what the old call actually did ──────────────────────────
if (process.platform === 'win32') {
  try {
    execFileSync('npm.cmd', ['--version'], { stdio: 'ignore' })
    console.log(
      '  NOTE the pre-fix call execFileSync("npm.cmd", …) SUCCEEDED on this runner, so this node build carries no ' +
        '.cmd guard and the BatBadBut reading applied: the `dir` argument reached cmd.exe quoting rather than ' +
        'CreateProcess argv rules (#45).',
    )
  } catch (err) {
    console.log(
      `  NOTE the pre-fix call execFileSync("npm.cmd", …) failed on this runner with ${err.code || err.message} — the ` +
        'CVE-2024-27980 hardening reading applied, and `npm run deps` would have failed outright on the first task (#45).',
    )
  }
} else {
  console.log('  note: the win32-only observation is skipped on this leg; the windows-2025 leg records it.')
}

if (failures > 0) {
  console.error(`\ntest-for-each-task: ${failures} check(s) failed.`)
  process.exit(1)
}
console.log(`\ntest-for-each-task: the per-task npm spawn works on ${process.platform}, as node running npm's own entrypoint.`)
