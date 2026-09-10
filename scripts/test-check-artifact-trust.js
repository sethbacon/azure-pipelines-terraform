#!/usr/bin/env node
'use strict'

// Self-test for check-artifact-trust.js's DELEGATED-VERIFY detector and the
// version-floor currency check that holds its floor honest, on fixtures it
// builds itself.
//
// The two are tested together because they are one mechanism seen from both
// sides. The detector's whole claim is that a declared floor decides WHICH
// implementation of verifyDetached actually runs; the currency check is what
// stops that floor from quietly sinking below every task in the repository,
// where it would still be a floor, still be printed, and never fire again. That
// is the failure this gate's sibling check-proxy-parity.js was caught by
// (azure-pipelines-terraform#1108 finding 2) and where the check is ported from.
//
// The other eight kinds are not re-tested here. They are driven against real
// task source by each extension's ArtifactTrustL0 suite, which asserts the whole
// enumerated set. What that suite cannot see is a floor going stale, because a
// stale floor changes no row -- it is invisible in exactly the place the L0
// tables look.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const GATE = path.join(__dirname, 'check-artifact-trust.js')
const CORE = '@4cloudguru/pipeline-task-core'

// The floor DELEGATED_VERIFIERS.verifyDetached is written at. Restated here
// rather than read out of the gate on purpose: a fixture that derived the bar
// from the thing under test would move with it, and every case below would keep
// passing through a floor edited to any value at all.
// The floor under test is read from the gate, never restated here: a literal
// copy of it is how this file went red the day the floor was raised, and a
// literal that agreed by luck would be green about a bar it never measured.
const FLOOR = (/DELEGATED_VERIFIERS[\s\S]*?min:\s*'(\d+\.\d+\.\d+)'/.exec(fs.readFileSync(GATE, 'utf8')) || [])[1]
if (!FLOOR) throw new Error('could not read DELEGATED_VERIFIERS.verifyDetached.min out of the gate')
// One minor above the floor: the fleet that has moved past it.
const ABOVE = FLOOR.replace(/^(\d+)\.(\d+)\.\d+$/, (_, a, b) => `${a}.${Number(b) + 1}.0`)

let failures = 0
// Every assertion below reads the report through `?.`, never through a bare
// index. A mutation that empties the array it is looking at must be REPORTED,
// not thrown: a TypeError here aborts the run and silently skips every case
// after it, which is the same "looked nowhere" failure the gate itself exists
// to refuse. Watched: neutering staleFloors() crashed this file at the first
// currency case before the reads were guarded.
function check (ok, message, detail) {
  if (ok) { console.log(`  ok   ${message}`); return }
  failures += 1
  console.error(`  FAIL ${message}${detail === undefined ? '' : `: ${detail}`}`)
}

function run (root) {
  try {
    return { code: 0, body: JSON.parse(execFileSync(process.execPath, [GATE, root, '--json'], { encoding: 'utf8' })) }
  } catch (err) {
    // A crash prints no JSON. Returning `{}` here would let every assertion
    // below read `undefined` and pass, which is the shape this file exists to
    // refuse -- so a body that will not parse is surfaced as `body: null`, and
    // every case asserts on a real array rather than on `(x || []).length`.
    let body = null
    try { body = JSON.parse(err.stdout) } catch { /* left null on purpose */ }
    return { code: err.status, body }
  }
}

/**
 * A tree of tasks under Tasks/<name>/<name>V1. Each gets a package.json (with
 * `range` declared for core, unless `range` is null) and one file under src/,
 * which by default imports verifyDetached from the package.
 *
 * realpath, because declaredDependency() walks upward until it leaves ROOT and
 * ROOT is path.resolve()d from argv: on a platform where the temp directory is
 * a symlink, an unresolved fixture path leaves the walk outside its own root and
 * every task reads as declaring nothing.
 */
function fixture (tasks, assert) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-trust-selftest-')))
  try {
    for (const [name, spec] of Object.entries(tasks)) {
      const dir = path.join(root, 'Tasks', name, `${name}V1`)
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
      const dependencies = spec.range === null ? {} : { [CORE]: spec.range }
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: name.toLowerCase(), dependencies }))
      fs.writeFileSync(
        path.join(dir, 'src', spec.file ?? 'gpg-verifier.ts'),
        spec.source ?? `import { verifyDetached } from '${CORE}/gpg';\n\nexport async function verify(p: string): Promise<void> {\n    await verifyDetached(p, p + '.sig');\n}\n`
      )
    }
    return assert(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

const delegatedRows = (body) => (body && Array.isArray(body.sites) ? body.sites.filter((s) => s.kind === 'DELEGATED-VERIFY') : null)
const staleRows = (body) => (body && Array.isArray(body.staleFloors) ? body.staleFloors : null)
const verdictsByTask = (rows) => Object.fromEntries((rows ?? []).map((r) => [r.rel.split('/')[1], r.verdict]))

console.log('check-artifact-trust self-test — DELEGATED-VERIFY and floor currency\n')

// --------------------------------------------------- the detector
console.log('DELEGATED-VERIFY: which implementation of the verifier resolves')

fixture({ Installer: { range: `^${FLOOR}` } }, (root) => {
  const { code, body } = run(root)
  const rows = delegatedRows(body)
  check(rows !== null && rows.length === 1, 'a task importing verifyDetached from core is one DELEGATED-VERIFY row', JSON.stringify(rows))
  check(rows?.[0]?.verdict === 'PINNED-DELEGATE', 'a task AT the floor is PINNED-DELEGATE', rows?.[0]?.verdict)
  check(rows?.[0]?.fn === 'verifyDetached', 'named by the delegated binding, not by the enclosing function', rows?.[0]?.fn)
  check(body && body.failures === 0, 'a pinned delegate is not a failure', body && body.failures)
  check(code === 0, 'and with the fleet level with the floor the gate exits 0', code)
})

fixture({ Installer: { range: '^0.6.0' } }, (root) => {
  const { code, body } = run(root)
  const rows = delegatedRows(body)
  check(rows?.[0]?.verdict === 'DELEGATED-VERIFIER-UNPINNED', 'a task BELOW the floor is DELEGATED-VERIFIER-UNPINNED', rows?.[0]?.verdict)
  check(body && body.failures === 1, 'and is counted as a defective row', body && body.failures)
  check(code === 1, 'and the gate exits 1', code)
})

fixture({ Installer: { range: '^0.6.0' }, Other: { range: `^${FLOOR}` } }, (root) => {
  const { body } = run(root)
  const verdicts = verdictsByTask(delegatedRows(body))
  check(verdicts.Installer === 'DELEGATED-VERIFIER-UNPINNED' && verdicts.Other === 'PINNED-DELEGATE',
    'the verdict is per TASK -- one task regressing does not condemn its sibling', JSON.stringify(verdicts))
  check(body && body.failures === 1, 'and only the regressing task is counted', body && body.failures)
})

fixture({ Installer: { range: null } }, (root) => {
  const { code, body } = run(root)
  const rows = delegatedRows(body)
  check(rows?.[0]?.verdict === 'DELEGATED-VERIFIER-UNPINNED',
    'a task that imports the verifier while declaring NO dependency on it is unpinned', rows?.[0]?.verdict)
  check(/no dependency on it/.test(rows?.[0]?.why ?? ''), 'and says so rather than naming a version', rows?.[0]?.why)
  check(code === 1, 'and the gate exits 1', code)
})

fixture({
  Installer: {
    range: '^0.6.0',
    // verifyDetached named in a comment and called, but never IMPORTED from the
    // package. There is no delegation to verdict, so there must be no row -- a
    // gate that manufactured one here would report a site no version bump could
    // ever clear.
    source: `// verifyDetached is discussed here\nimport { other } from '${CORE}/gpg';\nexport const x = () => other();\n`,
  },
}, (root) => {
  const { body } = run(root)
  check((delegatedRows(body) ?? null)?.length === 0, 'a name in a comment, with no import of it, is not a site', JSON.stringify(delegatedRows(body)))
})

fixture({
  Installer: {
    range: '^0.6.0',
    // The same binding, from somewhere else. The floor belongs to a package, so
    // an identically named export of another package is a different decision
    // and this table says nothing about it.
    source: "import { verifyDetached } from 'some-other-gpg-lib';\nexport const x = (p: string) => verifyDetached(p, p);\n",
  },
}, (root) => {
  const { body } = run(root)
  check((delegatedRows(body) ?? null)?.length === 0, 'the same binding imported from another package is not a site', JSON.stringify(delegatedRows(body)))
})

fixture({
  Installer: { range: '^0.6.0', source: `import { verifyDetached, other } from '${CORE}';\nexport const x = (p: string) => verifyDetached(p, other);\n` },
}, (root) => {
  const { body } = run(root)
  check((delegatedRows(body) ?? []).length === 1, 'the package ROOT specifier and a multi-name import are both matched', JSON.stringify(delegatedRows(body)))
})

// --------------------------------------------------- floor currency
console.log('\nfloor currency: a bar below the whole fleet cannot fire')

fixture({ Installer: { range: `^${ABOVE}` }, Other: { range: `^${ABOVE}` } }, (root) => {
  const { code, body } = run(root)
  const stale = staleRows(body)
  check(stale !== null && stale.length === 1, 'a fleet that has moved past the floor reports it stale', JSON.stringify(stale))
  check(stale?.[0]?.where === 'DELEGATED_VERIFIERS.verifyDetached', 'and names where the floor is written', stale?.[0]?.where)
  check(stale?.[0]?.min === FLOOR && stale?.[0]?.fleet === ABOVE, 'and names both the stale value and the value to raise it to', JSON.stringify(stale?.[0]))
  check(body && body.failures === 0, 'with NO defective row -- a stale floor condemns no call site', body && body.failures)
  check((delegatedRows(body) ?? []).every((r) => r.verdict === 'PINNED-DELEGATE'), 'and every site still passes the bar it has outgrown')
  check(code === 1, 'and the gate exits 1 on a stale floor alone', code)
})

fixture({ Installer: { range: `^${ABOVE}` }, Other: { range: `^${FLOOR}` } }, (root) => {
  const { code, body } = run(root)
  check((staleRows(body) ?? null)?.length === 0,
    'ONE task still at the floor keeps the bar live -- the fleet floor is the LOWEST declaration, not the highest',
    JSON.stringify(staleRows(body)))
  check(code === 0, 'and the gate exits 0', code)
})

fixture({ Installer: { range: '^0.6.0' }, Other: { range: '^0.6.0' } }, (root) => {
  const { body } = run(root)
  check((staleRows(body) ?? null)?.length === 0, 'a fleet BELOW the floor is not a stale floor -- that is what the row verdict is for', JSON.stringify(staleRows(body)))
  check(body && body.failures === 2, 'and both tasks are reported as rows instead', body && body.failures)
})

// A repository whose tasks do not depend on the package at all: the floor has no
// fleet to be measured against, and "no fleet" must not read as "a fleet at
// 0.0.0", which would report every floor as stale in every repository that
// happens not to use the package.
fixture({
  Installer: { range: null, file: 'render.ts', source: 'export const render = (s: string) => s.toUpperCase();\n' },
}, (root) => {
  const { code, body } = run(root)
  check((staleRows(body) ?? null)?.length === 0, 'a repository declaring the package nowhere reports no stale floor', JSON.stringify(staleRows(body)))
  check((delegatedRows(body) ?? []).length === 0, 'and enumerates no delegated verifier')
  check(code === 0, 'and exits 0', code)
})

console.log('')
if (failures > 0) {
  console.error(`FAIL: ${failures} check-artifact-trust self-test case(s) failed.`)
  process.exit(1)
}
console.log('OK: check-artifact-trust.js self-test passed (the delegated verifier is verdicted per task, an unimported or foreign binding is not a site, and staleFloors() still holds the floor level with the fleet).')
