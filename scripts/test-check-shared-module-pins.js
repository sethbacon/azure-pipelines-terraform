#!/usr/bin/env node
'use strict'

// Self-test for check-shared-module-pins.js: proves the gate still rejects each
// shape of drift it exists for, on a fixture it builds itself. A gate whose
// thresholds silently stop matching reality is the failure mode
// azure-pipelines-terraform#1108 finding 2 describes for check-proxy-parity.js,
// so this runs in the same CI step as the gate.

const assert = require('node:assert')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const GATE = path.join(__dirname, 'check-shared-module-pins.js')
const CORE = '@4cloudguru/pipeline-task-core'

function writeTask(root, family, task, range, locked, nested) {
  const dir = path.join(root, 'Tasks', family, task)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: task.toLowerCase(), dependencies: { [CORE]: range } }))
  const packages = { '': { dependencies: { [CORE]: range } }, [`node_modules/${CORE}`]: { version: locked } }
  if (nested) packages[`node_modules/@4cloudguru/pipeline-task-ado/node_modules/${CORE}`] = { version: nested }
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }))
}

function run(root) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, root, '--json'], { encoding: 'utf8' })
    return { code: 0, body: JSON.parse(stdout) }
  } catch (err) {
    return { code: err.status, body: JSON.parse(err.stdout) }
  }
}

function fixture(build) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pins-selftest-'))
  try {
    build(root)
    return run(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

// Lockstep holds.
{
  const { code, body } = fixture((root) => {
    writeTask(root, 'A', 'AV1', '^0.9.0', '0.9.0')
    writeTask(root, 'B', 'BV1', '^0.9.0', '0.9.0')
  })
  assert.strictEqual(code, 0, 'two tasks on one version must pass')
  assert.deepStrictEqual(body.findings, [])
  assert.strictEqual(body.enumerated.length, 2)
  assert.strictEqual(body.scanned, 2)
}

// Each invariant, broken in turn, is reported against the drifting task only.
for (const [label, args] of [
  ['range', ['^0.8.0', '0.9.0']],
  ['locked version', ['^0.9.0', '0.8.1']],
  ['nested copy', ['^0.9.0', '0.9.0', '0.7.2']],
]) {
  const { code, body } = fixture((root) => {
    writeTask(root, 'A', 'AV1', '^0.9.0', '0.9.0')
    writeTask(root, 'B', 'BV1', ...args)
  })
  assert.strictEqual(code, 1, `${label} drift must fail`)
  assert.deepStrictEqual(new Set(body.findings.map((f) => f.site)), new Set([`Tasks/B/BV1:pin:${CORE}`]), `${label}: only the drifting task is a site`)
}

// A task with no shared dependency is not a site, and a repository with none
// enumerates nothing but still reports how many manifests it read.
{
  const { code, body } = fixture((root) => {
    const dir = path.join(root, 'Tasks', 'A', 'AV1')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'a', dependencies: { 'left-pad': '^1.0.0' } }))
  })
  assert.strictEqual(code, 0)
  assert.deepStrictEqual(body.enumerated, [])
  assert.strictEqual(body.scanned, 1)
}

console.log('OK: check-shared-module-pins.js self-test passed (lockstep holds; range, version and nested-copy drift each reported; empty universe carries a denominator).')
