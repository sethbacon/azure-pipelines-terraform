#!/usr/bin/env node
// EGRESS-AUTHORIZATION SIGNATURE (#161 / #191, sibling azure-pipelines-packer #161).
//
// Defect class
// ------------
//   An egress destination is authorized by inspecting its TEXTUAL form rather
//   than its RESOLVED address, and the authorization is not re-applied to every
//   hop or at connect time.
//
// That shape produced five separate regressions in one audit: a dotted-quad
// blocklist that `127.1`, `2130706433`, `0x7f000001` and `[::ffff:127.0.0.1]`
// all walk past (they are 127.0.0.1 to the socket), RFC6598 100.64.0.0/10 that
// was never listed at all, and a redirect-hop callback that re-checked only the
// literal blocklist while the initial-host check also resolved DNS.
//
// What this script enforces
// -------------------------
//   1. Every DYNAMIC-destination network sink (a download/fetch whose URL is not
//      a constant host) must sit in a function that routes the host through
//      `assertEgressHostAllowed` — the single helper that applies the allowlist
//      OR the numeric private/reserved + DNS check, identically for the initial
//      URL and for every redirect hop.
//   2. A site that authorizes with the raw primitives (`isPrivateOrLinkLocalHost`
//      / `isRegistryHostAllowed`) but not the helper is reported as TEXTUAL-ONLY
//      and FAILS: that is exactly the half-applied shape that regressed, where an
//      initial check and a per-hop check could drift apart.
//   3. Address classification may only live in the shared allowlist module. A
//      dotted-quad regex or a hardcoded loopback/metadata literal anywhere else
//      in a src/ tree is reported as a SUSPECT textual blocklist and FAILS.
//
// Repo-agnostic: it discovers `**/src/**/*.ts` under the repo root, so it runs
// unchanged in azure-pipelines-terraform and azure-pipelines-packer (and in any
// sibling that grows an installer). Usage:
//
//     node scripts/check-egress-authorization.js [repoRoot]
//
// Exit 0 = no residual instances of the class. Exit 1 = residuals, listed.

const fs = require('fs');
const path = require('path');

// `--json` prints the machine-readable finding list (used by the class test's
// per-site table) instead of the human report; the exit code is identical.
const JSON_OUTPUT = process.argv.includes('--json');
const ROOT = path.resolve(process.argv.filter(a => a !== '--json')[2] || process.cwd());

// The helper that IS the fix. A site routed through it is authorized.
const AUTHORIZER = 'assertEgressHostAllowed';

// The raw primitives. Present WITHOUT the authorizer = the half-applied shape.
const RAW_PRIMITIVES = ['isPrivateOrLinkLocalHost', 'isRegistryHostAllowed', 'resolvesToPrivateOrLinkLocalAddress'];

// The one module allowed to contain address-classification logic.
const CLASSIFIER_MODULE = 'registry-allowlist.ts';

// Outbound network sinks. Deliberately broad: any of these initiating a request
// to a destination this process did not fix at build time is in the class.
const SINKS = [
    'downloadToFile', 'downloadTool', 'downloadToolWithTimeout', 'downloadTo',
    'downloadFromMirrorUrl', 'fetchWithTimeout', 'fetchJson', 'fetchText',
    'fetchTextAllow404', 'fetchBuffer', 'fetchBufferAllow404',
];

// A function may authorize by INVOKING an authorizer its caller injects, rather
// than by calling assertEgressHostAllowed itself. Recognized structurally -- a
// parameter declared to take a hostname and return a promise -- not by name.
// Callers of such a function are separately required to pass the real authorizer
// (see AUTHORIZER_ARG below); recognizing the parameter alone would let a caller
// hand over a no-op and still read as authorized.
const AUTHORIZER_PARAM = /(\w+)\s*:\s*\(\s*(?:hostname|host)\s*:\s*string\s*\)\s*=>\s*Promise\s*<\s*void\s*>/g;

function authorizerParams(header) {
    return [...header.matchAll(AUTHORIZER_PARAM)].map(m => m[1]);
}

function invokesInjectedAuthorizer(fn) {
    return authorizerParams(fn.header).some(p => new RegExp(`await\\s+${p}\\s*\\(`).test(fn.text));
}

/**
 * Finds where a function's header begins, so a sink can be attributed to the name
 * responsible for authorizing it.
 *
 * Anchors on the declaration keyword rather than counting lines back from the
 * opening brace. Reading a fixed two lines back meant a signature wrapped over
 * more lines parsed as <anonymous> and every sink inside it was skipped --
 * wrapping a signature silently removed its egress sites from this gate. Walking
 * back to the previous statement boundary instead is wrong too: a return type
 * like Promise<{ path: string }> puts a brace between the name and the body.
 */
const DECLARATION = /(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(|(?:export\s+)?(?:const|let|var)\s+\w+\s*[:=]/g;

function headerStart(source, openIndex) {
    const windowStart = Math.max(0, openIndex - 2000);
    const slice = source.slice(windowStart, openIndex);
    let last = -1;
    DECLARATION.lastIndex = 0;
    let m;
    while ((m = DECLARATION.exec(slice)) !== null) last = m.index;
    if (last >= 0) return windowStart + last;
    let start = 0;
    for (const token of [';', '}', '{', '*/']) {
        const idx = source.lastIndexOf(token, openIndex - 1);
        if (idx >= 0) start = Math.max(start, idx + token.length);
    }
    return start;
}

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
 * Splits a file into its top-level function bodies by brace depth, so a sink can
 * be attributed to the function that is responsible for authorizing it. Returns
 * [{ name, start, end, text, params }].
 */
function topLevelFunctions(source) {
    const ranges = [];
    let depth = 0;
    let openIndex = -1;
    let inLine = false, inBlock = false, quote = null;
    for (let i = 0; i < source.length; i++) {
        const c = source[i], next = source[i + 1];
        if (inLine) { if (c === '\n') inLine = false; continue; }
        if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i++; } continue; }
        if (quote) {
            if (c === '\\') { i++; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '/' && next === '/') { inLine = true; i++; continue; }
        if (c === '/' && next === '*') { inBlock = true; i++; continue; }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
        if (c === '{') {
            if (depth === 0) openIndex = i;
            depth++;
        } else if (c === '}') {
            depth--;
            if (depth === 0 && openIndex >= 0) {
                const header = source.slice(headerStart(source, openIndex), openIndex);
                const named = header.match(/(?:function\s+(\w+)|const\s+(\w+)\s*[:=])/);
                ranges.push({
                    name: named ? (named[1] || named[2]) : '<anonymous>',
                    start: openIndex,
                    end: i + 1,
                    text: source.slice(openIndex, i + 1),
                    header,
                });
                openIndex = -1;
            }
        }
    }
    return ranges;
}

/**
 * Returns a copy of `source` with every comment and string/template literal
 * blanked out (offsets preserved), so a sink NAME appearing in prose — e.g. the
 * comment "fetchJson() guards against a non-JSON body" — is never scanned as a
 * call. Argument text is still read from the original source.
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

/** Extracts every argument of the call whose '(' is at or after `index`. */
function allArguments(source, index) {
    const open = source.indexOf('(', index);
    if (open < 0) return [];
    const args = [];
    let depth = 0, start = open + 1;
    for (let i = open; i < source.length; i++) {
        const c = source[i];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') {
            depth--;
            if (depth === 0) { args.push(source.slice(start, i)); break; }
        } else if (c === ',' && depth === 1) { args.push(source.slice(start, i)); start = i + 1; }
    }
    return args.map(a => a.trim());
}

/** Extracts argument `n` (0-based) of the call whose '(' is at or after `index`. */
function argumentAt(source, index, n) {
    const open = source.indexOf('(', index);
    if (open < 0) return '';
    const args = [];
    let depth = 0, start = open + 1;
    for (let i = open; i < source.length; i++) {
        const c = source[i];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') {
            depth--;
            if (depth === 0) { args.push(source.slice(start, i)); break; }
        } else if (c === ',' && depth === 1) { args.push(source.slice(start, i)); start = i + 1; }
    }
    return (args[n] || '').trim();
}

/**
 * Resolves an argument expression to the URL it actually denotes, following ONE
 * level of local `const x = <expr>` and one level of `return` inside a local
 * helper, so `const u = getHashiCorpDownloadUrl(v); downloadTool(u, ...)` is
 * recognized as the constant host it is.
 */
function resolveExpression(expr, fnText, source) {
    if (/^[A-Za-z_]\w*$/.test(expr)) {
        const local = fnText.match(new RegExp(`\\b(?:const|let)\\s+${expr}\\s*(?::[^=]+)?=\\s*([^;]+);`));
        if (local) return resolveExpression(local[1].trim(), fnText, source);
        const helper = source.match(new RegExp(`function\\s+${expr}\\s*\\([^)]*\\)[^{]*\\{\\s*return\\s+([^;]+);`));
        if (helper) return helper[1].trim();
    }
    // A template whose leading interpolation is a local URL variable:
    // `${downloadUrl}.sha256` denotes whatever downloadUrl denotes.
    const leading = expr.match(/^`\$\{(\w+)\}/);
    if (leading) {
        const base = resolveExpression(leading[1], fnText, source);
        if (base !== leading[1]) {
            return base.replace(/`$/, '') + expr.slice(leading[0].length).replace(/`$/, '') + '`';
        }
    }
    const call = expr.match(/^(\w+)\s*\(/);
    if (call) {
        const helper = source.match(new RegExp(`function\\s+${call[1]}\\s*\\([^)]*\\)[^{]*\\{\\s*return\\s+([^;]+);`));
        if (helper) return helper[1].trim();
    }
    return expr;
}

/** A destination whose HOST cannot be influenced at run time. */
function isConstantHost(expr) {
    const literal = expr.match(/^['"](https?:\/\/[^'"/]+)/);
    if (literal) return true;
    const template = expr.match(/^`https?:\/\/([^`]*?)(?:\/|`)/);
    return !!(template && !template[1].includes('${'));
}

const files = walk(ROOT);
if (files.length === 0) {
    console.error(`FAIL: no **/src/**/*.ts files found under ${ROOT} — the signature would pass vacuously.`);
    process.exit(1);
}

const findings = [];
const suspects = [];

for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    // Site identities must be byte-stable across platforms: path.relative yields
    // backslashes on Windows, which would make every site id differ from the POSIX
    // form the class test and the ledger record.
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const fns = topLevelFunctions(source);
    const masked = maskCommentsAndStrings(source);
    const lineOf = (i) => source.slice(0, i).split('\n').length;

    // --- 3. textual address classification outside the sanctioned module ---
    if (path.basename(file) !== CLASSIFIER_MODULE) {
        const textual = [
            /\/\^?\(?\\d\{1,3\}\\?\.\\d\{1,3\}/,          // dotted-quad regex
            /['"]169\.254\.169\.254['"]/,                  // metadata literal
            /===\s*['"]127\.0\.0\.1['"]/,                  // loopback comparison
            /===\s*['"]localhost['"]/,
            /startsWith\(\s*['"](?:10\.|192\.168\.|172\.1)/,
        ];
        source.split('\n').forEach((line, i) => {
            if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
            if (textual.some(re => re.test(line))) {
                suspects.push(`${rel}:${i + 1}: textual address classification outside ${CLASSIFIER_MODULE}: ${line.trim().slice(0, 100)}`);
            }
        });
    }

    // --- 1./2. sinks ---
    // Pass 0 DISCOVERS wrappers only (a function whose sink URL is one of its own
    // parameters delegates the authorization decision to its callers); pass 1 does
    // all the reporting, with those wrappers treated as sinks too.
    // name -> index of the argument that carries the URL (0 for the primitives).
    const wrappers = new Map();
    for (const pass of [0, 1]) {
        const sinkNames = pass === 0
            ? SINKS.map(n => [n, { index: 0, authorized: false }])
            // Wrapper entries first: when a repo-local wrapper shares a name with a
            // base sink, its discovered URL-argument index and internal authorization
            // are the accurate reading, and the dedup below keeps the first verdict.
            : [...wrappers, ...SINKS.map(n => [n, { index: 0, authorized: false }])];
        for (const [name, { index: urlArgIndex, authorized: viaWrapper }] of sinkNames) {
            const re = new RegExp(`(?<![.\\w])(?:\\w+\\.)?${name}\\s*(?:<[^>(]*>)?\\s*\\(`, 'g');
            let m;
            while ((m = re.exec(masked)) !== null) {
                const fn = fns.find(f => m.index > f.start && m.index < f.end);
                if (!fn || fn.name === name) continue;
                if (/^(export\s+)?(async\s+)?function\s/.test(fn.header) === false && fn.name === '<anonymous>') continue;
                const raw = argumentAt(source, m.index + m[0].length - 1, urlArgIndex);
                const params = (fn.header.match(/\(([^)]*)\)/) || [, ''])[1]
                    .split(',').map(p => p.trim().split(':')[0].trim()).filter(Boolean);
                // The URL is one of this function's own parameters: the
                // authorization decision belongs to its CALLERS, so record the
                // parameter position and re-scan treating calls to it as sinks.
                if (params.includes(raw)) {
                    if (pass === 0) wrappers.set(fn.name, { index: params.indexOf(raw), authorized: fn.text.includes(`${AUTHORIZER}(`) });
                    continue;
                }
                const expr = resolveExpression(raw, fn.text, source);
                if (pass === 0) continue;
                if (isConstantHost(expr)) {
                    findings.push({ verdict: 'EXEMPT-CONSTANT-HOST', rel, line: lineOf(m.index), fn: fn.name, sink: name, expr: expr.slice(0, 70) });
                    continue;
                }
                // A sink that takes a per-hop authorization CALLBACK must have the
                // authorizer INSIDE that callback, not merely somewhere in the
                // enclosing function. That distinction is the #191 defect exactly:
                // the initial-host check resolved DNS while the redirect-hop
                // callback re-checked only the textual blocklist, and a
                // function-level test could not tell the two apart.
                const callbackArgs = allArguments(source, m.index + m[0].length - 1)
                    .filter(a => a.includes('=>') || /^(async\s+)?function\b/.test(a));
                const callbackUnauthorized = callbackArgs.length > 0
                    && !callbackArgs.every(a => a.includes(`${AUTHORIZER}(`));
                // A call to a wrapper that authorizes internally is authorized:
                // the decision belongs wherever the destination host is known.
                const authorized = !callbackUnauthorized
                    && (viaWrapper || fn.text.includes(`${AUTHORIZER}(`) || invokesInjectedAuthorizer(fn));
                const rawOnly = !authorized
                    && (callbackUnauthorized || RAW_PRIMITIVES.some(p => fn.text.includes(`${p}(`)));
                let verdict;
                if (authorized) verdict = 'AUTHORIZED';
                else if (rawOnly) verdict = 'TEXTUAL-ONLY';
                else verdict = 'UNAUTHORIZED';
                findings.push({ verdict, rel, line: lineOf(m.index), fn: fn.name, sink: name, expr: expr.slice(0, 70) });
            }
        }
    }
}

const order = ['UNAUTHORIZED', 'TEXTUAL-ONLY', 'AUTHORIZED', 'EXEMPT-CONSTANT-HOST'];
const seen = new Set();
const unique = findings.filter(f => {
    const key = `${f.rel}:${f.line}:${f.sink}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
});

// A function that authorizes through an injected authorizer only actually
// authorizes if its CALLERS hand it the real one. Without this, satisfying the
// gate would be as easy as declaring the parameter and passing () => {}.
const injectedCallSiteFailures = [];
const injectedSeen = new Set();
for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    for (const fn of topLevelFunctions(source)) {
        const params = authorizerParams(fn.header);
        if (params.length === 0) continue;
        const name = (fn.header.match(/function\s+(\w+)/) || [])[1];
        if (!name) continue;
        const argIndex = (fn.header.match(/\(([\s\S]*)\)/) || [, ''])[1]
            .split(',').map(p => p.trim().split(':')[0].trim()).indexOf(params[0]);
        if (argIndex < 0) continue;
        for (const callFile of files) {
            const callSource = fs.readFileSync(callFile, 'utf8');
            const callRel = path.relative(ROOT, callFile).split(path.sep).join('/');
            const callRe = new RegExp(`(?<![.\\w])${name}\\s*\\(`, 'g');
            let cm;
            while ((cm = callRe.exec(maskCommentsAndStrings(callSource))) !== null) {
                if (/(?:function|import)\s+$/.test(callSource.slice(Math.max(0, cm.index - 30), cm.index))) continue;
                const arg = argumentAt(callSource, cm.index + cm[0].length - 1, argIndex);
                if (arg === null || arg === undefined) continue;
                if (!String(arg).includes(`${AUTHORIZER}(`)) {
                    const key = `${callRel}:${callSource.slice(0, cm.index).split('\n').length}`;
                    if (!injectedSeen.has(key)) {
                        injectedSeen.add(key);
                        injectedCallSiteFailures.push(
                            `${key}: ${name}() requires an egress authorizer but this call passes ${JSON.stringify(String(arg).slice(0, 60))}`);
                    }
                }
            }
        }
    }
}

const failures = unique.filter(f => f.verdict === 'UNAUTHORIZED' || f.verdict === 'TEXTUAL-ONLY').length
    + suspects.length + injectedCallSiteFailures.length;

if (JSON_OUTPUT) {
    console.log(JSON.stringify({ root: ROOT, sites: unique, suspects: [...suspects, ...injectedCallSiteFailures], failures }, null, 2));
    process.exit(failures > 0 ? 1 : 0);
}

console.log(`egress-authorization signature — ${path.basename(ROOT)} (${files.length} src file(s), ${unique.length} sink(s))\n`);
for (const verdict of order) {
    const rows = unique.filter(f => f.verdict === verdict).sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);
    if (rows.length === 0) continue;
    console.log(`${verdict} (${rows.length}):`);
    for (const r of rows) console.log(`  ${r.rel}:${r.line}  ${r.fn}() -> ${r.sink}(${r.expr})`);
    console.log('');
}
if (suspects.length) {
    console.log(`SUSPECT-TEXTUAL-BLOCKLIST (${suspects.length}):`);
    for (const s of suspects) console.log(`  ${s}`);
    console.log('');
}
if (injectedCallSiteFailures.length) {
    console.log(`INJECTED-AUTHORIZER-NOT-SUPPLIED (${injectedCallSiteFailures.length}):`);
    for (const s of injectedCallSiteFailures) console.log(`  ${s}`);
    console.log('');
}

if (failures > 0) {
    console.error(`FAIL: ${failures} residual instance(s) of the egress-authorization class.`);
    console.error(`      Route the destination host through ${AUTHORIZER}() — the same call for the initial URL and for every redirect hop.`);
    process.exit(1);
}
console.log('OK: every dynamic-destination egress site is authorized through assertEgressHostAllowed.');
