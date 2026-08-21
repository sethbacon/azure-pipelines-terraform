#!/usr/bin/env node
'use strict'

// Single source of truth for "what is a task directory?".
//
// Three scripts used to answer that question independently — check-versions.js
// and for-each-task.js each walked exactly two directory levels looking for a
// task.json, while copy-build.js walked Tasks/ recursively and packaged whatever
// it found. Only the gates were restrictive, so a task.json one level deeper was
// validated by nobody and shipped anyway (issue #37). The fix is not a better
// filter in copy-build.js; it is that composition and enumeration stop being two
// functions with two definitions.
//
// Canonical layout, matching the sibling extensions:
//
//   Tasks/<Family>/<TaskDirVn>/task.json
//
// exactly two directory levels below Tasks/. Anything else under Tasks/ is a
// layout error, not a thing to be quietly copied or quietly skipped.

const fs = require('node:fs')
const path = require('node:path')

// Directory levels below Tasks/ at which a task.json is canonical.
// Tasks/<Family>/<TaskDir>/task.json === 2.
const TASK_DIR_DEPTH = 2

function toPosix(p) {
  return p.split(path.sep).join('/')
}

/**
 * Every immediate subdirectory of Tasks/<Family>/ that contains a task.json,
 * as sorted repo-relative POSIX paths ('Tasks/<Family>/<TaskDir>').
 *
 * This is the enumeration every gate and the packager agree on.
 */
function discoverTaskDirs(root) {
  const tasksRoot = path.join(root, 'Tasks')
  if (!fs.existsSync(tasksRoot)) return []

  const dirs = []
  for (const family of fs.readdirSync(tasksRoot, { withFileTypes: true })) {
    if (!family.isDirectory()) continue
    const familyPath = path.join(tasksRoot, family.name)
    for (const taskDir of fs.readdirSync(familyPath, { withFileTypes: true })) {
      if (!taskDir.isDirectory()) continue
      if (fs.existsSync(path.join(familyPath, taskDir.name, 'task.json'))) {
        dirs.push(`Tasks/${family.name}/${taskDir.name}`)
      }
    }
  }
  return dirs.sort()
}

/**
 * Every entry under `dir`, recursively, WITHOUT following symlinks.
 *
 * `fs.readdirSync(.., { withFileTypes: true })` reports a symlink dirent as
 * isSymbolicLink() — isFile() and isDirectory() are both false for it. That is
 * the exact property copy-build.js used to get wrong: its `if (isDirectory)`
 * / `else` fell through to `copyFileSync`, which FOLLOWS the link and copies
 * the target's bytes (issue #40). Here a symlink is reported as a symlink and
 * never descended into, so callers decide what to do about it rather than
 * silently dereferencing it.
 *
 * Returns entries as { rel, kind } where rel is repo-relative POSIX and kind is
 * one of 'file' | 'dir' | 'symlink' | 'other'.
 */
function walkTree(root, relDir, shouldDescend = () => true) {
  const out = []
  const absDir = path.join(root, relDir)
  if (!fs.existsSync(absDir)) return out

  const stack = [relDir]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(path.join(root, current), { withFileTypes: true })) {
      const rel = toPosix(path.join(current, entry.name))
      if (entry.isSymbolicLink()) {
        out.push({ rel, kind: 'symlink' })
      } else if (entry.isDirectory()) {
        out.push({ rel, kind: 'dir' })
        if (shouldDescend(rel)) stack.push(rel)
      } else if (entry.isFile()) {
        out.push({ rel, kind: 'file' })
      } else {
        out.push({ rel, kind: 'other' })
      }
    }
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

/** True when `rel` is inside one of `taskDirs` (or is one of them). */
function insideTaskDir(rel, taskDirs) {
  return taskDirs.some((dir) => rel === dir || rel.startsWith(`${dir}/`))
}

/** True when `rel` is an ancestor directory of one of `taskDirs`. */
function ancestorOfTaskDir(rel, taskDirs) {
  return taskDirs.some((dir) => dir.startsWith(`${rel}/`))
}


// ── The DECLARED universe ────────────────────────────────────────────────────
//
// `discoverTaskDirs` answers "what is here". It cannot answer the question a
// green gate actually rests on: "is what is here what was supposed to be here?"
// Today Tasks/ holds zero tracked files, and a gate that walks it exits 0 having
// read nothing — a result textually identical to one that read three tasks and
// found them sound. That is the estate's recurring defect, and it is the reason
// this file also owns a DECLARATION.
//
// The declaration lives in task-universe.json at the repo root, in the shape the
// estate already uses for the blind-audit code-universe gate
// (security-orchestration `PROFILES[].codeUniverse[]`: `{ path, expect, minFiles,
// why }`, Phase 0b, which aborts a run rather than grade a tree nobody opened).
// It is data rather than a constant in this module so that a scratch tree — the
// mutation self-tests, a fixture, a future split of this repo — carries its own
// and is measured against it, instead of being measured against this repo's.
//
// The three outcomes are deliberately different things:
//
//   declared absent, none found  -> PASS, with a SCAFFOLD banner saying in words
//                                   that nothing was validated. Honest, because
//                                   the emptiness was declared in advance and is
//                                   re-checked on every run.
//   declared absent, some found  -> FAIL. The declaration has outlived its scope;
//                                   the gates would otherwise start reporting on
//                                   real task code under a floor of zero.
//   declared present, too few    -> FAIL. The floor issue #39 asked for: once N
//                                   tasks must exist, enumerating fewer is a
//                                   broken checkout or a broken walk, not a pass.
//
// What makes this honest rather than a loophole is the second row. "Examined
// nothing because there is nothing yet" is a claim that must be written down,
// justified, and falsified automatically the moment it stops being true. An
// undeclared zero is "examined nothing and called it clean"; there is no way to
// stay in the first state by accident.

const UNIVERSE_FILE = 'task-universe.json'

/** A `why` shorter than this is not a justification, it is a placeholder. */
const MIN_WHY_LENGTH = 40

const SCAFFOLD_BANNER =
  'SCAFFOLD: 0 tasks enumerated under Tasks/ — this gate proved nothing about task code. ' +
  `Declared in ${UNIVERSE_FILE} as expect:"absent"; it fails the moment a task lands.`

/**
 * Read and validate task-universe.json. A missing or malformed declaration is an
 * error in itself: without one, zero tasks is unfalsifiable.
 */
function readTaskUniverse(root) {
  const file = path.join(root, UNIVERSE_FILE)
  const errors = []
  if (!fs.existsSync(file)) {
    errors.push(
      `${UNIVERSE_FILE}: missing — the gates walk Tasks/ and cannot tell "nothing here yet" from ` +
        '"found nothing" without a declaration of what should be here',
    )
    return { declaration: null, errors }
  }

  let declaration
  try {
    declaration = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    errors.push(`${UNIVERSE_FILE}: not valid JSON — ${err.message}`)
    return { declaration: null, errors }
  }

  if (declaration.expect !== 'absent' && declaration.expect !== 'present') {
    errors.push(`${UNIVERSE_FILE}: expect must be "absent" or "present", got ${JSON.stringify(declaration.expect)}`)
  }
  if (typeof declaration.why !== 'string' || declaration.why.trim().length < MIN_WHY_LENGTH) {
    errors.push(
      `${UNIVERSE_FILE}: why must be at least ${MIN_WHY_LENGTH} characters explaining what this declaration ` +
        'asserts and when it stops being true — a declaration nobody justified is one nobody will revisit',
    )
  }
  if (declaration.expect === 'absent') {
    if (declaration.minTasks !== undefined && declaration.minTasks !== 0) {
      errors.push(`${UNIVERSE_FILE}: expect:"absent" cannot carry minTasks ${JSON.stringify(declaration.minTasks)}`)
    }
  } else if (declaration.expect === 'present') {
    if (!Number.isInteger(declaration.minTasks) || declaration.minTasks < 1) {
      errors.push(
        `${UNIVERSE_FILE}: expect:"present" needs an integer minTasks >= 1 (the floor a run must clear), got ` +
          JSON.stringify(declaration.minTasks),
      )
    }
  }

  return { declaration, errors }
}

/**
 * Measure Tasks/ against the declaration.
 *
 * Returns { dirs, count, declaration, errors, banner, proved }. `errors` is
 * empty only when the tree matches what was declared; `banner` is a non-null
 * string exactly when the run enumerated nothing, and every caller must print
 * it instead of an unqualified success line.
 */
function checkTaskUniverse(root) {
  const dirs = discoverTaskDirs(root)
  const { declaration, errors } = readTaskUniverse(root)

  if (declaration && errors.length === 0) {
    if (declaration.expect === 'absent' && dirs.length > 0) {
      errors.push(
        `${UNIVERSE_FILE}: declares Tasks/ absent, but ${dirs.length} task(s) are present (${dirs.join(', ')}). ` +
          'The declaration has outlived its scope: set expect:"present" and minTasks to the count that must exist, ' +
          'so the floor moves with reality instead of staying at zero while real task code is judged against it',
      )
    }
    if (declaration.expect === 'present' && dirs.length < declaration.minTasks) {
      errors.push(
        `${UNIVERSE_FILE}: declares at least ${declaration.minTasks} task(s), but ${dirs.length} were enumerated ` +
          `(${dirs.length === 0 ? 'none' : dirs.join(', ')}). Either the checkout is incomplete or the walk is broken; ` +
          'a gate that examined fewer tasks than exist has not run',
      )
    }
  }

  return {
    dirs,
    count: dirs.length,
    declaration,
    errors,
    banner: dirs.length === 0 && errors.length === 0 ? SCAFFOLD_BANNER : null,
    proved: dirs.length > 0,
  }
}

module.exports = { TASK_DIR_DEPTH, UNIVERSE_FILE, SCAFFOLD_BANNER, readTaskUniverse, checkTaskUniverse, discoverTaskDirs, walkTree, insideTaskDir, ancestorOfTaskDir, toPosix }
