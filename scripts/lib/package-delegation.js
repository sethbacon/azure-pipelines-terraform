// Shared floor + resolved-copy check for capabilities this repo delegated into
// @4cloudguru/pipeline-task-* (#399).
//
// Two gates need the SAME question answered about different sinks:
// check-proxy-parity.js for the network delegations, check-artifact-trust.js for
// the cryptographic one. Duplicating it would have been the third copy of a
// version check whose whole purpose is catching copies that drift apart.
//
// The check is two-part on purpose, and the second part is the one that bites:
// a declared floor only vouches for the WIRING, not for which implementation it
// wires up. ado@0.2.0 once declared core ^0.3.1 while the tasks declared ^0.5.0
// -- caret on a 0.x version is patch-only, so the ranges were disjoint, npm
// nested a second copy, and the delegated code ran the older one while BOTH
// floors passed. Hence installedCopies() and the length !== 1 rejection.
//
// THIS COPY IS CANONICAL AND RESOLVES EVERYTHING FROM ROOT, NEVER __dirname.
// It was taken from azure-pipelines-packer's scripts/lib/package-delegation.js
// -- the only difference in the logic is the `provides` sentence below, and
// `highestFloor`, which is new. That discipline is the reason the file can live
// here at all: a gate resolved from one canonical copy analyses a tree it does
// not live in, so every walk boundary has to be the ANALYSED root. See the
// identical note on each walk for what __dirname cost the last time -- 19
// fabricated sites across three repositories, from a boundary that followed the
// script instead of the tree.

// `ROOT` is threaded explicitly rather than read from a caller's module scope:
// these helpers walk UPWARD from a source file looking for the owning
// package.json, and they need to know where to stop.
const fs = require('fs');
const path = require('path');

function declaredDependency(file, pkg, ROOT) {
    let dir = path.dirname(path.resolve(file));
    // The walk stops at the tree being ANALYSED, which is ROOT (argv), not at
    // this file's own parent. Those are the same path while the gate lives in
    // scripts/ of the repo it analyses, so this changes nothing today -- and it
    // is what lets the gate be resolved from one canonical copy elsewhere. With
    // __dirname the boundary followed the SCRIPT, so a moved gate stopped
    // resolving declared dependencies and reported correctly-proxied call sites
    // as findings (measured: 4 in packer, 14 in terraform, 1 in release-docs).
    const stop = ROOT;
    while (dir.startsWith(stop)) {
        const manifest = path.join(dir, 'package.json');
        if (fs.existsSync(manifest)) {
            try {
                const json = JSON.parse(fs.readFileSync(manifest, 'utf8'));
                const range = (json.dependencies || {})[pkg];
                if (range) return range;
            } catch {
                return null;
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

function satisfiesFloor(range, min) {
    const parsed = /^\^?(\d+)\.(\d+)\.(\d+)/.exec(String(range).trim());
    if (!parsed) return false;
    const floor = min.split('.').map(Number);
    const actual = parsed.slice(1).map(Number);
    for (let i = 0; i < 3; i += 1) {
        if (actual[i] > floor[i]) return true;
        if (actual[i] < floor[i]) return false;
    }
    return true;
}

function lockfileFor(file, ROOT) {
    let dir = path.dirname(path.resolve(file));
    // The walk stops at the tree being ANALYSED, which is ROOT (argv), not at
    // this file's own parent. Those are the same path while the gate lives in
    // scripts/ of the repo it analyses, so this changes nothing today -- and it
    // is what lets the gate be resolved from one canonical copy elsewhere. With
    // __dirname the boundary followed the SCRIPT, so a moved gate stopped
    // resolving declared dependencies and reported correctly-proxied call sites
    // as findings (measured: 4 in packer, 14 in terraform, 1 in release-docs).
    const stop = ROOT;
    while (dir.startsWith(stop)) {
        const lock = path.join(dir, 'package-lock.json');
        if (fs.existsSync(lock)) return lock;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

function installedCopies(file, dep, ROOT) {
    const lock = lockfileFor(file, ROOT);
    if (!lock) return null;
    let json;
    try {
        json = JSON.parse(fs.readFileSync(lock, 'utf8'));
    } catch {
        return null;
    }
    const suffix = `node_modules/${dep}`;
    return Object.entries(json.packages || {})
        .filter(([key]) => key === suffix || key.endsWith(`/${suffix}`))
        .map(([key, value]) => ({ path: key, version: value && value.version }));
}

// `capability` and `provides` are what the operator reading a failure has to go
// on: the first names what was delegated, the second names what the resolved
// package supplies. An entry that sets NEITHER falls back to the two placeholder
// strings below and the message stops saying anything -- "delegates this
// capability to @4cloudguru/pipeline-task-core" is true of every entry in every
// table. Every production entry should name both; the defaults exist so a new
// sink is never a crash, not so it can stay anonymous, and there is a self-test
// case pinning exactly what the anonymous message reads like.
//
// The `provides` sentence is phrased `<pkg>@<range> (floor <min>) provides
// <provides>` rather than `<provides> comes from <pkg>...` because `provides` is
// a noun phrase that may be plural: "proxy dispatch and secret registration
// comes from" is a subject/verb slip that the reworded template cannot produce
// for any entry.
function packageDelegationVerdict(file, { pkg, min, carries, capability = 'this capability', provides = 'the delegated implementation' }, ROOT) {
    const declared = declaredDependency(file, pkg, ROOT);
    if (declared === null || !satisfiesFloor(declared, min)) {
        return { ok: false, why: `delegates ${capability} to ${pkg}, but the owning task declares ${declared ?? 'no dependency on it'} (floor ${min})` };
    }
    if (!carries) {
        return { ok: true, why: `${pkg}@${declared} (floor ${min}) provides ${provides}` };
    }

    const copies = installedCopies(file, carries.pkg, ROOT);
    if (copies === null) {
        return { ok: false, why: `${pkg}@${declared} delegates onward to ${carries.pkg}, but no lockfile was readable to show which copy is installed` };
    }
    if (copies.length !== 1) {
        const seen = copies.map((c) => `${c.version} at ${c.path}`).join(', ') || 'none';
        return { ok: false, why: `${pkg}@${declared} delegates onward to ${carries.pkg}, which resolves to ${copies.length} copies (${seen}) — the delegated call runs whichever one is nested, not the one this task imports` };
    }
    if (!satisfiesFloor(copies[0].version, carries.min)) {
        return { ok: false, why: `${pkg}@${declared} delegates onward to ${carries.pkg}@${copies[0].version}, below the ${carries.min} floor` };
    }
    return { ok: true, why: `${pkg}@${declared} (floor ${min}) provides ${provides}, resolving a single ${carries.pkg}@${copies[0].version} (floor ${carries.min})` };
}

/**
 * The highest of the floors handed to it, ignoring nulls -- the whole of the
 * three-source floor rule (a sink's `since`, the estate ratchet, a repository's
 * own declared floor) as ONE pure function, so each source can be shown to
 * matter on its own.
 *
 * Because the rule is a MAX, a floor added by any source can only ever RAISE
 * the bar; no source can weaken a verdict another source already reached. That
 * is the whole safety argument for letting a floor come from somewhere other
 * than this file, and it is a property worth being able to break in a test
 * rather than one worth asserting in a comment.
 *
 * It is exported and unit-tested rather than inlined because two of the three
 * sources are, today, never the winner in any production table entry: a rule
 * only exercised through the tables would have a term nothing can falsify, and
 * a guard nobody can break is a guard nobody has verified.
 */
function highestFloor(...versions) {
    const parse = (v) => String(v).split('.').map(Number);
    return versions.filter(Boolean).reduce((hi, v) => {
        const [a, b] = [parse(v), parse(hi)];
        for (let i = 0; i < 3; i += 1) { if (a[i] > b[i]) return v; if (a[i] < b[i]) return hi; }
        return hi;
    });
}

module.exports = { highestFloor, packageDelegationVerdict, declaredDependency, satisfiesFloor, installedCopies };
