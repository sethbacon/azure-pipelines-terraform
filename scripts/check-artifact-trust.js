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

const files = walk(ROOT);
if (files.length === 0) {
    console.error(`FAIL: no **/src/**/*.ts files found under ${ROOT} — the signature would pass vacuously.`);
    process.exit(1);
}

const sites = [];

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
    const graph = new Map(fns.map((f) => [f.name, calleesOf(f.text, definedNames)]));

    // 64-hex validators declared at module scope, e.g. `const SHA256_HEX_PATTERN = /^[a-fA-F0-9]{64}$/;`
    const hexConsts = [...masked.matchAll(/(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*(\/[^/\n]*\{64\}[^/\n]*\/[a-z]*)/g)].map((m) => m[1]);
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
    // integrity record), so the same function set is walked three times.
    for (const phase of [1, 2, 3]) for (const fn of fns) {
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

        // ---------------- CACHE-ADMIT ----------------
        if (phase === 3) for (const call of callIndices(fn.text, CACHE_LOOKUP)) {
            const recordReaders = [...byName.keys()].filter((n) =>
                sites.some((s) => s.rel === rel && s.fn === n && s.kind === 'RECORD-READ'));
            const reverifies = recordReaders.some((n) => reach.has(n));
            const writerNames = [...byName.keys()].filter((n) =>
                sites.some((s) => s.rel === rel && s.fn === n && s.kind === 'RECORD-WRITE'));
            const writerCalls = writerNames.flatMap((n) => callIndices(fn.text, n));
            const gated = writerCalls.every((w) => VERIFIED_STATUS.test(enclosingConditionText(fn.text, w.index)));
            // "There is no record for this cache entry" is a THIRD outcome,
            // distinct from verified and from mismatched. The reader must hand it
            // back and the admit site must act on it; a call whose result is
            // thrown away silently admits an entry nothing ever verified (#136).
            const consumesVerdict = recordReaders.some((n) =>
                new RegExp(`(?:const|let|var)\\s+\\w+\\s*(?::[^=]+)?=\\s*(?:await\\s+)?${n}\\s*\\(`).test(fn.text));
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
            add('CACHE-ADMIT', fn, verdict, WHY[verdict], fn.start + call.index);
        }

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
]);

const seen = new Set();
const unique = sites.filter((s) => {
    const key = `${s.rel}:${s.kind}:${s.fn}:${s.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
}).sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line || a.kind.localeCompare(b.kind));

const failures = unique.filter((s) => FAIL_VERDICTS.has(s.verdict));

if (JSON_OUTPUT) {
    console.log(JSON.stringify({ root: ROOT, sites: unique, failures: failures.length }, null, 2));
    process.exit(failures.length > 0 ? 1 : 0);
}

console.log(`artifact-trust signature — ${path.basename(ROOT)} (${files.length} src file(s), ${unique.length} trust site(s))\n`);
for (const kind of ['ACQUIRE', 'VERIFY', 'DISCARD', 'SUMS-ABSENT', 'CACHE-ADMIT', 'RECORD-READ', 'RECORD-WRITE', 'LATEST']) {
    const rows = unique.filter((s) => s.kind === kind);
    if (rows.length === 0) continue;
    console.log(`${kind} (${rows.length}):`);
    for (const r of rows) console.log(`  ${FAIL_VERDICTS.has(r.verdict) ? 'FAIL ' : '     '}${r.rel}:${r.line}  ${r.fn}()  ${r.verdict}`);
    console.log('');
}

if (failures.length > 0) {
    console.error(`FAIL: ${failures.length} residual instance(s) of the artifact-trust class.`);
    for (const f of failures) console.error(`  ${f.rel}:${f.line} ${f.fn}() [${f.kind}] ${f.verdict}\n      ${f.why}`);
    process.exit(1);
}
console.log('OK: every path by which an artifact becomes trusted verifies it, discards it on failure, and degrades legibly.');
