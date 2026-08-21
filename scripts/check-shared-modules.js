#!/usr/bin/env node
// Enforces a single effective source of truth for the security-critical modules
// that are intentionally duplicated, by two mechanisms that answer two different
// questions. Both are needed; neither can express the other.
//
//   FAMILIES    WITHIN this repository, a set of directories must carry
//               byte-identical copies of the named modules, so a fix -- a GPG
//               key rotation, a sanitizer allowlist change -- can never be
//               applied to one copy and silently missed in another. Divergence
//               fails CI, and `--fix` rewrites the copies from the canonical.
//
//   PROVENANCE  ACROSS repositories, a copy cannot be byte-compared: the
//               upstream is not checked out in CI, and the copy may have
//               deliberately advanced past it. What is checkable is that the
//               copy still SAYS where it came from and whether it is still in
//               sync, in a machine-readable header. That turns "should be
//               mirrored" from a comment nobody is accountable for into an
//               invariant a new copy cannot be added without.
//
// The lists live in scripts/lib/shared-modules.js because they are the part that
// legitimately differs between the three extensions; this file, the logic, is
// byte-identical in all of them.

const fs = require('fs')
const path = require('path')

const { FAMILIES, PROVENANCE } = require('./lib/shared-modules.js')

// Normalize line endings so a CRLF checkout never reads as drift; the bytes that
// matter (the key material, the verification logic) are still compared exactly.
function read(relDir, file) {
    const full = path.resolve(relDir, file)
    if (!fs.existsSync(full)) {
        return { ok: false, full }
    }
    return { ok: true, full, content: fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n') }
}

// --fix support. The parity gate tells you a canonical module and its copies
// diverged, but reconciling them was still a manual per-directory copy, which is
// exactly the "must be made twice and kept in sync by hand" cost the duplication
// was reported for. Fix the canonical once, run `npm run sync:shared`, and every
// other copy is rewritten from it.
//
// Deliberately NOT wired into the build. If syncing ran automatically before
// packaging, a genuine unintended divergence would be silently repaired instead
// of failing CI, which would defeat the whole point -- the gate has to stay
// fail-closed. Syncing is an explicit authoring step; CI only ever verifies.
function writeFamilyCopy(canonicalFull, targetFull) {
    fs.copyFileSync(canonicalFull, targetFull)
}

// The provenance header every cross-repository copy must carry, exactly once.
// `upstream` is per-entry rather than baked in: which repository a copy came from
// is data, and hardcoding one name is how a copy from anywhere else becomes
// unregisterable.
function markersFor(upstream) {
    return [
        { name: 'upstream', re: new RegExp(`@shared-module:\\s*copied from ${upstream}\\s*\\(.+\\)`, 'g') },
        { name: 'policy', re: /@shared-module-policy:\s*\S/g },
        { name: 'status', re: /@shared-module-status:\s*(IN-SYNC|DIVERGED)\b/g },
    ]
}

/**
 * A family that compares NOTHING must never report the same thing as a family
 * that compared four files and found no drift.
 *
 * Retiring a module into a shared package can collapse a family's `dirs` list to
 * one entry, at which point every comparison loop runs zero times while the
 * script still prints "All shared-module parity checks passed." A
 * single-directory family is not a weak check, it is an absent one wearing the
 * same output.
 *
 * So: at least two directories in each family, at least one module in each, and
 * -- one level up -- a repository that declares neither families nor provenance
 * entries is gating nothing at all and says so. A family that no longer has a
 * job should be DELETED (and its removal explained), never left declaring a set
 * it cannot compare.
 *
 * Exported so the self-test can drive it with synthetic inputs -- the failure it
 * describes cannot be staged by editing the repo tree, only by editing the list.
 */
function assertFamiliesAreComparable(families) {
    const problems = []
    if (!Array.isArray(families) || families.length === 0) {
        problems.push('FAMILIES is empty: nothing is gated, and every run would pass vacuously.')
        return problems
    }
    families.forEach((family, index) => {
        const label = `FAMILIES[${index}]${family?.dirs?.[0] ? ` (${family.dirs[0]})` : ''}`
        const dirs = Array.isArray(family?.dirs) ? family.dirs : []
        const modules = Array.isArray(family?.modules) ? family.modules : []
        if (dirs.length < 2) {
            problems.push(
                `${label} names ${dirs.length} director${dirs.length === 1 ? 'y' : 'ies'}: ` +
                'a family needs at least two to compare anything. Delete the family if it no longer has a job.',
            )
        }
        if (modules.length === 0) {
            problems.push(`${label} lists no modules, so it compares nothing.`)
        }
    })
    return problems
}

/** Every provenance entry must name a file and the repository it came from. */
function assertProvenanceIsCheckable(entries) {
    const problems = []
    if (!Array.isArray(entries)) {
        problems.push('PROVENANCE is not a list.')
        return problems
    }
    entries.forEach((entry, index) => {
        const label = `PROVENANCE[${index}]${entry?.file ? ` (${entry.file})` : ''}`
        if (!entry?.dir || !entry?.file) problems.push(`${label} must name both a dir and a file.`)
        if (!entry?.upstream) {
            problems.push(`${label} must name the upstream repository it was copied from, or its header cannot be checked.`)
        }
    })
    return problems
}

function main(argv = process.argv.slice(2)) {
    // `--fix` rewrites every non-canonical copy from its canonical source instead
    // of failing on divergence. A missing canonical is still a hard failure even
    // under --fix: there is nothing trustworthy to sync FROM, so repairing would
    // be a guess.
    const fix = argv.includes('--fix')
    let hasError = false
    let fixedCount = 0

    // Before comparing anything, check there IS something to compare.
    const families = Array.isArray(FAMILIES) ? FAMILIES : []
    const provenance = Array.isArray(PROVENANCE) ? PROVENANCE : []
    if (families.length === 0 && provenance.length === 0) {
        console.error(
            'FAIL: scripts/lib/shared-modules.js declares neither families nor provenance entries, ' +
            'so this gate would pass without examining anything.',
        )
        process.exit(1)
    }

    const structuralProblems = [
        ...(families.length > 0 ? assertFamiliesAreComparable(families) : []),
        ...assertProvenanceIsCheckable(provenance),
    ]
    if (structuralProblems.length > 0) {
        for (const problem of structuralProblems) {
            console.error(`FAIL: ${problem}`)
        }
        process.exit(1)
    }

    for (const { dirs, modules } of families) {
        const [canonicalDir, ...otherDirs] = dirs
        for (const file of modules) {
            const base = read(canonicalDir, file)
            if (!base.ok) {
                console.error(`FAIL: canonical copy missing: ${path.join(canonicalDir, file)}`)
                hasError = true
                continue
            }
            for (const dir of otherDirs) {
                const other = read(dir, file)
                if (!other.ok) {
                    console.error(`FAIL: copy missing: ${path.join(dir, file)}`)
                    hasError = true
                    continue
                }
                if (other.content !== base.content) {
                    if (fix) {
                        writeFamilyCopy(base.full, other.full)
                        console.log(`FIXED: ${file} rewritten from canonical (${canonicalDir} -> ${dir})`)
                        fixedCount++
                    } else {
                        console.error(`FAIL: ${file} diverged between ${canonicalDir} and ${dir}`)
                        console.error(`      reconcile both copies (canonical: ${base.full})`)
                        console.error(`      or run: npm run sync:shared`)
                        hasError = true
                    }
                } else {
                    console.log(`OK: ${file} identical (${canonicalDir} == ${dir})`)
                }
            }
        }
    }

    for (const { dir, file, upstream } of provenance) {
        const full = path.resolve(dir, file)
        if (!fs.existsSync(full)) {
            console.error(`FAIL: shared module missing: ${path.join(dir, file)}`)
            hasError = true
            continue
        }
        // Only the header comment block matters; scan the first 40 lines.
        const text = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n')
        // Only the header block declares provenance, so presence is scanned in the
        // first 40 lines -- but the COUNT is taken over the whole file. Two copies of
        // a marker are two answers to the same question, and nothing tells a reader,
        // or the next edit, which of them is the current one.
        const head = text.split('\n').slice(0, 40).join('\n')
        const problems = []
        for (const { name, re } of markersFor(upstream)) {
            const total = (text.match(re) || []).length
            if (!new RegExp(re.source).test(head)) problems.push(`${name} missing from the header`)
            else if (total > 1) problems.push(`${name} declared ${total} times`)
        }
        if (problems.length) {
            console.error(`FAIL: ${file} provenance header: ${problems.join('; ')}`)
            console.error(`      exactly one @shared-module / @shared-module-policy / @shared-module-status line each (see a sibling module).`)
            hasError = true
        } else {
            console.log(`OK: ${file} carries a valid shared-module provenance header`)
        }
    }

    if (hasError) {
        process.exit(1)
    }
    if (fix) {
        console.log(fixedCount === 0
            ? 'Nothing to sync: every copy already matches its canonical source.'
            : `Synced ${fixedCount} cop${fixedCount === 1 ? 'y' : 'ies'} from canonical. Review the diff before committing.`)
        return
    }
    const comparisons = families.reduce(
        (total, { dirs, modules }) => total + (dirs.length - 1) * modules.length,
        0,
    )
    // Says how much was compared, not merely that nothing failed: "found no
    // drift" and "compared nothing" must not print the same line.
    if (families.length > 0) {
        console.log(
            `All shared-module parity checks passed (${families.length} families, ${comparisons} file comparisons).`,
        )
    }
    if (provenance.length > 0) {
        console.log(
            `All shared-module provenance checks passed (${provenance.length} cross-repository cop${provenance.length === 1 ? 'y' : 'ies'}).`,
        )
    }
}

// FAMILIES is re-exported so scripts/check-near-duplicate-modules.js can share
// this single allowlist source instead of hand-maintaining a second copy of it.
// Still directly runnable as a script (`node scripts/check-shared-modules.js`),
// which is how CI and test-check-shared-modules.js's spawnSync invoke it.
if (require.main === module) {
    main()
}

module.exports = { FAMILIES, PROVENANCE, assertFamiliesAreComparable, assertProvenanceIsCheckable, main }
