#!/usr/bin/env node
'use strict';
// Self-test for check-proxy-parity.js.
//
// This gate had none, and it has been wrong twice: once reporting "no outbound
// HTTP call sites found" for a task that demonstrably makes them, and once
// attributing a LOCALLY DEFINED function to a package because the two share a
// name. Both failures are the same shape -- the inventory silently changes size
// and the verdict follows it -- which is precisely what a gate over "did we miss
// a call site" must never do.
//
// Every case builds a fixture repository, runs the real script over it as a
// SUBPROCESS, and asserts on the --json verdict. The script is copied INTO the
// fixture on purpose: declaredDependency() and installedCopies() walk up from
// each file and stop at `path.resolve(__dirname, '..')`, so a script run from
// outside the tree it is analysing never finds the task's package.json and
// reports "declares no dependency" for everything. Running it out-of-tree
// produces a plausible-looking report that is entirely an artefact of where the
// file sits.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'check-proxy-parity.js');
const PKG = '@4cloudguru/pipeline-task-ado';
const CORE = '@4cloudguru/pipeline-task-core';

let failures = 0;
const report = (ok, msg) => {
    if (ok) console.log(`  OK   ${msg}`);
    else { console.error(`  FAIL ${msg}`); failures += 1; }
};

function fixture(name, { deps = {}, coreVersion = '0.7.0', sources = {} }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `proxy-parity-${name}-`));
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'check-proxy-parity.js'));
    const libSrc = path.join(__dirname, 'lib');
    if (fs.existsSync(libSrc)) fs.cpSync(libSrc, path.join(root, 'scripts', 'lib'), { recursive: true });

    const taskDir = path.join(root, 'Tasks', 'Fixture', 'FixtureV1');
    fs.mkdirSync(path.join(taskDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'package.json'),
        JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: deps }, null, 2));
    fs.writeFileSync(path.join(taskDir, 'package-lock.json'), JSON.stringify({
        name: 'fixture', lockfileVersion: 3,
        packages: { '': { name: 'fixture' }, [`node_modules/${CORE}`]: { version: coreVersion } },
    }, null, 2));
    for (const [file, body] of Object.entries(sources)) {
        fs.writeFileSync(path.join(taskDir, 'src', file), body);
    }
    return root;
}

function run(root) {
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-proxy-parity.js'), '--json', root],
        { encoding: 'utf8', cwd: root });
    try { return JSON.parse(r.stdout); } catch { return { sites: [], failures: -1, raw: r.stdout + r.stderr }; }
}

const CALLER = (importLine, callName) => `${importLine}
export async function handle(): Promise<void> {
    await ${callName}('svc');
}
`;

// ── 1. imported from the package: floor applies, verdict is PROXIED-BY-PACKAGE
{
    const root = fixture('imported', {
        deps: { [PKG]: '^0.5.1', [CORE]: '^0.7.0' },
        sources: { 'handler.ts': CALLER(`import { generateIdToken } from '${PKG}';`, 'generateIdToken') },
    });
    const out = run(root);
    const sites = out.sites.filter((s) => s.sink === 'generateIdToken');
    report(sites.length === 1 && sites[0].verdict === 'PROXIED-BY-PACKAGE',
        `imported from the package -> PROXIED-BY-PACKAGE (got ${JSON.stringify(sites.map((s) => s.verdict))})`);
}

// ── 2. defined locally: NOT a package delegation at all
{
    const root = fixture('local', {
        deps: { [CORE]: '^0.6.0' },
        sources: {
            // Mirrors the real shape: the local generateIdToken WRAPS a proxied
            // fetch. That inner call is the actual sink and must be the one
            // counted -- counting the wrapper too is the double-count this fix
            // removes. It also keeps the fixture non-vacuous, which the script
            // rightly refuses to analyse.
            'id-token-generator.ts': `import { buildProxyFetchOptions } from './proxy-config';
export async function generateIdToken(id: string): Promise<string> {
    const res = await fetch('https://example.invalid/token', { ...buildProxyFetchOptions(), method: 'POST' });
    return String(res.status) + id;
}
`,
            'proxy-config.ts': `export function buildProxyFetchOptions(): Record<string, unknown> { return {}; }\n`,
            'handler.ts': CALLER(`import { generateIdToken } from './id-token-generator';`, 'generateIdToken'),
        },
    });
    const out = run(root);
    const sites = out.sites.filter((s) => s.sink === 'generateIdToken');
    report(sites.length === 0,
        `defined locally -> not attributed to ${PKG} (got ${sites.length} site(s): ${JSON.stringify(sites.map((s) => s.verdict))})`);
    report(out.failures === 0, `defined locally -> no failure (got ${out.failures})`);
    const inner = out.sites.filter((s) => s.sink === 'fetch');
    report(inner.length === 1 && inner[0].verdict === 'PROXIED',
        `the wrapped fetch is counted once, as the real sink (got ${JSON.stringify(inner.map((s) => s.verdict))})`);
}

// ── 5. a tree with no outbound call at all must NOT pass: an empty inventory is
//      how this gate failed before, and the guard against it is worth pinning.
{
    const root = fixture('vacuous', {
        deps: { [CORE]: '^0.6.0' },
        sources: { 'noop.ts': `export function noop(): void {}\n` },
    });
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-proxy-parity.js'), '--json', root],
        { encoding: 'utf8', cwd: root });
    report(r.status !== 0 && /pass vacuously/.test(r.stderr),
        `no call sites at all -> refuses to pass vacuously (exit ${r.status})`);
}

// ── 3. aliased import: the call names the alias, and it must still be seen
{
    const root = fixture('aliased', {
        deps: { [PKG]: '^0.5.1', [CORE]: '^0.7.0' },
        sources: { 'handler.ts': CALLER(`import { generateIdToken as mintToken } from '${PKG}';`, 'mintToken') },
    });
    const out = run(root);
    const sites = out.sites.filter((s) => s.sink === 'mintToken');
    report(sites.length === 1 && sites[0].verdict === 'PROXIED-BY-PACKAGE',
        `aliased import -> still enumerated (got ${sites.length} site(s): ${JSON.stringify(sites.map((s) => s.verdict))})`);
}

// ── 4. imported from the package but below the floor: the floor still bites
{
    const root = fixture('stale', {
        deps: { [PKG]: '^0.4.0', [CORE]: '^0.7.0' },
        sources: { 'handler.ts': CALLER(`import { generateIdToken } from '${PKG}';`, 'generateIdToken') },
    });
    const out = run(root);
    const sites = out.sites.filter((s) => s.sink === 'generateIdToken');
    report(sites.length === 1 && sites[0].verdict === 'UNPROXIED',
        `below the version floor -> UNPROXIED (got ${JSON.stringify(sites.map((s) => s.verdict))})`);
}

if (failures > 0) {
    console.error(`\ncheck-proxy-parity.js self-test: ${failures} case(s) failed.`);
    process.exit(1);
}
console.log('\ncheck-proxy-parity.js self-test: all cases passed.');
