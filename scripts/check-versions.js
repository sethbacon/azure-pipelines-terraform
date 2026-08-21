#!/usr/bin/env node
'use strict'

// CI gate behind the required `Check Version Consistency` context.
//
// The job's NAME promises cross-file agreement. What this asserts, in the order
// the checks run:
//
//   1. UNIVERSE      — Tasks/ is measured against the declaration in
//                      task-universe.json, so "0 tasks" is a declared, falsified-
//                      on-change state rather than a silent pass
//   2. TASK MANIFEST — canonical 8-4-4-4-12 GUID, case-folded uniqueness for
//                      both id and name, and a malformed id still registered so
//                      a duplicate of it is reported
//   3. MONOTONICITY  — each task's version compared against the SAME task at the
//                      base revision: never backwards, and never unchanged while
//                      its code changed. Azure DevOps agents cache task
//                      implementations by version, so a regression to an already-
//                      cached number ships new code under an old identity
//   4. EXTENSION     — azure-devops-extension.json's version must EQUAL
//                      .release-please-manifest.json's, not merely look like a
//                      version
//   5. PUBLISH ID    — configs/*.json read and checked: which override may opt
//                      into the public Marketplace listing, and whether the
//                      publish coordinates agree across every file that carries
//                      them
//   6. LOC KEYS      — every key a source file passes to tasks.loc(), and every
//                      key the resjson declares, must exist in task.json's
//                      `messages` map or it renders to users as raw key text
//
// This file is BYTE-IDENTICAL across azure-pipelines-terraform,
// azure-pipelines-packer and azure-pipelines-release-docs. Everything that
// legitimately differs between them is DATA, read from files each repository
// already owns — task-universe.json, azure-devops-extension.json and configs/ —
// so a rule cannot be quietly weakened in one repository by editing the copy
// that lives there.
//
// Task enumeration comes from scripts/lib/task-dirs.js — the same module
// scripts/check-package-composition.js and scripts/copy-build.js use, so the
// gates and the packager cannot disagree about what a task is.

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const { checkTaskUniverse, UNIVERSE_FILE } = require('./lib/task-dirs.js')

const root = path.join(__dirname, '..')
const errors = []
const notes = []

// What this run actually looked at. Printed unconditionally: a gate that reports
// only "passed" cannot be told apart from a gate that read nothing.
const enumerated = {
  tasks: 0,
  taskVersionsCompared: 0,
  overrides: 0,
  locKeys: 0,
  historyBase: 'n/a — no task versions to compare',
}

// ── 1. The declared universe ─────────────────────────────────────────────────

const universe = checkTaskUniverse(root)
errors.push(...universe.errors)
enumerated.tasks = universe.count

const declaration = universe.declaration || {}

// ── 2. Task manifests ────────────────────────────────────────────────────────

// Canonical 8-4-4-4-12. A bare `/^[0-9a-fA-F-]{36}$/` imposes no positional
// structure whatsoever: 36 hyphens pass, and so does any 36-character mix of
// hex and hyphens. A task id is the identity Azure DevOps installs against, so
// "shaped like a GUID" is the entire assertion — it has to be true.
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

// GUIDs are case-insensitive identifiers and Azure DevOps treats them so; two
// task.json files differing only in the case of an id are the SAME task to a
// consumer and a colliding install. Uniqueness is therefore keyed on the folded
// value, while the message reports what was written.
const seenIds = new Map()
const seenNames = new Map()

// task.json version components are written as integers in one repository and as
// quoted digits in the others, and scripts/bump-minor-versions.js deliberately
// preserves whichever form it finds (it captures the quotes and writes them
// back). Both are therefore legitimate here. What is NOT optional is comparing
// them as NUMBERS: a comparison that treats "11" as unordered, or orders it as a
// string against "9", is not a version comparison at all.
function versionComponent(value) {
  if (Number.isInteger(value)) return value >= 0 ? value : null
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return null
}

function registerUnique(map, key, rel, label, original) {
  if (map.has(key)) {
    errors.push(
      `${rel}: ${label} ${JSON.stringify(original)} is already used by ${map.get(key).rel} ` +
        `(${JSON.stringify(map.get(key).original)}) — compared case-insensitively, because that is how it collides`,
    )
    return
  }
  map.set(key, { rel, original })
}

// The task-name convention is DECLARED rather than hardcoded, because the three
// extensions sharing this file adopted it at different times and one still
// carries names that predate it. Declaring the prefix keeps the rule enforced
// everywhere; declaring the exceptions keeps the stragglers reviewable instead
// of dropping the rule for the whole repository to accommodate them.
const namePrefix = declaration.namePrefix
const nameExceptions = declaration.namePrefixExceptions || {}
if (declaration.expect === 'present' && typeof namePrefix !== 'string') {
  errors.push(
    `${UNIVERSE_FILE}: namePrefix must be a string naming the prefix every task name carries ` +
      '(with namePrefixExceptions for any that predate it) — an undeclared convention is one no gate can hold',
  )
}
if (typeof nameExceptions !== 'object' || nameExceptions === null || Array.isArray(nameExceptions)) {
  errors.push(`${UNIVERSE_FILE}: namePrefixExceptions must be an object mapping task name to the reason it is exempt`)
}

const tasks = []

for (const dir of universe.dirs) {
  const rel = `${dir}/task.json`
  let task
  try {
    task = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))
  } catch (err) {
    errors.push(`${rel}: not valid JSON — ${err.message}`)
    continue
  }
  tasks.push({ dir, rel, task })

  for (const field of ['Major', 'Minor', 'Patch']) {
    const value = task.version && task.version[field]
    if (versionComponent(value) === null) {
      errors.push(
        `${rel}: version.${field} must be a non-negative integer, or a string of digits, got ${JSON.stringify(value)}`,
      )
    }
  }

  const id = typeof task.id === 'string' ? task.id : ''
  if (!GUID.test(id)) {
    errors.push(`${rel}: id must be a canonical GUID (8-4-4-4-12 hex), got ${JSON.stringify(task.id)}`)
  }
  // Registered even when malformed. An `else if` here would skip registration
  // for a bad id, so a SECOND task could reuse the same bad id and no duplicate
  // would ever be reported — the one check that protects a consumer from an
  // install-time collision, defeated by making the id invalid.
  if (id.length > 0) registerUnique(seenIds, id.toLowerCase(), rel, 'id', task.id)

  const name = typeof task.name === 'string' ? task.name : ''
  if (typeof namePrefix === 'string' && namePrefix.length > 0) {
    const exempt = Object.prototype.hasOwnProperty.call(nameExceptions, name)
    if (exempt) {
      const why = nameExceptions[name]
      if (typeof why !== 'string' || why.trim().length < 20) {
        errors.push(
          `${UNIVERSE_FILE}: namePrefixExceptions[${JSON.stringify(name)}] must explain, in at least 20 characters, ` +
            'why this name may not carry the prefix — an exception nobody justified is one nobody will revisit',
        )
      } else {
        notes.push(`${rel}: name ${JSON.stringify(name)} is a declared exception to the ${JSON.stringify(namePrefix)} prefix — ${why}`)
      }
    } else if (!new RegExp(`^${namePrefix}[A-Z]`).test(name)) {
      errors.push(
        `${rel}: name ${JSON.stringify(task.name)} must start with the ${JSON.stringify(namePrefix)} prefix ` +
          `declared in ${UNIVERSE_FILE}, or be listed in its namePrefixExceptions with a reason`,
      )
    }
  }
  if (name.length > 0) registerUnique(seenNames, name.toLowerCase(), rel, 'name', task.name)
}

// An exception for a task that no longer exists is stale: it would silently
// re-exempt the name if it ever came back.
for (const exempt of Object.keys(nameExceptions)) {
  if (!tasks.some(({ task }) => task.name === exempt)) {
    errors.push(
      `${UNIVERSE_FILE}: namePrefixExceptions lists ${JSON.stringify(exempt)}, which no task declares — ` +
        'remove it, or the exemption outlives the task it was written for',
    )
  }
}

// ── 3. Task versions may not move backwards ──────────────────────────────────

function git(args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function isGitWorkTree() {
  try {
    return git(['rev-parse', '--is-inside-work-tree']).trim() === 'true'
  } catch {
    return false
  }
}

function resolveRev(rev) {
  try {
    return git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).trim() || null
  } catch {
    return null
  }
}

function triple(version) {
  return [version && version.Major, version && version.Minor, version && version.Patch].map((n) => {
    const value = versionComponent(n)
    return value === null ? -1 : value
  })
}

function compareTriples(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

if (tasks.length > 0) {
  if (!isGitWorkTree()) {
    // A scratch/fixture tree with no history. Say so; do not imply the check ran.
    enumerated.historyBase = 'skipped (not a git work tree — no previous version to compare against)'
    notes.push('task version monotonicity was NOT checked: this tree has no git history')
  } else {
    // In CI the base is passed explicitly (the PR base sha, or the push's before
    // sha). origin/main and HEAD^ are the local-development fallbacks.
    const candidates = [process.env.BASE_REV, 'origin/main', 'HEAD^'].filter(Boolean)
    let base = null
    for (const candidate of candidates) {
      base = resolveRev(candidate) && candidate
      if (base) break
    }
    if (!base) {
      // Fail closed. There are real tasks and no way to see their previous
      // versions; reporting a pass here would be the same vacuity one level up.
      errors.push(
        `task version history: none of ${candidates.map((c) => JSON.stringify(c)).join(', ')} resolves to a commit, ` +
          `so ${tasks.length} task version(s) could not be compared with their previous values. Set BASE_REV, or ` +
          'fetch enough history (actions/checkout fetch-depth: 0) — an unverifiable version is not a verified one',
      )
      enumerated.historyBase = 'UNRESOLVED'
    } else {
      const resolved = resolveRev(base)
      enumerated.historyBase = base === resolved ? base : `${base} (${resolved})`
      for (const { dir, rel, task } of tasks) {
        let previous
        try {
          previous = JSON.parse(git(['show', `${base}:${rel}`]))
        } catch {
          notes.push(`${rel}: new since ${base} — no previous version to compare`)
          continue
        }
        enumerated.taskVersionsCompared += 1
        const now = triple(task.version)
        const then = triple(previous.version)
        const order = compareTriples(now, then)
        if (order < 0) {
          errors.push(
            `${rel}: version ${now.join('.')} is BELOW ${then.join('.')} at ${base} — Azure DevOps agents cache a ` +
              'task implementation by version, so republishing an already-cached number ships new code under an old identity',
          )
          continue
        }
        if (order === 0) {
          let changed = false
          try {
            git(['diff', '--quiet', base, '--', dir])
          } catch {
            changed = true
          }
          if (changed) {
            // A NOTE, not an error. The property is real -- agents cache by
            // Major.Minor, so shipping changed code under a cached version does
            // not reach them -- but nothing ships from a pull request, and
            // requiring the bump HERE is unsatisfiable for the bots that raise
            // most task-directory changes: Dependabot cannot edit task.json, so
            // every weekly dependency PR was permanently red. It is enforced
            // where it bites instead, by scripts/check-minor-bumps.js against
            // the previous release tag, which is also stricter: it demands the
            // MINOR move, not merely some component of the triple.
            notes.push(
              `${rel}: ${dir} changed since ${base} but version ${now.join('.')} did not move — ` +
                'check-minor-bumps.js requires the Minor bump on the release PR',
            )
          }
        }
      }
    }
  }
}

// ── 4. The extension version, and its agreement with release-please ──────────

const manifestName = 'azure-devops-extension.json'
let extension = null
try {
  extension = JSON.parse(fs.readFileSync(path.join(root, manifestName), 'utf8'))
} catch (err) {
  errors.push(`${manifestName}: not readable as JSON — ${err.message}`)
}

if (extension) {
  if (!/^\d+\.\d+\.\d+$/.test(extension.version || '')) {
    errors.push(`${manifestName}: version must be semver, got ${JSON.stringify(extension.version)}`)
  }
  if (extension.public !== false) {
    errors.push(`${manifestName}: base manifest must keep "public": false; configs/release.json opts in`)
  }
}

// The manifest version is only SHAPE-checked above, and shape is not agreement.
// release-please owns the version: .release-please-manifest.json drives the tag
// and the changelog, and .release-please-config.json's extra-files entry
// propagates it into azure-devops-extension.json's $.version, which is what
// becomes the Marketplace version. A hand-edit of either file, or a
// release-please run that only half-lands, leaves the published package
// versioned differently from the tag and the changelog with nothing to say so.
let releasePleaseVersion = null
try {
  releasePleaseVersion = JSON.parse(fs.readFileSync(path.join(root, '.release-please-manifest.json'), 'utf8'))['.']
} catch (err) {
  errors.push(`.release-please-manifest.json: not readable as JSON — ${err.message}`)
}
if (releasePleaseVersion !== null && releasePleaseVersion !== undefined) {
  if (extension && releasePleaseVersion !== extension.version) {
    errors.push(
      `version disagreement: azure-devops-extension.json says ${JSON.stringify(extension.version)} but ` +
        `.release-please-manifest.json['.'] says ${JSON.stringify(releasePleaseVersion)} — ` +
        'the published Marketplace version and the tag/changelog would diverge',
    )
  }
} else {
  errors.push(".release-please-manifest.json: missing the '.' package entry that drives this repo's version")
}

// ── 5. The publish identity, across every file that carries it ───────────────
//
// The invariant the READMEs state — "a dev package can never accidentally ship a
// public listing" — is a TWO-file property: the base manifest must be
// public:false AND the override tfx is given must not opt in. Only the first
// half is a gate anywhere else. `npm run package:dev` passes --overrides-file
// ./configs/dev.json and tfx overrides WIN, so a dev.json carrying
// "public": true and galleryFlags ["Public"] produces a publicly-listed package
// while a shape-only version check prints success. The same blind spot covers id
// and publisher: the coordinates deciding WHICH Marketplace listing an artifact
// updates could be changed in any override with no gate noticing.

// The rules are a TABLE, and an override this table does not name fails closed.
// The table is the union of what the three repositories carry, because a new
// file in configs/ is exactly how one arrives carrying "public": true, and
// "some npm script passes it to tfx" is not a property a gate can infer. Only
// release.json and dev.json are required; the rest are optional so a repository
// that does not use one is not forced to invent it.
//
//   release.json  — the ONE override permitted to opt into the public listing,
//                   publishing to the base manifest's own id
//   dev.json      — the local package; must never produce a public listing
//   test.json     — the test package, same rule as dev
//   self.json     — a personal publisher/id by design (git-ignored, may be
//                   absent); exempt from the coordinate rule, NOT from public
//
// The ids are anchored to azure-devops-extension.json's own id rather than to
// .release-please-config.json's package-name: the two coincide in one of the
// three repositories and differ by design in the others, so the manifest's id
// is the only anchor that is cross-file agreement everywhere.
//
// Residual, stated rather than hidden: a change made consistently in BOTH the
// manifest and every override still passes. That is a reviewed,
// CODEOWNERS-covered, multi-file change, which is a different act from a
// one-line edit to an override nobody reads.

const OVERRIDES = {
  'release.json': {
    required: true,
    mayBePublic: true,
    idSuffix: '',
    why: 'the only override permitted to opt into the public Marketplace listing',
  },
  'dev.json': {
    required: true,
    mayBePublic: false,
    idSuffix: '-dev',
    why: 'the local/dev package; it must never produce a public listing',
  },
  'test.json': {
    required: false,
    mayBePublic: false,
    idSuffix: '-test',
    why: 'the test package; it must never produce a public listing',
  },
  'self.json': {
    required: false,
    mayBePublic: false,
    idSuffix: null,
    why: 'the personal publisher override (git-ignored). Its coordinates are deliberately its own, but it may not opt into a public listing',
  },
}

const configsDir = path.join(root, 'configs')
if (!fs.existsSync(configsDir)) {
  errors.push('configs/: missing — the packaging overrides carry the publish identity and the public-listing switch')
} else {
  const expectedId = extension && typeof extension.id === 'string' && extension.id.length > 0 ? extension.id : null
  if (!expectedId) {
    errors.push(`${manifestName}: id must be a non-empty string — it is half the Marketplace coordinate`)
  }
  const expectedPublisher =
    extension && typeof extension.publisher === 'string' && extension.publisher.length > 0 ? extension.publisher : null
  if (!expectedPublisher) {
    errors.push(`${manifestName}: publisher must be a non-empty string — it is half the Marketplace coordinate`)
  }

  for (const entry of fs.readdirSync(configsDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      errors.push(`configs/${entry.name}: not a regular file — configs/ holds tfx override manifests only`)
      continue
    }
    if (!Object.prototype.hasOwnProperty.call(OVERRIDES, entry.name)) {
      // Fail closed. A new override that no rule covers is exactly how one
      // arrives carrying "public": true.
      errors.push(
        `configs/${entry.name}: unrecognised packaging override — every file in configs/ is passed to tfx by some ` +
          `npm script and wins over the base manifest. Add it to OVERRIDES in scripts/${path.basename(__filename)} ` +
          `with the rule it must satisfy (known: ${Object.keys(OVERRIDES).join(', ')})`,
      )
    }
  }

  for (const [name, rule] of Object.entries(OVERRIDES)) {
    const file = path.join(configsDir, name)
    if (!fs.existsSync(file)) {
      if (rule.required) errors.push(`configs/${name}: missing — ${rule.why}`)
      else notes.push(`configs/${name}: absent (${rule.why})`)
      continue
    }
    enumerated.overrides += 1

    let override
    try {
      override = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (err) {
      errors.push(`configs/${name}: not valid JSON — ${err.message}`)
      continue
    }

    if (typeof override.public !== 'boolean') {
      errors.push(
        `configs/${name}: "public" must be stated explicitly as true or false, got ${JSON.stringify(override.public)} — ` +
          'an override that omits it inherits nothing visible and the listing visibility becomes unreviewable',
      )
    } else if (override.public === true && !rule.mayBePublic) {
      errors.push(
        `configs/${name}: "public": true — ${rule.why}. tfx overrides win over the base manifest, so this packages a ` +
          'publicly-listed extension no matter what azure-devops-extension.json says',
      )
    } else if (override.public === false && rule.mayBePublic && name === 'release.json') {
      errors.push(
        'configs/release.json: "public": false — this is the override that opts INTO the public listing; a release ' +
          'packaged from it would be published unlisted',
      )
    }

    const flags = Array.isArray(override.galleryFlags) ? override.galleryFlags : []
    if (!Array.isArray(override.galleryFlags) && override.galleryFlags !== undefined) {
      errors.push(`configs/${name}: galleryFlags must be an array, got ${JSON.stringify(override.galleryFlags)}`)
    }
    if (flags.includes('Public') && !rule.mayBePublic) {
      errors.push(
        `configs/${name}: galleryFlags includes "Public" — ${rule.why}. The gallery flag lists the extension ` +
          'publicly regardless of the "public" field',
      )
    }

    if (typeof override.id !== 'string' || override.id.length === 0) {
      errors.push(`configs/${name}: id must be a non-empty string — it decides which Marketplace listing is updated`)
    } else if (rule.idSuffix !== null && expectedId && override.id !== `${expectedId}${rule.idSuffix}`) {
      errors.push(
        `configs/${name}: id ${JSON.stringify(override.id)} must be ${JSON.stringify(`${expectedId}${rule.idSuffix}`)} — ` +
          'anything else publishes to, or creates, a different listing than the one this repository releases',
      )
    }

    if (typeof override.publisher !== 'string' || override.publisher.length === 0) {
      errors.push(`configs/${name}: publisher must be a non-empty string`)
    } else if (rule.idSuffix !== null && expectedPublisher && override.publisher !== expectedPublisher) {
      errors.push(
        `configs/${name}: publisher ${JSON.stringify(override.publisher)} does not match the base manifest's ` +
          `${JSON.stringify(expectedPublisher)} — the package would be pushed under a different identity`,
      )
    }
  }
}

// ── 6. Localized messages must actually resolve ──────────────────────────────
//
// azure-pipelines-task-lib loads resources by iterating task.json's `messages`
// map (`for (var key in resourceJson.messages)` in its internal.js) and consults
// Strings/resources.resjson only as a per-culture OVERRIDE for keys already
// listed there. A key that exists ONLY in the resjson is therefore never loaded:
// tasks.loc() warns "Can't find loc string for key: ..." and returns the raw
// `KeyName arg1 arg2` text. A guard whose rejection renders as its own key name
// still fails closed, but its diagnostics are gone -- and nothing was watching.
//
// This makes that unrepresentable: every key a source file actually passes to
// tasks.loc() (directly, or through a repo-local helper that forwards a key
// parameter to tasks.loc -- e.g. a throwCommandFailure wrapper), and every key
// the resjson declares, must appear in task.json's `messages`. The reverse (a
// task.json key with no resjson entry) is benign: task.json carries the en-US
// text itself, and the resjson only adds per-culture overrides.

function collectTsFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectTsFiles(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

const LOC_CALL_PATTERN = /\bloc\(\s*["'`]([A-Za-z0-9_]+)["'`]/g

// Finds repo-local helpers that forward a KEY PARAMETER to tasks.loc(), so a
// call like throwCommandFailure("TerraformFmtFailed", code) is recognised as a
// loc-key use. Returns a Map of helperName -> argument index of the key.
function findLocKeyHelpers(sources) {
  const helpers = new Map()
  for (const source of sources) {
    const re = /(?:function|private|protected|public)\s+(\w+)\s*\(([^)]*)\)[^{]*\{/g
    let m
    while ((m = re.exec(source)) !== null) {
      const [name, paramText] = [m[1], m[2]]
      const params = paramText
        .split(',')
        .map((p) => p.trim().split(':')[0].trim())
        .filter(Boolean)
      const body = source.slice(m.index, m.index + 1200)
      for (let i = 0; i < params.length; i += 1) {
        if (new RegExp(`\\bloc\\(\\s*${params[i]}\\b`).test(body)) helpers.set(name, i)
      }
    }
  }
  return helpers
}

for (const { dir, rel, task } of tasks) {
  const taskDir = path.join(root, dir)
  const declared = new Set(Object.keys(task.messages || {}))

  const tsFiles = collectTsFiles(path.join(taskDir, 'src'))
  const sources = tsFiles.map((f) => fs.readFileSync(f, 'utf8'))
  const helpers = findLocKeyHelpers(sources)

  const used = new Map() // key -> first file that uses it
  tsFiles.forEach((tsFile, i) => {
    const source = sources[i]
    const where = path.relative(taskDir, tsFile)
    for (const match of source.matchAll(LOC_CALL_PATTERN)) {
      if (!used.has(match[1])) used.set(match[1], where)
    }
    for (const [helper, argIndex] of helpers) {
      const re = new RegExp(`\\b${helper}\\(((?:[^();]|\\([^()]*\\)){0,200})\\)`, 'g')
      let m
      while ((m = re.exec(source)) !== null) {
        const arg = (m[1].split(',')[argIndex] || '').trim()
        const literal = arg.match(/^["'`]([A-Za-z0-9_]+)["'`]$/)
        if (literal && !used.has(literal[1])) used.set(literal[1], where)
      }
    }
  })
  enumerated.locKeys += used.size

  for (const [key, where] of used) {
    if (!declared.has(key)) {
      errors.push(
        `${rel}: messages is missing ${JSON.stringify(key)}, used as a loc key in ${where} — task-lib only loads ` +
          'keys listed in task.json\'s messages map, so this would render to users as raw key text',
      )
    }
  }

  const resjsonRel = 'Strings/resources.resjson/en-US/resources.resjson'
  const resjsonPath = path.join(taskDir, resjsonRel)
  if (fs.existsSync(resjsonPath)) {
    let resjson
    try {
      resjson = JSON.parse(fs.readFileSync(resjsonPath, 'utf8'))
    } catch (err) {
      errors.push(`${dir}/${resjsonRel}: not valid JSON — ${err.message}`)
      resjson = null
    }
    for (const key of Object.keys(resjson || {})) {
      if (!key.startsWith('loc.messages.')) continue
      const messageKey = key.slice('loc.messages.'.length)
      if (!declared.has(messageKey)) {
        errors.push(
          `${rel}: messages is missing ${JSON.stringify(messageKey)}, declared in ${resjsonRel} — a resjson-only key ` +
            "is never loaded by task-lib; add it to task.json's messages map too",
        )
      } else if (resjson[key] !== task.messages[messageKey]) {
        // Text drift between the two en-US copies is a cosmetic inconsistency,
        // not the defect above (the key still LOADS, from task.json). Reported
        // so it is visible, but it does not fail the gate -- changing shipped
        // log text is a separate decision.
        notes.push(`${rel}: message ${JSON.stringify(messageKey)} text differs from the en-US resjson entry`)
      }
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

for (const note of notes) console.log(`  note: ${note}`)

if (errors.length > 0) {
  console.error('Version check failed:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

// The banner is the point of the universe declaration: a run that enumerated
// nothing says so in words, above the success line, and never says "passed" on
// its own.
if (universe.banner) console.log(universe.banner)

console.log(
  `Version check passed — examined ${enumerated.tasks} task manifest(s) ` +
    `(${enumerated.taskVersionsCompared} compared against ${enumerated.historyBase}), ` +
    `${enumerated.locKeys} loc key(s) at call sites, ${enumerated.overrides} packaging override(s) in configs/, ` +
    'and the extension version against .release-please-manifest.json.',
)
