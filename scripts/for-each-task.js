#!/usr/bin/env node
'use strict'

// Runs one npm action across every task directory (Tasks/<Family>/<TaskDirVn>).
// Tasks are independent npm packages, so there is no workspace to lean on.
//
// The enumeration comes from scripts/lib/task-dirs.js, which is also what
// check-versions.js validates and what copy-build.js packages — one definition
// of "a task" instead of three (issue #37).
//
// Three properties this script did not have:
//
//   * A FLOOR. `dirs.length === 0` printed "nothing to do" and exited 0, so
//     `npm run deps`, `npm run compile` and `npm run test:all` each reported
//     success on every CI run to date having executed nothing, on both matrix
//     legs, indistinguishable from a run that compiled and tested N tasks
//     (#39). The count is now measured against the declaration in
//     task-universe.json: a declared-empty tree still exits 0, loudly, and stops
//     doing so the moment the declaration is stale.
//
//   * An `audit` action. Under this repo's independent-package, no-workspace
//     model the root lockfile resolves only the root's own build tooling, so a
//     per-task `npm audit` is the ONLY way a task's dependency tree is ever
//     audited at all (#54). Reserved now, wired into CI now, rather than being
//     invented on the day the first task's dependencies land.
//
//   * NO WRAPPER. npm was spawned as `npm` / `npm.cmd`, chosen off
//     process.platform. `execFileSync` cannot launch a `.cmd` at all — node's
//     own child_process documentation says so in as many words ("`.bat` and
//     `.cmd` files are not executable on their own without a terminal, and
//     therefore cannot be launched using child_process.execFile()") — so the
//     win32 half of that ternary is a branch that fails, and `Tasks/` being
//     empty is the only reason the windows-2025 matrix leg has never found out
//     (#45). The obvious repair, `shell: true`, is the wrong one: node
//     RUNTIME-DEPRECATED passing `args` alongside `shell` for exactly this
//     shape (DEP0190 — "when a `.bat` or `.cmd` file is spawned with `shell`
//     enabled on Windows, the `args` array is not properly escaped or quoted"),
//     which would hand cmd.exe quoting rules a `dir` derived from repository
//     directory names. Running npm's own JS entrypoint under `process.execPath`
//     removes the wrapper, the PATH lookup and the shell together, and makes
//     the two platforms take the same code path — the same thing `tsc` below
//     has always done.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const { checkTaskUniverse } = require('./lib/task-dirs.js')

const root = path.join(__dirname, '..')

const ACTIONS = {
  // --ignore-scripts: `npm ci` runs dependency preinstall/install/postinstall/
  // prepare by default, so without it every transitive package in a task's
  // lockfile gets arbitrary code execution on the runner. The ROOT install one
  // line above this in CI is hardened and this one was not — the flag was
  // present in the hardened sibling this file was copied from and lost in the
  // copy (#21). It matters most on `build:release`, where `copy` walks each
  // task directory into ./build and tfx packages that as the .vsix.
  ci: (dir) => npm(['--prefix', dir, 'ci', '--ignore-scripts', '--no-update-notifier', '--no-progress']),
  prune: (dir) => npm(['--prefix', dir, 'prune', '--omit=dev', '--no-update-notifier', '--no-progress']),
  compile: (dir) => tsc(['-b', path.join(dir, 'tsconfig.json')]),
  test: (dir) => npm(['--prefix', dir, 'test']),
  // Run from INSIDE the task directory rather than with --prefix: `npm audit`
  // resolves the tree it audits from the working directory, and a --prefix that
  // it quietly ignores would audit the ROOT tree while reporting a task's name —
  // a per-task gate that examines the wrong package is worse than none.
  // --audit-level=high matches the root job; no --omit, because a task's
  // devDependencies build the code that ships (#20, #54).
  audit: (dir) => npm(['audit', '--audit-level=high', '--no-update-notifier', '--no-progress'], { cwd: path.join(root, dir) }),
  // Executes the COMPILED entry point the agent runs, so a CI leg on another Node
  // major proves the shipped artefact loads there. task.json declaring a Node20_1
  // handler that only ever ran under Node 24 is the gap this closes.
  smoke: (dir) => node([path.join(root, dir, 'src', 'index.js')], { cwd: path.join(root, dir) }),
}

function npm(args, options = {}) {
  execFileSync(process.execPath, [npmCli(), ...args], { stdio: 'inherit', ...options })
}

function node(args, options = {}) {
  execFileSync(process.execPath, args, { stdio: 'inherit', ...options })
}

// Where npm's own JS entrypoint is. Resolved rather than shelled out to, which
// is the whole of the fix for #45 — see the NO WRAPPER note above.
//
// Order matters, most authoritative first:
//
//   1. npm_execpath. npm sets it, for the script it is running, to the absolute
//      path of the npm-cli.js that is running. Every invocation in this repo
//      arrives through `npm run deps|compile|test:all|audit:all`, so this is the
//      normal path and it is exact: the child is the SAME npm as the parent,
//      not another one that happens to be first on PATH.
//   2. The npm that ships with THIS node. `<node>/node_modules/npm` on Windows,
//      `<node>/../lib/node_modules/npm` on POSIX — the two layouts the official
//      builds and actions/setup-node produce.
//   3. A locally installed `npm` package, if one is ever added as a dependency.
//      Issue #45 recommended `require.resolve('npm/bin/npm-cli.js')` as THE
//      fix; on its own it throws MODULE_NOT_FOUND here, because npm is not in
//      this repository's node_modules and there is no reason for it to be. It
//      is kept as a last resort rather than as the mechanism.
//
// Nothing falls back to spawning `npm` off PATH: a fallback that only ever runs
// on the platform CI cannot exercise is how this defect survived in the first
// place. Unresolvable is a hard, named error.
let npmCliPath = null
function npmCli() {
  if (npmCliPath) return npmCliPath

  const fromEnv = process.env.npm_execpath
  const nodeDir = path.dirname(process.execPath)
  const candidates = [
    fromEnv && fromEnv.endsWith('.js') ? fromEnv : null,
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      npmCliPath = candidate
      return npmCliPath
    }
  }
  try {
    npmCliPath = require.resolve('npm/bin/npm-cli.js')
    return npmCliPath
  } catch {
    /* fall through to the error below */
  }

  throw new Error(
    `Cannot locate npm's JS entrypoint (npm-cli.js). Looked at: ${candidates.join(', ')}, then require.resolve('npm/bin/npm-cli.js'). ` +
      'This script runs npm as node <npm-cli.js> on every platform rather than spawning the npm / npm-dot-cmd wrapper (#45); ' +
      'run it through `npm run <script>` so npm_execpath is set, or install node with its bundled npm.',
  )
}

function tsc(args) {
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), ...args], { stdio: 'inherit' })
}

function main() {
  const action = process.argv[2]
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) {
    console.error(`Usage: for-each-task.js <${Object.keys(ACTIONS).join('|')}>`)
    process.exit(2)
  }

  const universe = checkTaskUniverse(root)
  if (universe.errors.length > 0) {
    console.error(`for-each-task.js ${action}: the tasks on disk are not the tasks that were declared:`)
    for (const error of universe.errors) console.error(`  - ${error}`)
    process.exit(1)
  }

  if (universe.count === 0) {
    console.log(universe.banner)
    console.log(`No tasks under Tasks/ — '${action}' ran against nothing.`)
    process.exit(0)
  }

  for (const dir of universe.dirs) {
    console.log(`\n=== ${action}: ${dir} ===`)
    ACTIONS[action](dir)
  }

  console.log(`\n${action}: completed over ${universe.count} task(s) — ${universe.dirs.join(', ')}.`)
}

// The CLI body is behind require.main so that scripts/test-for-each-task.js can
// import `npm` and `npmCli` and exercise the real spawn path — on BOTH matrix
// legs — instead of asserting things about this file's text. The windows-2025
// leg reporting green on a code path it had never executed is the whole of #45.
if (require.main === module) main()

module.exports = { npm, npmCli, ACTIONS }
