#!/usr/bin/env node
// OUTBOUND-PROXY-PARITY SIGNATURE (#196, sibling azure-pipelines-terraform).
//
// Defect class
// ------------
//   An outbound HTTP request is issued through a transport primitive that does
//   NOT consult the ADO agent's configured proxy, in a repo where sibling
//   transports do.
//
// Why it is a security defect and not an availability one: on a self-hosted
// agent whose only egress is a forward proxy, an unproxied call fails. The
// workaround an operator reaches for is switching the service connection back to
// a static access key, a GCP service-account JSON key, or an Azure client secret
// -- i.e. the long-lived credentials Workload Identity Federation exists to
// eliminate. The reported instance (#196) was the OIDC token generator used by
// every WIF provider, while the installer in the same repo had been
// proxy-aware since day one.
//
// Node's global fetch() ignores HTTP_PROXY/HTTPS_PROXY and every agent setting
// unless it is handed an undici dispatcher; node:https likewise ignores them
// unless handed an `agent`. So "honours the proxy" is a property of the CALL,
// not of the process environment, and every call site has to be checked.
//
// What this script enforces
// -------------------------
//   1. Every `fetch()` call in a task's src/ tree must supply proxy options --
//      either an explicit `dispatcher`, or a spread of one of the repo's proxy
//      option builders (buildFetchOptions / buildProxyFetchOptions), or the
//      shared package's builder (buildAdoFetchOptions).
//   2. Every `https.request` / `https.get` / `http.request` / `http.get` call
//      must supply an `agent`, which is how this codebase injects its
//      CONNECT-tunnelling ProxyTunnelAgent. When that call has been delegated to
//      a shared package (`httpsRequest`), the site is still checked HERE, on the
//      `agent` it passes and the package version the task declares — a delegated
//      call that leaves the inventory is how this gate goes green by seeing
//      nothing.
//   3. Recognised exemptions, each verified against the code they name, are
//      reported but do not fail:
//        EXEMPT-TOOL-LIB        azure-pipelines-tool-lib's downloadTool builds
//                               its HttpClient with
//                               `proxy: tl.getHttpProxyConfiguration()`
//                               (node_modules/azure-pipelines-tool-lib/tool.js).
//        EXEMPT-PROXY-TRANSPORT the request IS the CONNECT hop to the proxy, made
//                               from inside an https.Agent subclass. Routing it
//                               through a proxy agent would be a loop.
//        EXEMPT-BROWSER         the file runs in the build-results-tab iframe,
//                               not on the agent: there is no task-lib and the
//                               browser applies the user's own proxy settings.
//
// Repo-agnostic: it discovers `**/src/**/*.ts(x)` under the repo root, so it runs
// unchanged in azure-pipelines-packer and azure-pipelines-terraform. Usage:
//
//     node scripts/check-proxy-parity.js [repoRoot] [--json]
//
// Exit 0 = no residual instances of the class. Exit 1 = residuals, listed.

const fs = require('fs');
const path = require('path');

// `--json` prints the machine-readable finding list (consumed by the class
// test's per-site table) instead of the human report; the exit code is identical.
const JSON_OUTPUT = process.argv.includes('--json');
const ROOT = path.resolve(process.argv.filter((a) => a !== '--json')[2] || process.cwd());

/** Builders that return a RequestInit carrying a proxy dispatcher. */
const PROXY_OPTION_BUILDERS = ['buildFetchOptions', 'buildProxyFetchOptions', 'buildAdoFetchOptions'];

/** Transport primitives that bypass the proxy unless explicitly told not to. */
const FETCH_SINKS = ['fetch'];
const NODE_HTTP_SINKS = ['https.request', 'https.get', 'http.request', 'http.get'];

/**
 * Factories that own the real `fetch()` on this repo's behalf, in a package that
 * cannot read the agent's proxy itself. Delegating the transport moves the real
 * fetch() out of this tree, so without this rule the gate simply stops seeing
 * the call site and passes vacuously. The proxy decision is still made here, as
 * an injected option, so it is still checked here.
 */
const DELEGATED_FETCH_SINKS = ['createHttpClient'];

/**
 * Factories where the proxy DECISION itself has left this repo, not just the
 * fetch() call: @4cloudguru/pipeline-task-ado reads the agent proxy, registers
 * every spelling of the credential and builds the dispatcher internally, so
 * there is no fetchOptions here to inspect and the shape check above cannot
 * apply.
 *
 * A site that cannot be shape-checked must still be checked, or it silently
 * leaves the inventory and the gate passes by seeing nothing — the exact
 * failure this file exists to prevent, and one this repo has now hit twice
 * (#949, and again on the move to the ado package). What is verifiable here is
 * PROVENANCE: that the task depends on a version of the package known to carry
 * the wiring and the tests that assert its ordering. So the assertion becomes a
 * version floor, and the site stays in the report either way.
 */
const PACKAGE_DELEGATED_SINKS = {
    createAdoHttpClient: {
        pkg: '@4cloudguru/pipeline-task-ado',
        min: '0.3.0',
        // The package delegates onward to core, so the direct floor above only
        // vouches for the wiring - not for which implementation it wires up.
        // ado@0.2.0 declared core ^0.3.1 while the tasks declared ^0.5.0, and
        // caret on a 0.x version is patch-only, so the ranges were disjoint,
        // npm nested a second copy, and the delegated client ran the older one.
        // Both floors passed throughout. Hence the resolved check below.
        carries: { pkg: '@4cloudguru/pipeline-task-core', min: '0.5.0' },
    },
    // generateIdToken (#46 extraction): the OIDC token exchange's fetch(), and
    // the proxy decision that wraps it (buildAdoFetchOptions), both moved into
    // @4cloudguru/pipeline-task-ado -- there is no local fetchOptions to
    // inspect here either. Same onward-delegation shape as createAdoHttpClient
    // above: the package's own buildAdoFetchOptions calls resolveProxy from
    // pipeline-task-core, so a stale nested copy of THAT package would run old
    // proxy logic even with a fresh ado floor.
    generateIdToken: {
        pkg: '@4cloudguru/pipeline-task-ado',
        min: '0.5.0',
        carries: { pkg: '@4cloudguru/pipeline-task-core', min: '0.6.0' },
    },
    // exchangeOidcForUpst (#1074): the OCI WIF flow's SECOND hop. This one was
    // extracted in the other direction from the rest of this table -- it was
    // defined here and moved out, because azure-pipelines-packer needed the
    // same realm allowlist and redirect policy and a copy would have drifted
    // invisibly (check-shared-modules.js verifies a provenance header, it
    // cannot byte-compare across repos). Floor is 0.8.0, the release that
    // first exports it; same onward-delegation shape as the two above, since
    // its fetch options come from the package's own buildAdoFetchOptions.
    exchangeOidcForUpst: {
        pkg: '@4cloudguru/pipeline-task-ado',
        min: '0.8.0',
        carries: { pkg: '@4cloudguru/pipeline-task-core', min: '0.6.0' },
    },
};

/**
 * Builders that return a CONNECT-tunnelling https.Agent for the raw-https
 * transports. `createProxyTunnelAgent` is the package's; `buildProxyAgent` is
 * the six-line task-side adapter that hands it the agent's proxy configuration
 * and the log masker, and is what a call site actually names.
 */
/**
 * The identifiers this file binds to `sink` from `pkg` -- usually just `sink`
 * itself, or its alias under `import { sink as other }`.
 *
 * Returning the LOCAL names rather than a boolean is what makes an aliased
 * import visible: the call site names the alias, so a scan for the original
 * would miss it entirely and the site would leave the inventory silently --
 * the failure mode this file exists to prevent.
 *
 * A file that defines the function itself, or imports it from a relative path,
 * binds nothing here and is correctly not treated as a package delegation.
 */
function packageBoundNames(source, sink, pkg) {
    const esc = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const names = new Set();
    const named = new RegExp(`import\\s*(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*['"]${esc}['"]`, 'g');
    const destructured = new RegExp(`(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*require\\(\\s*['"]${esc}['"]`, 'g');
    for (const re of [named, destructured]) {
        let m;
        while ((m = re.exec(source)) !== null) {
            for (const part of m[1].split(',')) {
                const [orig, alias] = part.trim().split(/\s+as\s+|:/).map((x) => (x || '').trim());
                if (orig === sink) names.add(alias || orig);
            }
        }
    }
    return names;
}

const PROXY_AGENT_BUILDERS = ['buildProxyAgent', 'createProxyTunnelAgent'];

/**
 * The raw-https counterpart of DELEGATED_FETCH_SINKS. `httpsRequest` owns the
 * real `https.request()` on this repo's behalf, so the call left this tree and
 * the NODE_HTTP_SINKS rule below can no longer see it — six sites disappeared
 * from the inventory the day the transport moved, and the gate would have gone
 * green by looking at nothing. That is the third time this repo has hit that
 * shape (#949, the ado-package move, and this one), so the site is kept in the
 * report and checked on the two things still decided HERE: that the call
 * supplies an `agent` built by a recognised proxy-agent builder, and that the
 * owning task depends on a version of the package known to carry the wiring.
 *
 * `node:https` honours no proxy setting unless handed an `agent`, so a call
 * without one is not a weaker proxy — it is no proxy at all.
 */
const DELEGATED_NODE_HTTP_SINKS = {
    httpsRequest: { pkg: '@4cloudguru/pipeline-task-core', min: '0.6.0' },
};

/** Proxy-aware by construction inside azure-pipelines-tool-lib (see header). */
const TOOL_LIB_SINKS = ['downloadTool'];

/** The package.json of the task that owns `file`, or null above the task roots. */
function declaredDependency(file, pkg) {
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

/**
 * Deliberately narrow: only a caret or exact range pins a floor this gate can
 * reason about. `*`, `latest` or a git URL cannot be shown to include the fix,
 * so they are treated as NOT satisfying it rather than waved through.
 */
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

/** The lockfile of the task that owns `file` — what `npm ci` actually installs. */
function lockfileFor(file) {
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

/**
 * Every copy of `dep` the owning task installs, top-level or nested. Read from
 * the lockfile rather than the manifests because two compatible-LOOKING ranges
 * can still resolve to two different copies, and only the lockfile shows it.
 * Returns null when there is nothing to read, which the caller fails closed on.
 */
function installedCopies(file, dep) {
    const lock = lockfileFor(file);
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

/**
 * Resolves the delegated sink's verdict: the owning task must declare the
 * delegating package at or above its floor AND, when that package delegates
 * onward, the onward dependency must resolve to exactly one copy at or above
 * its own floor.
 */
function packageDelegationVerdict(file, { pkg, min, carries }) {
    const declared = declaredDependency(file, pkg);
    if (declared === null || !satisfiesFloor(declared, min)) {
        return { ok: false, why: `delegates the proxy decision to ${pkg}, but the owning task declares ${declared ?? 'no dependency on it'} (floor ${min})` };
    }
    if (!carries) {
        return { ok: true, why: `proxy dispatch and secret registration come from ${pkg}@${declared} (floor ${min})` };
    }

    const copies = installedCopies(file, carries.pkg);
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
    return { ok: true, why: `proxy dispatch and secret registration come from ${pkg}@${declared} (floor ${min}), resolving a single ${carries.pkg}@${copies[0].version} (floor ${carries.min})` };
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
        if (entry.isDirectory()) {
            walk(full, out);
        } else if (
            (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
            !entry.name.endsWith('.d.ts') &&
            !entry.name.endsWith('.test.ts') &&
            full.includes(`${path.sep}src${path.sep}`)
        ) {
            out.push(full);
        }
    }
    return out;
}

/**
 * Returns a copy of `source` with every comment and string/template literal
 * blanked out (offsets preserved), so a sink NAME appearing in prose -- e.g. the
 * comment "Node's built-in fetch() buffers the whole body" -- is never counted as
 * a call. Argument text is still read from the ORIGINAL source.
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

/**
 * Returns the full source text of the call whose '(' is at or after `index`,
 * balanced across nested brackets, so the whole RequestInit / RequestOptions
 * object literal is available for inspection regardless of line breaks.
 */
function callText(source, index) {
    const open = source.indexOf('(', index);
    if (open < 0) return '';
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        const c = source[i];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') {
            depth--;
            if (depth === 0) return source.slice(open, i + 1);
        }
    }
    return source.slice(open);
}

/** First argument expression of the call whose '(' is at or after `index`. */
function firstArgument(source, index) {
    const open = source.indexOf('(', index);
    if (open < 0) return '';
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        const c = source[i];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') {
            depth--;
            if (depth === 0) return source.slice(open + 1, i).trim();
        } else if (c === ',' && depth === 1) return source.slice(open + 1, i).trim();
    }
    return '';
}

/**
 * The text the request options actually denote.
 *
 * `https.request(options, cb)` where `options` is a `const options:
 * https.RequestOptions = { ..., agent: buildProxyAgent(...) }` declared just
 * above IS proxied, but a check that only reads the CALL text cannot see it --
 * which is how an earlier revision of this signature reported the (correctly
 * proxied) drift-report and module-publish transports as UNPROXIED. Follows one
 * level of local `const <ident> = { ... }`, taking the nearest declaration that
 * precedes the call.
 */
function resolveOptionsText(source, callIndex, expr) {
    if (!/^[A-Za-z_$][\w$]*$/.test(expr)) return expr;
    const re = new RegExp(`(?:const|let|var)\\s+${expr}\\s*(?::[^=;]*)?=\\s*\\{`, 'g');
    let m, chosen = -1;
    while ((m = re.exec(source)) !== null) {
        if (m.index < callIndex) chosen = m.index + m[0].length - 1;
        else break;
    }
    if (chosen < 0) return expr;
    let depth = 0;
    for (let i = chosen; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) return source.slice(chosen, i + 1);
        }
    }
    return expr;
}

/**
 * Nearest enclosing FUNCTION name -- the unit that owns the decision to proxy.
 *
 * Only declarations that actually introduce a function count. An earlier
 * revision also matched any `const x =`, which made every site report the
 * variable the response was assigned to (`response() -> fetch()`) instead of the
 * method containing it, so two different call sites in one method were
 * indistinguishable.
 */
function enclosingName(source, index) {
    const head = source.slice(0, index);
    const patterns = [
        /(?:^|\n)\s*(?:export\s+)?(?:public|private|protected|static|\s)*(?:async\s+)?function\s+(\w+)\s*[<(]/g,
        // `const foo = () => {}` / `const foo = async function ...` only.
        /(?:^|\n)\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*(?::[^=;]*)?=\s*(?:async\s+)?(?:function\b|(?:<[^>]*>)?\([^)]*\)\s*(?::[^=]+)?=>|\w+\s*=>)/g,
        // Class methods and object-literal methods.
        /(?:^|\n)\s*(?:public|private|protected|static|readonly|\s)*(?:async\s+)?(\w+)\s*(?:<[^>(]*>)?\([^)]*\)\s*(?::[^{;=]+)?\{/g,
    ];
    let best = { name: '<module>', at: -1 };
    for (const re of patterns) {
        let m;
        while ((m = re.exec(head)) !== null) {
            if (m.index > best.at && !['if', 'for', 'while', 'switch', 'catch', 'return', 'function'].includes(m[1])) {
                best = { name: m[1], at: m.index };
            }
        }
    }
    return best.name;
}

/**
 * Byte range of the ProxyTunnelAgent class body, or null. The CONNECT-hop
 * exemption is scoped to calls INSIDE that class: the same file also contains
 * the REAL outbound https.request, which must still be checked for an `agent`.
 * Exempting the whole file (an earlier revision did) hid exactly the call the
 * signature exists to verify.
 */
function proxyTransportRange(source) {
    const decl = /class\s+\w*ProxyTunnelAgent\w*\s+extends\s+https\.Agent[^{]*\{/.exec(source);
    if (!decl) return null;
    const start = decl.index + decl[0].length - 1;
    let depth = 0;
    for (let i = start; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) return { start, end: i };
        }
    }
    return null;
}

const files = walk(ROOT);
if (files.length === 0) {
    console.error(`FAIL: no **/src/**/*.ts files found under ${ROOT} — the signature would pass vacuously.`);
    process.exit(1);
}

const sites = [];

for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    // Site identities must be byte-stable across platforms: path.relative yields
    // backslashes on Windows, which would make every site id differ from the
    // POSIX form the class test records.
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const masked = maskCommentsAndStrings(source);
    const lineOf = (i) => source.slice(0, i).split('\n').length;
    // A file that runs in the results-tab iframe has no task-lib and no agent
    // proxy to read; the browser performs the request under the user's own
    // proxy settings.
    const isBrowser = rel.startsWith('src/tab/');
    // The CONNECT hop that ESTABLISHES the tunnel is made from inside an
    // https.Agent subclass; proxying it would be circular. Scoped to that class
    // body only -- the rest of the file still has to supply an agent.
    const tunnelRange = proxyTransportRange(source);

    const record = (index, sink, verdict, detail) => {
        sites.push({ rel, line: lineOf(index), fn: enclosingName(source, index), sink, verdict, detail });
    };

    for (const sink of FETCH_SINKS) {
        // Bare global fetch only: skip `.fetch(`, `nodeFetch(`, and the declaration
        // of a local named fetch.
        const re = new RegExp(`(?<![.\\w$])${sink}\\s*\\(`, 'g');
        let m;
        while ((m = re.exec(masked)) !== null) {
            // Predicates read the MASKED source: an earlier revision read the raw
            // source, so the explanatory comment inside this very call ("...it adds
            // only a dispatcher: ...") satisfied the `dispatcher:` test and the site
            // stayed green after the spread was deleted. A comment is never evidence.
            const args = callText(masked, m.index + m[0].length - 1);
            if (isBrowser) { record(m.index, sink, 'EXEMPT-BROWSER', 'runs in the results-tab iframe; no task-lib, browser applies the user proxy'); continue; }
            const spreadsBuilder = PROXY_OPTION_BUILDERS.some((b) => new RegExp(`\\.\\.\\.\\s*${b}\\s*\\(`).test(args));
            const hasDispatcher = /(^|[^\w$])dispatcher\s*:/.test(args);
            record(m.index, sink, spreadsBuilder || hasDispatcher ? 'PROXIED' : 'UNPROXIED',
                spreadsBuilder ? 'spreads a proxy option builder' : hasDispatcher ? 'supplies an undici dispatcher' : 'no dispatcher and no proxy-option spread');
        }
    }

    for (const sink of DELEGATED_FETCH_SINKS) {
        const re = new RegExp(`(?<![.\\w$])${sink}\\s*\\(`, 'g');
        let m;
        while ((m = re.exec(masked)) !== null) {
            const call = callText(masked, m.index + m[0].length - 1);
            // The options are commonly assembled as `{ ...injected, ... }`, so a
            // literal read of the call text alone would miss the injection and
            // report a correctly-proxied site as UNPROXIED. Resolve one level of
            // local `const <ident> = { ... }` for every spread, the same way the
            // node:http sinks resolve a hoisted options object.
            const spreads = [...call.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)/g)].map((s) => s[1]);
            const options = call + spreads.map((id) => resolveOptionsText(masked, m.index, id)).join('');
            const injects = /(^|[^\w$])fetchOptions\s*:/.test(options) &&
                PROXY_OPTION_BUILDERS.some((b) => new RegExp(`(^|[^\\w$])${b}\\b`).test(options));
            record(m.index, sink, injects ? 'PROXIED' : 'UNPROXIED',
                injects ? 'injects fetchOptions from a proxy option builder' : 'no fetchOptions injection, so the delegated fetch cannot reach the agent proxy');
        }
    }

    for (const [sink, spec] of Object.entries(PACKAGE_DELEGATED_SINKS)) {
        // Only the names THIS file binds to that package's export. Matching the
        // sink name alone attributes any same-named function to the package,
        // which is wrong in both directions: a local `generateIdToken` gets a
        // version floor it has no relationship to, and its real sink -- the
        // fetch() inside it -- is counted a second time under the wrapper.
        //
        // That is not hypothetical. azure-pipelines-terraform DEFINES
        // generateIdToken locally in id-token-generator.ts and its callers
        // import it from './id-token-generator'; this copy reported all six call
        // sites UNPROXIED for "declares no dependency on @4cloudguru/pipeline-task-ado",
        // which is true and irrelevant, while separately -- and correctly --
        // classifying the fetch() inside that same function as PROXIED.
        // 23 sites where the local copy found 17.
        // Import specifiers are STRING LITERALS, so they are gone from `masked`.
        // Bindings must be read from the raw source; the call sites are still
        // matched against `masked` so a name inside a string or comment cannot
        // be mistaken for a call.
        for (const local of packageBoundNames(source, sink, spec.pkg)) {
            const re = new RegExp(`(?<![.\\w$])${local}\\s*\\(`, 'g');
            let m;
            while ((m = re.exec(masked)) !== null) {
                const { ok, why } = packageDelegationVerdict(file, spec);
                record(m.index, local, ok ? 'PROXIED-BY-PACKAGE' : 'UNPROXIED', why);
            }
        }
    }

    for (const [sink, spec] of Object.entries(DELEGATED_NODE_HTTP_SINKS)) {
        const re = new RegExp(`(?<![.\\w$])${sink}\\s*\\(`, 'g');
        let m;
        while ((m = re.exec(masked)) !== null) {
            const call = callText(masked, m.index + m[0].length - 1);
            const spreads = [...call.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)/g)].map((sp) => sp[1]);
            const options = call + spreads.map((id) => resolveOptionsText(masked, m.index, id)).join('');
            const hasAgent = /(^|[^\w$])agent\s*:/.test(options) &&
                PROXY_AGENT_BUILDERS.some((b) => new RegExp(`(^|[^\\w$])${b}\\b`).test(options));
            if (!hasAgent) {
                record(m.index, sink, 'UNPROXIED',
                    'no agent from a proxy-agent builder, and node:https reaches no proxy without one');
                continue;
            }
            const { ok, why } = packageDelegationVerdict(file, spec);
            record(m.index, sink, ok ? 'PROXIED-BY-PACKAGE' : 'UNPROXIED',
                ok ? `supplies a CONNECT-tunnelling agent; ${why}` : why);
        }
    }

    for (const sink of NODE_HTTP_SINKS) {
        const re = new RegExp(`(?<![\\w$])${sink.replace('.', '\\.')}\\s*\\(`, 'g');
        let m;
        while ((m = re.exec(masked)) !== null) {
            if (tunnelRange && m.index > tunnelRange.start && m.index < tunnelRange.end) {
                record(m.index, sink, 'EXEMPT-PROXY-TRANSPORT', 'this IS the CONNECT hop to the proxy, made from an https.Agent subclass');
                continue;
            }
            const callStart = m.index + m[0].length - 1;
            const options = resolveOptionsText(masked, m.index, firstArgument(masked, callStart)) + callText(masked, callStart);
            const hasAgent = /(^|[^\w$])agent\s*:/.test(options);
            record(m.index, sink, hasAgent ? 'PROXIED' : 'UNPROXIED',
                hasAgent ? 'supplies an agent (the CONNECT-tunnelling ProxyTunnelAgent)' : 'no agent supplied');
        }
    }

    for (const sink of TOOL_LIB_SINKS) {
        const re = new RegExp(`(?<![\\w$])(?:\\w+\\.)?${sink}\\s*\\(`, 'g');
        let m;
        while ((m = re.exec(masked)) !== null) {
            record(m.index, sink, 'EXEMPT-TOOL-LIB', 'azure-pipelines-tool-lib builds its HttpClient with proxy: tl.getHttpProxyConfiguration()');
        }
    }
}

// A signature that finds nothing is indistinguishable from a broken signature.
if (sites.length === 0) {
    console.error(`FAIL: no outbound HTTP call sites found under ${ROOT} — the signature would pass vacuously.`);
    process.exit(1);
}

const failures = sites.filter((s) => s.verdict === 'UNPROXIED').length;

if (JSON_OUTPUT) {
    console.log(JSON.stringify({ sites, failures }, null, 2));
    process.exit(failures ? 1 : 0);
}

const order = ['UNPROXIED', 'PROXIED', 'PROXIED-BY-PACKAGE', 'EXEMPT-TOOL-LIB', 'EXEMPT-PROXY-TRANSPORT', 'EXEMPT-BROWSER'];
for (const verdict of order) {
    const group = sites.filter((s) => s.verdict === verdict);
    if (!group.length) continue;
    console.log(`\n${verdict} (${group.length})`);
    for (const s of group) {
        console.log(`  ${s.rel}:${s.line}  ${s.fn}() -> ${s.sink}()  ${s.detail}`);
    }
}

if (failures) {
    console.error(`\nFAIL: ${failures} outbound call site(s) ignore the agent proxy configuration.`);
    console.error('      Spread buildProxyFetchOptions()/buildFetchOptions() into the RequestInit, or supply an agent.');
    process.exit(1);
}
console.log(`\nOK: all ${sites.length} outbound call site(s) honour the agent proxy configuration or carry a verified exemption.`);
