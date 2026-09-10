#!/usr/bin/env node
// ARTIFACT-TRUST SIGNATURE (#65 / #78 / #136 / #198 / #204).
//
// Defect class
// ------------
//   An installed artifact is trusted without the verification the task
//   advertises, or the verification's failure/edge state leaves the install
//   path unrecoverable or silently degraded.
//
// The five reported instances are five *different* points on the same seam, so
// a signature that matched only "the mirror path" would restate one instance
// instead of enumerating the class. This script enumerates EVERY path by which
// a binary becomes trusted and verdicts each one:
//
//   ACQUIRE       a function that pulls an artifact off the network. Must reach
//                 a verifier (or be a pure wrapper whose caller verifies).
//   VERIFY        a function that checks a downloaded artifact's hash/signature.
//                 A failed check must DISCARD the artifact (#204) — a
//                 checksum-mismatched (i.e. possibly tampered) file must not be
//                 left on a persistent agent's disk.
//   SUMS-ABSENT   the branch that handles "the source published no checksum
//                 file". If the SAME function verifies a signature elsewhere,
//                 the source's trust root is signature-based and this branch
//                 must honour the require-signature toggle too, or the toggle is
//                 inert exactly where it matters most (#65). A function with no
//                 signature call has a sha256-only trust root (OPA,
//                 terraform-docs) — that difference is legitimate and is
//                 reported as an EXEMPT verdict, never flattened.
//   CACHE-ADMIT   a function that admits a tool from the agent's tool cache. It
//                 must re-verify on a hit, and must only record a cache
//                 integrity marker for an artifact that was actually verified
//                 (#136).
//   RECORD-READ   the read of that integrity marker. A zero-length/truncated
//                 marker is UNVERIFIABLE, not a mismatch: it must be validated
//                 as a 64-hex digest before use, or every later install of that
//                 version dies with a tampering-shaped error (#198).
//   RECORD-WRITE  the write of the marker. Must be atomic (temp + rename), or a
//                 killed job leaves exactly the truncated marker above (#198).
//   LATEST        'latest' version resolution. Falling back to a pinned constant
//                 on failure silently hands a security-currency-seeking caller a
//                 stale binary (#78).
//   DELEGATED-VERIFY
//                 an import of the verification decision ITSELF from
//                 @4cloudguru/pipeline-task-core. Every kind above asks whether
//                 an artifact reached a verifier; this one asks whether the
//                 verifier that runs is the one that was reviewed (#399).
//
// Discovery is by CODE SHAPE, not by call-site name: sites are found by walking
// **/src/**/*.ts, splitting each file into top-level functions, and following an
// in-file call graph. A newly added download strategy is enumerated automatically.
//
// Repo-agnostic — runs unchanged in azure-pipelines-terraform and
// azure-pipelines-packer:
//
//     node scripts/check-artifact-trust.js [repoRoot] [--json]
//
// Exit 0 = no residual instances of the class. Exit 1 = residuals, listed.

const fs = require('fs');
const path = require('path');

// Shared with check-proxy-parity.js (#399). The cryptographic verification
// decision is DELEGATED to @4cloudguru/pipeline-task-core, so the version that
// resolves is part of this signature's story: an unpinned verifier is an
// unverified artifact one npm resolution away.
//
// The lib travels WITH the gate, the way lib/task-dirs.js already travels with
// check-enforced-disciplines.js -- lib/ here is part of the gate, which is why
// gatelib refuses a shared copy that arrives without it. Every walk INSIDE it
// stops at the tree being ANALYSED, which is ROOT below, never __dirname: that
// is the property that lets this one canonical copy be handed a checkout it
// does not live in, and the file records what the alternative cost -- 19
// fabricated sites across three repositories, from a boundary that followed the
// script instead of the tree. ROOT is therefore passed in explicitly on every
// call rather than read from this module's scope.
const { packageDelegationVerdict } = require('./lib/package-delegation.js');

const JSON_OUTPUT = process.argv.includes('--json');
const ROOT = path.resolve(process.argv.filter((a) => a !== '--json')[2] || process.cwd());

// Network sinks that put bytes on disk. Anything here makes its enclosing
// function an ACQUIRE site.
const DOWNLOAD_PRIMITIVES = ['downloadTool', 'downloadToolWithTimeout', 'downloadToFile'];

// The checks that establish trust in a downloaded artifact.
const VERIFIERS = ['verifySha256', 'verifyGpgSignature', 'verifyCosignSignature'];

// Signature verification specifically (as opposed to a bare checksum): its
// presence in a function is what makes that function's trust root signature-based.
const SIGNATURE_VERIFIERS = ['verifyGpgSignature', 'verifyCosignSignature'];

// The helper that IS the #204 fix: it runs the verification and deletes the
// artifact if the verification throws.
const DISCARD_GUARD = 'discardArtifactOnFailure';

// The tool-cache lookup that makes a function a CACHE-ADMIT site.
const CACHE_LOOKUP = 'findLocalTool';

// A require-toggle whose subject is a SIGNATURE (not a bare checksum).
const SIGNATURE_TOGGLE = /require(?:Gpg|Cosign)/;

// The verification-status token a cache-admit site must gate its marker write on.
const VERIFIED_STATUS = /\bverified\b/;

function walk(dir, out = []) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'build') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && full.includes(`${path.sep}src${path.sep}`)) out.push(full);
    }
    return out;
}

/**
 * Returns a copy of `source` with every comment and string/template literal
 * blanked out (offsets preserved), so a name appearing in prose is never read as
 * a call. All structural scanning below runs on this masked text.
 */
function maskCommentsAndStrings(source) {
    const out = source.split('');
    let inLine = false, inBlock = false, quote = null;
    for (let i = 0; i < source.length; i++) {
        const c = source[i], next = source[i + 1];
        if (inLine) { if (c === '\n') inLine = false; else out[i] = ' '; continue; }
        if (inBlock) { if (c === '*' && next === '/') { out[i] = out[i + 1] = ' '; inBlock = false; i++; } else if (c !== '\n') out[i] = ' '; continue; }
        if (quote) {
            if (c === '\\') { out[i] = ' '; if (source[i + 1] !== '\n') out[i + 1] = ' '; i++; continue; }
            if (c === quote) { out[i] = ' '; quote = null; continue; }
            if (c !== '\n') out[i] = ' ';
            continue;
        }
        if (c === '/' && next === '/') { out[i] = out[i + 1] = ' '; inLine = true; i++; continue; }
        if (c === '/' && next === '*') { out[i] = out[i + 1] = ' '; inBlock = true; i++; continue; }
        if (c === '"' || c === "'" || c === '`') { out[i] = ' '; quote = c; continue; }
    }
    return out.join('');
}

/** Splits a file into its top-level function bodies by brace depth over the masked text. */
function topLevelFunctions(source, masked) {
    const ranges = [];
    let depth = 0;
    let openIndex = -1;
    for (let i = 0; i < masked.length; i++) {
        const c = masked[i];
        if (c === '{') {
            if (depth === 0) openIndex = i;
            depth++;
        } else if (c === '}') {
            depth--;
            if (depth === 0 && openIndex >= 0) {
                const headerStart = source.lastIndexOf('\n', source.lastIndexOf('\n', openIndex) - 1) + 1;
                const header = masked.slice(headerStart, openIndex);
                const named = header.match(/(?:function\s+(\w+)|const\s+(\w+)\s*[:=])/);
                ranges.push({
                    name: named ? (named[1] || named[2]) : '<anonymous>',
                    start: openIndex,
                    end: i + 1,
                    text: masked.slice(openIndex, i + 1),
                    raw: source.slice(openIndex, i + 1),
                    header,
                    params: (header.match(/\(([^)]*)\)/) || [, ''])[1]
                        .split(',').map((p) => p.trim().split(':')[0].trim()).filter(Boolean),
                });
                openIndex = -1;
            }
        }
    }
    return ranges;
}

/** Every `name(` call index inside `text` (offsets relative to `text`). */
function callIndices(text, name) {
    const re = new RegExp(`(?<![.\\w])(?:\\w+\\.)?${name}\\s*(?:<[^>(]*>)?\\s*\\(`, 'g');
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) out.push({ index: m.index, open: m.index + m[0].length - 1 });
    return out;
}

/** Index of the matching ')' for the '(' at `open`. */
function matchParen(text, open) {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        const c = text[i];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return text.length;
}

/** Spans [start,end) covered by every `name(...)` call in `text`. */
function callSpans(text, name) {
    return callIndices(text, name).map(({ index, open }) => [index, matchParen(text, open) + 1]);
}

/** Names called (in-file) from a function body. */
function calleesOf(fnText, definedNames) {
    const out = new Set();
    for (const name of definedNames) {
        if (callIndices(fnText, name).length > 0) out.add(name);
    }
    return out;
}

/** Transitive in-file closure of `start` over the call graph. */
function closure(start, graph) {
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) {
        for (const next of graph.get(stack.pop()) || []) {
            if (!seen.has(next)) { seen.add(next); stack.push(next); }
        }
    }
    return seen;
}

/**
 * Condition text of the innermost block enclosing `index` inside `fnText`,
 * i.e. everything between the previous statement boundary and the block's `{`.
 * Used to prove a cache-marker write is gated on a verification status.
 */
function enclosingConditionText(fnText, index) {
    let depth = 0;
    for (let i = index; i >= 0; i--) {
        const c = fnText[i];
        if (c === '}') depth++;
        else if (c === '{') {
            if (depth === 0) {
                const from = Math.max(0, i - 240);
                return fnText.slice(from, i);
            }
            depth--;
        }
    }
    return '';
}

/** Body text of the block that follows `index` (the `{ ... }` after an `if (...)`). */
function blockAfter(fnText, index) {
    const open = fnText.indexOf('{', index);
    if (open < 0) return fnText.slice(index, index + 400);
    let depth = 0;
    for (let i = open; i < fnText.length; i++) {
        const c = fnText[i];
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return fnText.slice(open, i + 1);
        }
    }
    return fnText.slice(open);
}

/**
 * `import { a, b as c } from './x'` and the `export { a, b } from './x'` re-export
 * form — same-directory-tree relative specifiers only, since those are the only
 * ones a sibling top-level function can resolve to. Read off the UNMASKED source
 * (the specifier is a string literal, blanked out in the masked text). Returns
 * Map<localName, {importedName, specifier}>.
 */
function parseRelativeImports(source) {
    const out = new Map();
    const re = /(?:import|export)\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]*)['"]/g;
    let m;
    while ((m = re.exec(source)) !== null) {
        for (const raw of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
            const [importedName, aliasName] = raw.split(/\s+as\s+/).map((s) => s.trim());
            out.set(aliasName || importedName, { importedName, specifier: m[2] });
        }
    }
    return out;
}

/** Resolves a relative import specifier from `fromFile` to one of `files`, or null. */
function resolveImportFile(fromFile, specifier, files) {
    let resolved = path.resolve(path.dirname(fromFile), specifier);
    if (!files.includes(resolved)) resolved += '.ts';
    return files.includes(resolved) ? resolved : null;
}

const files = walk(ROOT);
if (files.length === 0) {
    console.error(`FAIL: no **/src/**/*.ts files found under ${ROOT} — the signature would pass vacuously.`);
    process.exit(1);
}

const sites = [];
// Per-file state kept around after the phase 1/2 pass so the phase 3 (CACHE-ADMIT)
// pass below can resolve names across a same-directory `import`, once every
// file's RECORD-READ/RECORD-WRITE sites are known — see #998.
const fileStates = [];
// Module-scope 64-hex validator names, keyed by resolved absolute file path — read
// once per file even when several siblings import from the same one.
const hexConstsByFile = new Map();
function hexConstsOf(absPath, maskedText) {
    if (!hexConstsByFile.has(absPath)) {
        hexConstsByFile.set(absPath, [...maskedText.matchAll(/(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*(\/[^/\n]*\{64\}[^/\n]*\/[a-z]*)/g)].map((m) => m[1]));
    }
    return hexConstsByFile.get(absPath);
}

for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const masked = maskCommentsAndStrings(source);
    // Site identities must be byte-stable across platforms.
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const fns = topLevelFunctions(source, masked);
    if (fns.length === 0) continue;
    const lineOf = (absIndex) => source.slice(0, absIndex).split('\n').length;

    const byName = new Map(fns.filter((f) => f.name !== '<anonymous>').map((f) => [f.name, f]));
    const definedNames = [...byName.keys()];

    // Names imported from a same-directory-tree sibling resolve to that sibling's
    // OWN top-level functions (#998) — a call to one is a real graph edge, and its
    // RECORD-READ/RECORD-WRITE classification (established when ITS file is walked)
    // must count here too, not just when the call happens to stay in one file.
    const imports = parseRelativeImports(source);
    const importedNames = [...imports.keys()];
    const graph = new Map(fns.map((f) => [f.name, calleesOf(f.text, [...definedNames, ...importedNames])]));

    // 64-hex validators declared at module scope, e.g. `const SHA256_HEX_PATTERN = /^[a-fA-F0-9]{64}$/;`
    // — plus the same, declared beside a validator this file imports instead of
    // defining locally, so a validator living next to its (now-shared) reader still
    // counts (#998).
    const hexConsts = [
        ...hexConstsOf(file, masked),
        ...[...imports.values()].flatMap(({ specifier }) => {
            const resolved = resolveImportFile(file, specifier, files);
            if (!resolved) return [];
            return hexConstsOf(resolved, maskCommentsAndStrings(fs.readFileSync(resolved, 'utf8')));
        }),
    ];
    const validatesHex = (fnText) =>
        /\/\^?\[[^\]]*a-f[^\]]*\]\{64\}\$?\/[a-z]*\s*\.test\s*\(/i.test(fnText)
        || hexConsts.some((name) => new RegExp(`\\b${name}\\s*\\.test\\s*\\(`).test(fnText));

    const add = (kind, fn, verdict, why, index) =>
        sites.push({ kind, rel, fn: fn.name, verdict, why, line: lineOf(index) });

    /**
     * A pure download WRAPPER: it calls a primitive with a URL that is one of its
     * own parameters, so the verification decision belongs to whoever calls it.
     * Discovered, not listed — a new wrapper is picked up automatically, and its
     * callers are then enumerated as ACQUIRE sites in their own right.
     */
    const acquireWrappers = new Set(fns.filter((fn) =>
        DOWNLOAD_PRIMITIVES.some((p) => fn.name !== p && callIndices(fn.text, p).some(({ open }) =>
            fn.params.includes(fn.text.slice(open + 1, matchParen(fn.text, open)).split(',')[0].trim())))
    ).map((fn) => fn.name));

    // Phases: sites discovered later depend on classifications made earlier
    // (a cache-admit verdict needs to know which functions read/write the
    // integrity record), so the same function set is walked twice here. Phase 3
    // (CACHE-ADMIT) runs in its own pass below, once every file's RECORD-READ/
    // RECORD-WRITE sites are known — it is the one phase that can reach across a
    // same-directory `import` (#998), so it cannot run until the classifications
    // it depends on exist for every file, not just the one being walked right now.
    for (const phase of [1, 2]) for (const fn of fns) {
        if (fn.name === '<anonymous>') continue;
        const reach = closure(fn.name, graph);
        const reaches = (names) => names.some((n) =>
            [...reach].some((r) => (byName.get(r) ? callIndices(byName.get(r).text, n).length > 0 : false)));

        const discardSpans = callSpans(fn.text, DISCARD_GUARD);
        const inDiscardSpan = (i) => discardSpans.some(([s, e]) => i >= s && i < e);

        if (phase === 1) {
            // ---------------- VERIFY sites ----------------
            // Every direct verification of a downloaded artifact in this function.
            const verifierCalls = VERIFIERS.flatMap((v) => callIndices(fn.text, v).map((c) => ({ ...c, v })));
            // A function that reads a cache-integrity marker is verifying the AGENT'S
            // CACHED TOOL, not a fresh download: deleting it there would evict another
            // job's cache entry, so the discard requirement deliberately does not apply.
            const readsMarker = /(\w+)\s*=\s*(?:await\s+)?fs\.readFileSync\s*\(/.test(fn.text)
                && (VERIFIERS.some((v) => callIndices(fn.text, v).length > 0) || /!==|===/.test(fn.text))
                && /marker|sidecar|Marker|Sidecar/i.test(fn.text);
            for (const call of verifierCalls) {
                if (readsMarker) {
                    add('VERIFY', fn, 'EXEMPT-CACHE-VERIFY',
                        'verifies the agent-cached executable against its recorded marker; discarding here would evict another job\'s cache entry',
                        fn.start + call.index);
                } else if (inDiscardSpan(call.index)) {
                    add('VERIFY', fn, 'DISCARDS-ON-FAILURE', `${DISCARD_GUARD}() wraps ${call.v}`, fn.start + call.index);
                } else {
                    add('VERIFY', fn, 'RETAINS-ON-FAILURE',
                        `${call.v} is not wrapped in ${DISCARD_GUARD}() — a failed check leaves the artifact on disk (#204)`,
                        fn.start + call.index);
                }
            }

            // The discard itself lives in @4cloudguru/pipeline-task-core, which does not
            // import the ADO task lib, so the log line naming the deleted artifact is an
            // INJECTED sink. That makes it an argument a call site can silently omit,
            // leaving the operator with a rejected artifact removed and no record of it.
            for (const [start, end] of discardSpans) {
                const callText = fn.text.slice(start, end);
                if (/(^|[^\w$])discardLog(\W|$)/.test(callText)) {
                    add('DISCARD', fn, 'REPORTS-DISCARD', `${DISCARD_GUARD}() is passed the discardLog sink`, fn.start + start);
                } else {
                    add('DISCARD', fn, 'SILENT-DISCARD',
                        `${DISCARD_GUARD}() is called without the discardLog sink — the artifact is deleted with no record of it (#204)`,
                        fn.start + start);
                }
            }

            // ---------------- SUMS-ABSENT branches ----------------
            // The "this source published no checksum file" branch: a value assigned
            // from fetch{Text,Buffer}Allow404() (which returns null on a genuine 404,
            // never on a transient failure) that the function then null-checks. Only
            // counted in a function that itself verifies the artifact, so the branch
            // really does decide whether verification happens.
            const absentVars = [...fn.text.matchAll(/(\w+)\s*=\s*(?:await\s+)?fetch(?:Text|Buffer)Allow404\s*\(/g)].map((m) => m[1]);
            const verifiesHere = VERIFIERS.some((v) => callIndices(fn.text, v).length > 0);
            if (verifiesHere) {
                // The toggle governing SIGNATURE verification is whatever this
                // function passes as the `required` argument of its signature check —
                // read off the call, never hardcoded, so a rename cannot blind this.
                const signatureCall = SIGNATURE_VERIFIERS.flatMap((v) => callIndices(fn.text, v))[0];
                const signatureToggle = signatureCall
                    ? (fn.text.slice(signatureCall.open + 1, matchParen(fn.text, signatureCall.open)).split(',').pop() || '').trim()
                    : null;
                for (const v of absentVars) {
                    const m = fn.text.match(new RegExp(`\\b${v}\\s*===\\s*null`));
                    if (!m || m.index === undefined) continue;
                    const block = blockAfter(fn.text, m.index);
                    if (!signatureToggle) {
                        add('SUMS-ABSENT', fn, 'EXEMPT-NO-SIGNATURE-TRUST-ROOT',
                            'this source is sha256-rooted (it publishes no detached signature), so a require-signature toggle has nothing to check here',
                            fn.start + m.index);
                    } else if (new RegExp(`\\b${signatureToggle}\\b`).test(block) || SIGNATURE_TOGGLE.test(block)) {
                        add('SUMS-ABSENT', fn, 'HONORS-SIGNATURE-TOGGLE',
                            `the no-checksum-file branch consults ${signatureToggle} before installing`,
                            fn.start + m.index);
                    } else {
                        add('SUMS-ABSENT', fn, 'SIGNATURE-TOGGLE-INERT',
                            `a signature-rooted source published no checksum file and this branch never reads ${signatureToggle} — the toggle is inert exactly where verification is missing (#65)`,
                            fn.start + m.index);
                    }
                }
            }

            // ---------------- RECORD-READ / RECORD-WRITE ----------------
            const readAssign = [...fn.text.matchAll(/(\w+)\s*=\s*(?:await\s+)?fs\.readFileSync\s*\(/g)];
            for (const m of readAssign) {
                const v = m[1];
                const after = fn.text.slice(m.index);
                const usedAsExpectedHash =
                    new RegExp(`verifySha256\\s*\\([^)]*,\\s*${v}\\b`).test(after)
                    || new RegExp(`(?:!==|===)\\s*${v}\\b`).test(after)
                    || new RegExp(`\\b${v}\\s*(?:!==|===)`).test(after);
                if (!usedAsExpectedHash) continue;
                add('RECORD-READ', fn, validatesHex(fn.text) ? 'VALIDATES-RECORD' : 'TRUSTS-MALFORMED-RECORD',
                    validatesHex(fn.text)
                        ? 'the stored digest is validated as 64 hex characters before it is used as an expectation'
                        : 'a zero-length or truncated marker is fed straight to the comparison, so an unverifiable record reads as tampering and bricks the version (#198)',
                    fn.start + m.index);
            }
            const writeCalls = callIndices(fn.text, 'writeFileSync');
            for (const call of writeCalls) {
                const args = fn.text.slice(call.open + 1, matchParen(fn.text, call.open));
                if (!/hash|digest/i.test(args)) continue;
                add('RECORD-WRITE', fn, callIndices(fn.text, 'renameSync').length > 0 ? 'ATOMIC-WRITE' : 'TORN-WRITE',
                    callIndices(fn.text, 'renameSync').length > 0
                        ? 'written to a temp name in the same directory and renamed into place, so no reader ever sees a partial digest'
                        : 'a non-atomic write leaves a truncated marker behind if the job is killed mid-write (#198)',
                    fn.start + call.index);
            }

        } // end phase 1

        // ---------------- ACQUIRE sites ----------------
        // Any function that pulls an artifact off the network, whether through a
        // primitive directly or through a discovered wrapper.
        if (phase === 2) {
            const downloadCalls = [...DOWNLOAD_PRIMITIVES, ...acquireWrappers].flatMap((p) =>
                (fn.name === p ? [] : callIndices(fn.text, p)).map((c) => ({ ...c, p })));
            if (downloadCalls.length > 0) {
                const verifies = reaches(VERIFIERS);
                const verdict = verifies ? 'VERIFIED'
                    : acquireWrappers.has(fn.name) ? 'EXEMPT-DELEGATES-TO-CALLER'
                        : 'UNVERIFIED';
                add('ACQUIRE', fn, verdict,
                    verdict === 'VERIFIED' ? `reaches ${VERIFIERS.join('/')} before the artifact is used`
                        : verdict === 'EXEMPT-DELEGATES-TO-CALLER' ? 'pure download wrapper: the URL is a parameter, so the caller owns verification'
                            : 'downloads an artifact that no verification on this path ever checks',
                    fn.start + downloadCalls[0].index);
            }
        } // end phase 2

        // ---------------- LATEST resolution ----------------
        const resolvesLatest = /['"]latest['"]/i.test(fn.raw)
            && /toLowerCase\s*\(\s*\)\s*(?:!==|===)/.test(fn.text)
            && /\bcatch\b/.test(fn.text);
        if (phase === 1 && resolvesLatest) {
            const catchBlocks = [...fn.text.matchAll(/catch\s*(?:\([^)]*\))?\s*\{/g)]
                .map((m) => blockAfter(fn.text, m.index));
            // A catch that RETURNS a version instead of rethrowing is a stale
            // fallback, whatever it returns — a pinned constant, a literal, or a
            // cached value. Only rethrowing counts as failing closed.
            const fallsBack = catchBlocks.some((b) => /\breturn\b/.test(b) && !/\bthrow\b/.test(b));
            add('LATEST', fn, fallsBack ? 'STALE-FALLBACK' : 'FAILS-CLOSED',
                fallsBack
                    ? 'an unreachable version endpoint silently installs a pinned, potentially stale version instead of failing (#78)'
                    : 'an unresolvable "latest" fails the task instead of silently installing a pinned stale version',
                fn.start + fn.text.indexOf('catch'));
        }
    }

    fileStates.push({ file, rel, fns, byName, graph, imports, lineOf });
}

// ---------------- CACHE-ADMIT (own pass — see #998) ----------------
// Runs only after every file above has contributed its RECORD-READ/RECORD-WRITE
// sites, and resolves recordReaders/writerNames across a same-directory `import`
// exactly as it would within one file: a name is a candidate either because this
// file defines it, or because this file imports it from a sibling that does —
// either way, what matters is whether THAT name's own site (wherever it lives)
// was classified as a marker reader/writer.
for (const { file, rel, fns, byName, graph, imports, lineOf } of fileStates) {
    // Every name this file can call and have it resolve to a real definition:
    // its own top-level functions (defined here), plus whatever it imports from a
    // sibling — each tagged with the file its RECORD-READ/RECORD-WRITE site (if
    // any) would actually be recorded under.
    const resolvable = [
        ...[...byName.keys()].map((name) => ({ callName: name, defRel: rel, defName: name })),
        ...[...imports.entries()].map(([callName, { importedName, specifier }]) => {
            const resolved = resolveImportFile(file, specifier, files);
            if (!resolved) return null;
            return { callName, defRel: path.relative(ROOT, resolved).split(path.sep).join('/'), defName: importedName };
        }).filter(Boolean),
    ];
    const sitesOf = (kind) => resolvable.filter(({ defRel, defName }) =>
        sites.some((s) => s.rel === defRel && s.fn === defName && s.kind === kind));

    for (const fn of fns) {
        if (fn.name === '<anonymous>') continue;
        const reach = closure(fn.name, graph);
        for (const call of callIndices(fn.text, CACHE_LOOKUP)) {
            const recordReaders = sitesOf('RECORD-READ');
            const reverifies = recordReaders.some((r) => reach.has(r.callName));
            const writerNames = sitesOf('RECORD-WRITE');
            const writerCalls = writerNames.flatMap((r) => callIndices(fn.text, r.callName));
            const gated = writerCalls.every((w) => VERIFIED_STATUS.test(enclosingConditionText(fn.text, w.index)));
            // "There is no record for this cache entry" is a THIRD outcome,
            // distinct from verified and from mismatched. The reader must hand it
            // back and the admit site must act on it; a call whose result is
            // thrown away silently admits an entry nothing ever verified (#136).
            const consumesVerdict = recordReaders.some((r) =>
                new RegExp(`(?:const|let|var)\\s+\\w+\\s*(?::[^=]+)?=\\s*(?:await\\s+)?${r.callName}\\s*\\(`).test(fn.text));
            const verdict = !reverifies ? 'TRUSTS-CACHE-BLINDLY'
                : !consumesVerdict ? 'TRUSTS-UNMARKED-CACHE'
                    : !gated ? 'RECORDS-UNVERIFIED'
                        : 'REVERIFIES-AND-GATES';
            const WHY = {
                'REVERIFIES-AND-GATES': 'a cache hit is re-verified against the recorded marker, an unmarked entry is escalated, and a marker is only recorded for an artifact that was actually verified',
                'TRUSTS-CACHE-BLINDLY': 'a cache hit is used with no re-verification of any kind (#136)',
                'TRUSTS-UNMARKED-CACHE': 'the re-verification result is discarded, so a cache entry with NO integrity record is admitted with no verification at all (#136)',
                'RECORDS-UNVERIFIED': 'an integrity marker is recorded even when the fresh download was never verified, so a later cache hit "verifies" an unverified binary (#136)',
            };
            sites.push({ kind: 'CACHE-ADMIT', rel, fn: fn.name, verdict, why: WHY[verdict], line: lineOf(fn.start + call.index) });
        }
    }
}

const FAIL_VERDICTS = new Set([
    'UNVERIFIED',
    'RETAINS-ON-FAILURE',
    'SILENT-DISCARD',
    'SIGNATURE-TOGGLE-INERT',
    'TRUSTS-MALFORMED-RECORD',
    'TORN-WRITE',
    'TRUSTS-CACHE-BLINDLY',
    'TRUSTS-UNMARKED-CACHE',
    'RECORDS-UNVERIFIED',
    'STALE-FALLBACK',
    'DELEGATED-VERIFIER-UNPINNED',
]);

// ---- DELEGATED-VERIFY: the signature decision itself lives in a package (#399).
//
// Every other kind here asks whether an artifact reached a verifier. This one
// asks whether the verifier that runs is the one that was reviewed. verifyDetached
// decides whether a downloaded binary's checksums were signed by HashiCorp, and it
// is imported from @4cloudguru/pipeline-task-core/gpg -- so a floor that drifts, or
// a second nested copy, silently changes what "verified" means. That is the same
// hazard the network sinks are held to; it was simply never applied to the crypto one.
//
// Absorbed from azure-pipelines-packer's copy, where it was written. It finds
// TWICE as many sites in azure-pipelines-terraform as in the repository that
// wrote it -- two tasks importing verifyDetached that terraform's own gate
// could not see -- which is the whole argument for one canonical copy: a blind
// axis and a clean one are indistinguishable from the exit code.
const DELEGATED_VERIFIERS = {
    verifyDetached: {
        pkg: '@4cloudguru/pipeline-task-core',
        // Kept level with what the fleet declares, not with the release that
        // first exported verifyDetached (0.7.1). staleFloors() below compares
        // this against every task's declared range and fails the gate with the
        // value to raise it to; when the detector was ported (2026-09-09) it
        // reported exactly that on every clean tree -- min 0.7.1 against a
        // fleet at ^0.9.3, exit 1 with zero failures -- and this is the change
        // that acted on the report. A bar every task cleared several minors ago
        // cannot fire, and cannot fire is green about nothing (#1108 finding 2);
        // the next fleet-wide bump raises this in the same change or the gate
        // refuses it.
        min: '0.9.3',
        capability: 'the detached-signature verification decision',
        provides: 'the GPG verification decision',
    },
};

for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    for (const [name, spec] of Object.entries(DELEGATED_VERIFIERS)) {
        // Import specifiers are string literals, so the binding is read from raw
        // source; a name inside a comment cannot create a site because it must
        // appear in an import FROM that package.
        const imported = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]${spec.pkg.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}(?:/[\\w./-]+)?['"]`);
        if (!imported.test(raw)) continue;
        const { ok, why } = packageDelegationVerdict(file, spec, ROOT);
        sites.push({
            kind: 'DELEGATED-VERIFY', rel, fn: name,
            verdict: ok ? 'PINNED-DELEGATE' : 'DELEGATED-VERIFIER-UNPINNED',
            why, line: raw.slice(0, raw.search(imported)).split('\n').length,
        });
    }
}

// ---- Floor currency, ported from check-proxy-parity.js (#1108 finding 2).
//
// DELEGATED_VERIFIERS is the first table in this gate that enforces a minimum
// version of a shared package, which hands it the failure mode that gate has
// already been through: a floor naming the release that FIRST carried a
// behaviour goes stale as the fleet moves past it, nothing compares the two, and
// the bar ends up below every task in the repository. From the exit code that is
// indistinguishable from a repository with nothing wrong.
//
// This does not rewrite a floor. It fails the gate with the value to raise it
// to, which makes raising it part of the fleet bump that moved past it rather
// than something to notice later.

/**
 * Every version floor this file enforces, as (package, floor, where it is
 * written). Derived from the table rather than hand-listed, so a floor added to
 * DELEGATED_VERIFIERS cannot escape the currency check by being forgotten here.
 */
function declaredFloors() {
    const out = [];
    for (const [sink, entry] of Object.entries(DELEGATED_VERIFIERS)) {
        out.push({ where: `DELEGATED_VERIFIERS.${sink}`, pkg: entry.pkg, min: entry.min });
        if (entry.carries) out.push({ where: `DELEGATED_VERIFIERS.${sink}.carries`, pkg: entry.carries.pkg, min: entry.carries.min });
    }
    return out;
}

/**
 * Every task manifest under ROOT/Tasks, however deep.
 *
 * Named apart from this file's own walk() because that one collects the
 * TypeScript under every src directory and this one collects manifests; folding
 * the two into one predicate-driven walk would tie the src walk's skip list to
 * this one's, and they are not the same list.
 */
function walkTaskManifests(dir, found = []) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return found;
    }
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkTaskManifests(full, found);
        else if (entry.name === 'package.json') found.push(full);
    }
    return found;
}

/** The floor a caret/exact range pins, as [major, minor, patch], or null. */
function rangeFloor(range) {
    const parsed = /^\^?(\d+)\.(\d+)\.(\d+)/.exec(String(range).trim());
    return parsed ? parsed.slice(1).map(Number) : null;
}

const compareVersions = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * The LOWEST version of `pkg` any task in this repository actually declares, or
 * null when no task depends on it.
 *
 * Lowest, not highest, and the difference is the whole safety of this check: one
 * task still sitting at the floor keeps the bar live for every other task, and a
 * repository that does not use the package at all has no fleet to be measured
 * against -- null, never a notional 0.0.0, which would report every floor in
 * every unrelated repository as stale.
 */
function fleetFloor(pkg) {
    let lowest = null;
    for (const manifest of walkTaskManifests(path.join(ROOT, 'Tasks'))) {
        let json;
        try {
            json = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        } catch {
            continue;
        }
        const parsed = rangeFloor((json.dependencies || {})[pkg]);
        if (parsed && (lowest === null || compareVersions(parsed, lowest) < 0)) lowest = parsed;
    }
    return lowest;
}

/** Floors that sit below what every task already declares, with the value to raise them to. */
function staleFloors() {
    const stale = [];
    for (const floor of declaredFloors()) {
        const fleet = fleetFloor(floor.pkg);
        if (!fleet) continue;
        const declared = rangeFloor(floor.min);
        if (declared && compareVersions(declared, fleet) < 0) {
            stale.push({ ...floor, fleet: fleet.join('.') });
        }
    }
    return stale;
}

const seen = new Set();
const unique = sites.filter((s) => {
    const key = `${s.rel}:${s.kind}:${s.fn}:${s.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
}).sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line || a.kind.localeCompare(b.kind));

const failures = unique.filter((s) => FAIL_VERDICTS.has(s.verdict));
const stale = staleFloors();

if (JSON_OUTPUT) {
    // `failures` stays the count of DEFECTIVE ROWS and nothing else. The replay
    // adapter classifies the rows itself and die()s when its own count and this
    // number disagree, so folding a stale floor in here would turn an inert bar
    // into could-not-run on every host at once. A stale floor is its own field
    // and its own reason for exiting 1.
    console.log(JSON.stringify({ root: ROOT, sites: unique, failures: failures.length, scanned: files.length, staleFloors: stale }, null, 2));
    process.exit(failures.length || stale.length ? 1 : 0);
}

console.log(`artifact-trust signature — ${path.basename(ROOT)} (${files.length} src file(s), ${unique.length} trust site(s))\n`);
for (const kind of ['ACQUIRE', 'VERIFY', 'DELEGATED-VERIFY', 'DISCARD', 'SUMS-ABSENT', 'CACHE-ADMIT', 'RECORD-READ', 'RECORD-WRITE', 'LATEST']) {
    const rows = unique.filter((s) => s.kind === kind);
    if (rows.length === 0) continue;
    console.log(`${kind} (${rows.length}):`);
    for (const r of rows) console.log(`  ${FAIL_VERDICTS.has(r.verdict) ? 'FAIL ' : '     '}${r.rel}:${r.line}  ${r.fn}()  ${r.verdict}`);
    console.log('');
}

if (stale.length) {
    console.error(`\nSTALE FLOORS (${stale.length})`);
    for (const f of stale) {
        console.error(`  ${f.where}: floor ${f.min} for ${f.pkg}, but every task already declares >= ${f.fleet} -- the floor cannot fire.`);
    }
}

if (failures.length > 0) {
    console.error(`FAIL: ${failures.length} residual instance(s) of the artifact-trust class.`);
    for (const f of failures) console.error(`  ${f.rel}:${f.line} ${f.fn}() [${f.kind}] ${f.verdict}\n      ${f.why}`);
}
if (stale.length) {
    console.error(`\nFAIL: ${stale.length} version floor(s) have fallen behind the fleet and can no longer fire.`);
    console.error('      Raise each to the version shown, keeping the comment that says which release first carried the behaviour.');
}
if (failures.length || stale.length) process.exit(1);
console.log('OK: every path by which an artifact becomes trusted verifies it, discards it on failure, and degrades legibly, and every version floor still tracks the fleet.');
