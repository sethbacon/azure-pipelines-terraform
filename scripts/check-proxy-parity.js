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
//   4. Every version floor in the tables must still be able to FIRE. A floor
//      the whole fleet has already passed is inert, and a gate whose bar sits
//      under the floor is green about nothing (sethbacon/azure-pipelines-terraform#1108,
//      finding 2 -- a bare number here would resolve in THIS repository).
//
// Where the floors come from
// --------------------------
// A floor is the highest of three terms, and each term answers a different
// question (see lib/package-delegation.js's highestFloor, which is the rule):
//
//   since           per SINK, in the table below -- the release that FIRST
//                   carried the behaviour. History; it never moves, and no
//                   repository can lower it.
//   ESTATE_FLOORS   per PACKAGE, in this file -- the RATCHET. The lowest
//                   version any repository in the estate may declare. Raised
//                   deliberately here, once every repository has passed it.
//   the data file   per PACKAGE, in the repository being analysed -- the fleet
//                   tracker, raised by the same change that bumps its packages.
//                   OPTIONAL in this phase; see REQUIRE_DATA.
//
// Because the rule is a MAX, a term can only ever RAISE the bar. That is the
// whole reason one of the three is safe to keep in a file the analysed
// repository owns: it cannot weaken a verdict the other two already reached.
//
// This gate is CANONICAL: it is resolved from this one copy and run against
// trees it does not live in, so every path it walks is derived from ROOT (argv)
// and never from __dirname. lib/package-delegation.js, which it requires from
// beside itself, carries the same discipline in each of its walks and takes
// ROOT as an explicit argument for that reason. The last time a boundary here
// followed the script instead of the tree it fabricated 19 sites across three
// repositories.
//
// Repo-agnostic: it discovers `**/src/**/*.ts(x)` under the repo root, so it runs
// unchanged in azure-pipelines-packer, azure-pipelines-terraform and
// azure-pipelines-release-docs. Usage:
//
//     node scripts/check-proxy-parity.js [repoRoot] [--json]
//
// Exit 0 = no residual instances of the class. Exit 1 = residuals, listed
// (unproxied call sites, or a floor that can no longer fire) -- or, with no
// JSON printed, the vacuity bail-out below. Exit 2 = the gate could not run: a
// data file it cannot read. Neither of the last two is ever a clean repository,
// and the replay adapter distinguishes them by whether an envelope was printed.

const fs = require('fs');
const path = require('path');
const { packageDelegationVerdict, highestFloor } = require('./lib/package-delegation.js');

// `--json` prints the machine-readable finding list (consumed by the class
// test's per-site table) instead of the human report; the exit code is identical.
const JSON_OUTPUT = process.argv.includes('--json');
const ROOT = path.resolve(process.argv.filter((a) => a !== '--json')[2] || process.cwd());

// ---------------------------------------------------------------------------
// PER-REPO DATA. This gate is the same bytes for every repository it analyses.
// The only thing a repository contributes is a NUMBER THAT MOVES WITH ITS OWN
// PACKAGE FLEET, and nothing else: no sink name, no builder name, no exemption
// path. A repository must not be able to make itself invisible to the
// recogniser by editing a file the recogniser reads -- deleting a sink from a
// per-repo table would look exactly like a repository that has no such call.
//
// Resolved against ROOT (argv), never __dirname, for the same reason the
// declaredDependency()/lockfileFor() walk boundary in lib/package-delegation.js
// is: this gate is ONE copy serving every root the replay walks, so "this
// repository's data" has to be a fact about the tree being ANALYSED and not
// about wherever this file happens to sit.
/**
 * THE RATCHET. The lowest version of each package ANY repository in the estate
 * is permitted to declare, whatever its own data file says. The per-repo data
 * file can only ever RAISE the bar (effective = max of the three), so a
 * repository cannot weaken this gate by editing a file it owns -- which is the
 * one thing that would otherwise be wrong with moving the floors out.
 *
 * It is raised HERE, deliberately, once every repository has passed a version.
 * It is not a per-PR chore: `staleFloors()` never fails on it, because a single
 * repository bumping first would then turn every other repository red. Its lag
 * is reported instead, and the replay -- the only thing that sees all three
 * repositories at once -- is what turns "every repo reports the same lag" into
 * "raise it".
 */
const ESTATE_FLOORS = {
    '@4cloudguru/pipeline-task-ado': '0.11.0',
    '@4cloudguru/pipeline-task-core': '0.9.3',
};

const DATA_REL = path.join('scripts', 'lib', 'proxy-parity.data.json');
const DATA_PATH = path.join(ROOT, DATA_REL);

/**
 * PHASE A: the per-repo data file is OPTIONAL, and this constant is `false`.
 *
 * No repository carries one yet. The gate is resolved from this single copy for
 * every root the replay walks, so the moment absent data is a failure, every
 * repository without a file is exit 2 -- a distributed migration run in the
 * wrong order. Data files land in each repo FIRST (they are inert while this is
 * off, because the enforced floor is a max and a missing term cannot lower it),
 * and only once all of them carry one does this default flip and the override
 * below get deleted.
 *
 * Absent data therefore falls back to max(since, ESTATE_FLOORS), which -- with
 * the ratchet set to today's fleet -- is exactly the strongest floor any copy of
 * this gate enforces today. Nothing is weakened by the file not existing yet.
 *
 * `PROXY_PARITY_DATA_OPTIONAL=0` selects the Phase C behaviour now. It exists so
 * the fail-closed path is a path the self-test can EXECUTE rather than a branch
 * nobody has ever run; a loader whose refusal has never fired is a refusal
 * nobody has verified.
 */
const REQUIRE_DATA = process.env.PROXY_PARITY_DATA_OPTIONAL === '0';

function loadFloors() {
    let raw;
    try {
        raw = fs.readFileSync(DATA_PATH, 'utf8');
    } catch {
        if (REQUIRE_DATA) {
            console.error(`FAIL: ${DATA_REL} is missing under ${ROOT}. This gate's version floors are a fact about THIS repository's fleet; without them the gate would run with no bar at all, which is could-not-run, not a clean repository.`);
            process.exit(2);
        }
        return null;
    }
    let json;
    try {
        json = JSON.parse(raw);
    } catch (err) {
        console.error(`FAIL: ${DATA_REL} under ${ROOT} is not parseable JSON: ${err.message}`);
        process.exit(2);
    }
    if (json.schemaVersion !== 1) {
        console.error(`FAIL: ${DATA_REL} declares schemaVersion ${JSON.stringify(json.schemaVersion)}; this gate reads 1. A schema it cannot read is could-not-run.`);
        process.exit(2);
    }
    const floors = json.floors;
    if (!floors || typeof floors !== 'object' || Array.isArray(floors)) {
        console.error(`FAIL: ${DATA_REL} under ${ROOT} carries no \`floors\` object.`);
        process.exit(2);
    }
    for (const [pkg, value] of Object.entries(floors)) {
        if (!/^\d+\.\d+\.\d+$/.test(String(value))) {
            console.error(`FAIL: ${DATA_REL} floor for ${pkg} is ${JSON.stringify(value)}; an exact x.y.z is the only form this gate can compare.`);
            process.exit(2);
        }
    }
    return floors;
}

const REPO_FLOORS = loadFloors();

/**
 * The floor actually enforced for `pkg` at a sink introduced in `since`.
 *
 * max(since, repo floor) -- never the repo value alone. `since` is the release
 * that FIRST carried the behaviour and is a fact about the package, so it lives
 * in this file and a repository cannot lower it. The repo floor is the fleet
 * tracker and can only ever raise the bar. A data file is therefore incapable
 * of weakening a verdict below what the package's own history allows, and any
 * attempt to lower it under the fleet is what staleFloors() fails on.
 */
function effectiveFloor(pkg, since) {
    return highestFloor(since, ESTATE_FLOORS[pkg], REPO_FLOORS ? REPO_FLOORS[pkg] : null);
}

/** Which of the three sources the enforced floor came from -- for the report. */
function floorSource(pkg, since) {
    const eff = effectiveFloor(pkg, since);
    if (REPO_FLOORS && REPO_FLOORS[pkg] === eff) return `${DATA_REL}`;
    if (ESTATE_FLOORS[pkg] === eff) return 'ESTATE_FLOORS';
    return 'since';
}

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
/**
 * Each floor below started as the release that first carried the behaviour. It
 * is now kept level with what the estate actually declares: a floor the whole
 * fleet has passed cannot fire, and a gate that cannot fire is green about
 * nothing (#1108 finding 2). `staleFloors()` fails this gate with the value to
 * raise a floor to, so a fleet-wide package bump raises it in the same change
 * instead of leaving the bar behind.
 */
const PACKAGE_DELEGATED_SINKS = {
    createAdoHttpClient: {
        capability: 'the proxy decision',
        provides: 'proxy dispatch and secret registration',
        pkg: '@4cloudguru/pipeline-task-ado',
        // First carried in ado 0.3.0. `since` is history and never moves; the
        // bar actually enforced is max(since, the repo's fleet floor).
        since: '0.3.0',
        // The package delegates onward to core, so the direct floor above only
        // vouches for the wiring - not for which implementation it wires up.
        // ado@0.2.0 declared core ^0.3.1 while the tasks declared ^0.5.0, and
        // caret on a 0.x version is patch-only, so the ranges were disjoint,
        // npm nested a second copy, and the delegated client ran the older one.
        // Both floors passed throughout. Hence the resolved check below.
        // First carried in core 0.5.0.
        carries: { pkg: '@4cloudguru/pipeline-task-core', since: '0.5.0' },
    },
    // generateIdToken (#46 extraction): the OIDC token exchange's fetch(), and
    // the proxy decision that wraps it (buildAdoFetchOptions), both moved into
    // @4cloudguru/pipeline-task-ado -- there is no local fetchOptions to
    // inspect here either. Same onward-delegation shape as createAdoHttpClient
    // above: the package's own buildAdoFetchOptions calls resolveProxy from
    // pipeline-task-core, so a stale nested copy of THAT package would run old
    // proxy logic even with a fresh ado floor.
    generateIdToken: {
        capability: 'the proxy decision',
        provides: 'proxy dispatch and secret registration',
        pkg: '@4cloudguru/pipeline-task-ado',
        // First carried in ado 0.5.0 / core 0.6.0.
        since: '0.5.0',
        carries: { pkg: '@4cloudguru/pipeline-task-core', since: '0.6.0' },
    },
    // exchangeOidcForUpst (sethbacon/azure-pipelines-terraform#1074): the OCI WIF
    // flow's SECOND hop. This one was
    // extracted in the other direction from the rest of this table -- it was
    // defined here and moved out, because azure-pipelines-packer needed the
    // same realm allowlist and redirect policy and a copy would have drifted
    // invisibly (check-shared-modules.js verifies a provenance header, it
    // cannot byte-compare across repos). Same onward-delegation shape as the
    // two above, since its fetch options come from the package's own
    // buildAdoFetchOptions.
    exchangeOidcForUpst: {
        capability: 'the proxy decision',
        provides: 'proxy dispatch and secret registration',
        pkg: '@4cloudguru/pipeline-task-ado',
        // First exported in ado 0.8.0 / core 0.6.0.
        since: '0.8.0',
        carries: { pkg: '@4cloudguru/pipeline-task-core', since: '0.6.0' },
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
    // First carried in core 0.6.0.
    httpsRequest: {
        capability: 'the proxy decision',
        provides: 'proxy dispatch and secret registration',
        pkg: '@4cloudguru/pipeline-task-core',
        since: '0.6.0',
    },
};

/**
 * Every version floor this file enforces, as (package, floor, where it is
 * written). Kept derivable rather than hand-listed so a floor added to a table
 * above cannot escape the currency check below by being forgotten here.
 */
function declaredFloors() {
    const out = [];
    for (const [sink, entry] of Object.entries(PACKAGE_DELEGATED_SINKS)) {
        out.push({ where: `PACKAGE_DELEGATED_SINKS.${sink}`, pkg: entry.pkg, min: effectiveFloor(entry.pkg, entry.since), since: entry.since, data: DATA_REL });
        if (entry.carries) out.push({ where: `PACKAGE_DELEGATED_SINKS.${sink}.carries`, pkg: entry.carries.pkg, min: effectiveFloor(entry.carries.pkg, entry.carries.since), since: entry.carries.since, data: DATA_REL });
    }
    for (const [sink, entry] of Object.entries(DELEGATED_NODE_HTTP_SINKS)) {
        out.push({ where: `DELEGATED_NODE_HTTP_SINKS.${sink}`, pkg: entry.pkg, min: effectiveFloor(entry.pkg, entry.since), since: entry.since, data: DATA_REL });
    }
    return out;
}

/** A table entry as packageDelegationVerdict() wants it: floors resolved. */
function resolvedSpec(entry) {
    return {
        ...entry,
        min: effectiveFloor(entry.pkg, entry.since),
        carries: entry.carries ? { ...entry.carries, min: effectiveFloor(entry.carries.pkg, entry.carries.since) } : undefined,
    };
}

/** Every task manifest under ROOT/Tasks, however deep. */
function taskManifests() {
    const found = [];
    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name === 'package.json') found.push(full);
        }
    };
    walk(path.join(ROOT, 'Tasks'));
    return found;
}

/** The floor a caret/exact range pins, as [major, minor, patch], or null. */
function rangeFloor(range) {
    const parsed = /^\^?(\d+)\.(\d+)\.(\d+)/.exec(String(range).trim());
    return parsed ? parsed.slice(1).map(Number) : null;
}

const compareVersions = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * The lowest version of `pkg` any task in this repository actually declares,
 * or null when no task depends on it.
 */
function fleetFloor(pkg) {
    let lowest = null;
    for (const manifest of taskManifests()) {
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

/**
 * A floor BELOW what every task already declares is inert: it cannot fire, and
 * a gate that cannot fire is green about nothing -- the same failure mode
 * check-shared-modules.js's own self-test exists to prevent for its FAMILIES
 * list (#1108 finding 2). The floors above are historical by design (each names
 * the release that first carried the behaviour, which is why the comment beside
 * it is worth reading), so this does not rewrite them: it fails the gate with
 * the value to raise them to, which makes raising them part of the fleet bump
 * that moved past them rather than something to notice later.
 */
function staleFloors() {
    const stale = [];
    for (const floor of declaredFloors()) {
        const fleet = fleetFloor(floor.pkg);
        if (!fleet) continue;
        const declared = rangeFloor(floor.min);
        if (declared && compareVersions(declared, fleet) < 0) {
            stale.push({ ...floor, fleet: fleet.join('.'), source: floorSource(floor.pkg, floor.since) });
        }
    }
    return stale;
}

/**
 * Packages whose ESTATE floor is below what THIS repository already declares.
 *
 * Never a failure. Raising the ratchet needs every repository to have passed
 * the version, and this gate only ever sees one; failing here would make the
 * first repository to bump turn the other two red -- the estate has been bitten
 * by exactly that shape before. It is emitted so the replay, which runs this
 * gate against all three roots in one pass, can say "all of them report the
 * same lag, so the ratchet is safe to raise".
 */
function estateFloorLag() {
    const lag = [];
    for (const [pkg, min] of Object.entries(ESTATE_FLOORS)) {
        const fleet = fleetFloor(pkg);
        if (!fleet) continue;
        const declared = rangeFloor(min);
        if (declared && compareVersions(declared, fleet) < 0) {
            lag.push({ pkg, estate: min, fleet: fleet.join('.') });
        }
    }
    return lag;
}

/** Proxy-aware by construction inside azure-pipelines-tool-lib (see header). */
const TOOL_LIB_SINKS = ['downloadTool'];

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
                const { ok, why } = packageDelegationVerdict(file, resolvedSpec(spec), ROOT);
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
            const { ok, why } = packageDelegationVerdict(file, resolvedSpec(spec), ROOT);
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
const stale = staleFloors();
const estateLag = estateFloorLag();

if (JSON_OUTPUT) {
    console.log(JSON.stringify({ sites, failures, staleFloors: stale, estateFloorLag: estateLag }, null, 2));
    process.exit(failures || stale.length ? 1 : 0);
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

if (stale.length) {
    console.error(`\nSTALE FLOORS (${stale.length})`);
    for (const f of stale) {
        // `src=` is the whole point of the three-source rule being reported: the
        // operator has to know WHICH of the three to raise, and only one of them
        // is a file this repository owns.
        console.error(`  ${f.where}: floor ${f.min} for ${f.pkg} (src=${f.source}), but every task already declares >= ${f.fleet} -- the floor cannot fire.`);
    }
}

// Never a failure -- see estateFloorLag(). Printed after the stale block so the
// two are not confused: the block above is this repository's to fix, this one
// waits on every other repository reporting the same line.
if (estateLag.length) {
    console.log(`\nESTATE RATCHET LAG (${estateLag.length}) -- reported, not failed`);
    for (const l of estateLag) {
        console.log(`  ${l.pkg}: ESTATE_FLOORS pins ${l.estate}, this repo's fleet is at ${l.fleet}. Raise it upstream once EVERY ado-extension reports this line.`);
    }
}

if (failures) {
    console.error(`\nFAIL: ${failures} outbound call site(s) ignore the agent proxy configuration.`);
    console.error('      Spread buildProxyFetchOptions()/buildFetchOptions() into the RequestInit, or supply an agent.');
}
if (stale.length) {
    console.error(`\nFAIL: ${stale.length} version floor(s) have fallen behind the fleet and can no longer fire.`);
    console.error('      Raise each to the version shown, keeping the comment that says which release first carried the behaviour.');
}
if (failures || stale.length) process.exit(1);
console.log(`\nOK: all ${sites.length} outbound call site(s) honour the agent proxy configuration or carry a verified exemption, and every version floor still tracks the fleet.`);
