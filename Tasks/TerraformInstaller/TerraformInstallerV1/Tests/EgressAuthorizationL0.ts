import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { assertEgressHostAllowed, EgressHostMessages } from '../src/registry-allowlist';
import { validateUrlPathSegment } from '../src/url-path-segment';
import { downloadToFile } from '../src/http-client';

/**
 * CLASS TEST — egress authorization (#161 / #188 / #191 / #200 / #201).
 *
 * Defect class: an egress destination is authorized by inspecting its TEXTUAL
 * form rather than its RESOLVED address, and the authorization is not re-applied
 * to every hop or at connect time.
 *
 * Three tables, each covering the class rather than one call site:
 *   A. HOST_ROWS      — the authorization decision itself, over every spelling
 *                       that a dotted-quad blocklist walks past.
 *   B. REDIRECT_ROWS  — the SAME decision re-applied on a redirect hop, driven
 *                       through the real downloadToFile + a stubbed fetch.
 *   C. SITE_ROWS      — every enumerated egress site in this repo, verdicted by
 *                       the re-runnable signature (scripts/check-egress-authorization.js).
 *
 * Every row is mutation-provable: inverting the guard it exercises turns that
 * row RED (see the file-level note on each table).
 */

const MESSAGES: EgressHostMessages = {
    notAllowed: (hostname, allowedHosts) => `NOT_ALLOWED:${hostname}:${allowedHosts}`,
    isPrivate: (hostname) => `IS_PRIVATE:${hostname}`,
};

/** A DNS stub so no row touches the network. */
function lookupReturning(...addresses: string[]) {
    return async () => addresses.map(address => ({ address }));
}

type HostRow = {
    what: string;
    host: string;
    allowedHosts?: string[];
    resolvesTo?: string[];
    /** undefined = must be allowed; otherwise the expected message prefix. */
    reject?: 'IS_PRIVATE' | 'NOT_ALLOWED';
};

/**
 * Table A. Rows marked `reject: 'IS_PRIVATE'` go RED if the numeric range check
 * in registry-allowlist.ts is inverted or a range is dropped; rows marked
 * `NOT_ALLOWED` go RED if the allowlist branch is inverted; `undefined` rows go
 * RED if the guard over-blocks (which is how an over-eager fix would break a
 * legitimate public mirror).
 */
const HOST_ROWS: HostRow[] = [
    // --- the four concrete bypasses of the previous TEXTUAL blocklist ---
    { what: 'short-form IPv4 loopback (127.1)', host: '127.1', reject: 'IS_PRIVATE' },
    { what: 'decimal IPv4 loopback (2130706433)', host: '2130706433', reject: 'IS_PRIVATE' },
    { what: 'decimal IPv4 metadata (2852039166 = 169.254.169.254)', host: '2852039166', reject: 'IS_PRIVATE' },
    { what: 'hex IPv4 loopback (0x7f000001)', host: '0x7f000001', reject: 'IS_PRIVATE' },
    { what: 'octal IPv4 loopback (017700000001)', host: '017700000001', reject: 'IS_PRIVATE' },
    { what: 'IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)', host: '::ffff:127.0.0.1', reject: 'IS_PRIVATE' },
    { what: 'IPv4-mapped IPv6 metadata, URL-normalized form', host: '[::ffff:a9fe:a9fe]', reject: 'IS_PRIVATE' },
    { what: 'CGNAT RFC6598 (100.64.0.0/10)', host: '100.64.1.1', reject: 'IS_PRIVATE' },
    { what: 'CGNAT upper bound (100.127.255.254)', host: '100.127.255.254', reject: 'IS_PRIVATE' },

    // --- the ranges the textual blocklist did cover, still covered ---
    { what: 'cloud metadata service', host: '169.254.169.254', reject: 'IS_PRIVATE' },
    { what: 'loopback dotted-quad', host: '127.0.0.1', reject: 'IS_PRIVATE' },
    { what: 'localhost alias', host: 'localhost', reject: 'IS_PRIVATE' },
    { what: 'RFC1918 10/8', host: '10.1.2.3', reject: 'IS_PRIVATE' },
    { what: 'RFC1918 172.16/12 with an explicit port', host: '172.16.0.1:8443', reject: 'IS_PRIVATE' },
    { what: 'RFC1918 192.168/16', host: '192.168.1.1', reject: 'IS_PRIVATE' },
    { what: 'IPv6 loopback', host: '[::1]', reject: 'IS_PRIVATE' },
    { what: 'IPv6 link-local', host: 'fe80::1', reject: 'IS_PRIVATE' },
    { what: 'IPv6 unique-local', host: 'fd00::1', reject: 'IS_PRIVATE' },
    { what: 'RFC2544 benchmarking range', host: '198.18.0.1', reject: 'IS_PRIVATE' },
    { what: '"this network" 0/8', host: '0.0.0.0', reject: 'IS_PRIVATE' },

    // --- DNS-resolution arm: the host looks public, the address is not ---
    { what: 'public-looking name resolving to metadata', host: 'mirror.example.com', resolvesTo: ['169.254.169.254'], reject: 'IS_PRIVATE' },
    { what: 'public-looking name whose SECOND address is private', host: 'mirror.example.com', resolvesTo: ['93.184.216.34', '10.0.0.5'], reject: 'IS_PRIVATE' },

    // --- must still be allowed (over-blocking is a regression too) ---
    { what: 'ordinary public address', host: '93.184.216.34', resolvesTo: ['93.184.216.34'] },
    { what: 'public name resolving publicly', host: 'artifacts.example.com', resolvesTo: ['93.184.216.34'] },
    { what: 'IPv4-mapped IPv6 of a PUBLIC address', host: '[::ffff:8.8.8.8]' },
    { what: 'just outside CGNAT (100.128.0.1)', host: '100.128.0.1', resolvesTo: ['100.128.0.1'] },
    { what: 'just outside RFC1918 172.32/12', host: '172.32.0.1', resolvesTo: ['172.32.0.1'] },

    // --- allowlist arm: an explicit pin overrides the default deny both ways ---
    { what: 'operator pins a deliberately-private air-gapped mirror', host: '10.0.0.5', allowedHosts: ['10.0.0.5'] },
    { what: 'operator pins a private host by name', host: 'internal.mirror.local', allowedHosts: ['internal.mirror.local'] },
    { what: 'wildcard pin matches a subdomain', host: 'cdn.trusted.example', allowedHosts: ['*.trusted.example'] },
    { what: 'host outside the pin is refused even though it is public', host: 'evil.example.com', allowedHosts: ['*.trusted.example'], reject: 'NOT_ALLOWED' },
    { what: 'metadata address outside the pin is refused', host: '169.254.169.254', allowedHosts: ['mirror.example.com'], reject: 'NOT_ALLOWED' },
];

type RedirectRow = { what: string; hop: string; resolvesTo?: string[]; rejected: boolean };

/**
 * Table B. Each row 302s the REAL downloadToFile onto `hop` and asserts the
 * per-hop authorization verdict. These rows go RED if downloadToFile stops
 * awaiting its callback (the packer defect: an async rejection could not stop
 * the download), if the hop callback is dropped, or if the numeric/DNS check is
 * inverted. `rejected: false` rows prove the guard is not simply refusing every
 * redirect.
 */
const REDIRECT_ROWS: RedirectRow[] = [
    { what: 'redirect to the cloud metadata address', hop: '169.254.169.254', rejected: true },
    { what: 'redirect to short-form loopback', hop: '127.1', rejected: true },
    { what: 'redirect to decimal-encoded loopback', hop: '2130706433', rejected: true },
    { what: 'redirect to IPv4-mapped IPv6 loopback', hop: '[::ffff:127.0.0.1]', rejected: true },
    { what: 'redirect into CGNAT space', hop: '100.64.1.1', rejected: true },
    { what: 'redirect to an RFC1918 host on a non-default port', hop: '10.0.0.5:8443', rejected: true },
    { what: 'redirect to a name that RESOLVES to metadata (per-hop DNS)', hop: 'evil.example.com', resolvesTo: ['169.254.169.254'], rejected: true },
    { what: 'redirect to a genuinely public host is followed', hop: 'cdn.example.com', resolvesTo: ['93.184.216.34'], rejected: false },
];

/** Table C. Every egress site the signature enumerates in THIS repo. */
type SiteRow = { file: string; fn: string; sink: string; verdict: string; why: string };
const SITE_ROWS: SiteRow[] = [
    {
        file: "Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/policy-agent-installer.ts",
        fn: "resolveLatestSentinel", sink: "fetchJson", verdict: "EXEMPT-CONSTANT-HOST",
        why: "compile-time constant host (releases.hashicorp.com / github.com / api.github.com / checkpoint-api.hashicorp.com) \u2014 nothing at run time can influence it",
    },
    {
        file: "Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/policy-agent-installer.ts",
        fn: "resolveLatestOpa", sink: "fetchJson", verdict: "EXEMPT-CONSTANT-HOST",
        why: "compile-time constant host (releases.hashicorp.com / github.com / api.github.com / checkpoint-api.hashicorp.com) \u2014 nothing at run time can influence it",
    },
    {
        file: "Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/policy-agent-installer.ts",
        fn: "downloadSentinelOfficial", sink: "downloadTo", verdict: "EXEMPT-CONSTANT-HOST",
        why: "compile-time constant host (releases.hashicorp.com / github.com / api.github.com / checkpoint-api.hashicorp.com) \u2014 nothing at run time can influence it",
    },
    {
        file: "Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/policy-agent-installer.ts",
        fn: "downloadSentinelOfficial", sink: "fetchText", verdict: "EXEMPT-CONSTANT-HOST",
        why: "compile-time constant host (releases.hashicorp.com / github.com / api.github.com / checkpoint-api.hashicorp.com) \u2014 nothing at run time can influence it",
    },
    {
        file: "Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/policy-agent-installer.ts",
        fn: "downloadOpaOfficial", sink: "downloadTo", verdict: "EXEMPT-CONSTANT-HOST",
        why: "compile-time constant host (releases.hashicorp.com / github.com / api.github.com / checkpoint-api.hashicorp.com) \u2014 nothing at run time can influence it",
    },
    {
        file: "Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/policy-agent-installer.ts",
        fn: "downloadOpaOfficial", sink: "fetchTextAllow404", verdict: "EXEMPT-CONSTANT-HOST",
        why: "compile-time constant host (releases.hashicorp.com / github.com / api.github.com / checkpoint-api.hashicorp.com) \u2014 nothing at run time can influence it",
    },
    {
        file: "Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/policy-agent-installer.ts",
        fn: "downloadFromRegistry", sink: "fetchJson", verdict: "AUTHORIZED",
        why: "dynamic destination: the host is authorized through assertEgressHostAllowed on the initial URL and on every redirect hop (#161/#679/#729/#769/#799)",
    },
    {
        file: "Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/policy-agent-installer.ts",
        fn: "downloadFromRegistry", sink: "downloadToFile", verdict: "AUTHORIZED",
        why: "dynamic destination: the host is authorized through assertEgressHostAllowed on the initial URL and on every redirect hop (#161/#679/#729/#769/#799)",
    },
    {
        file: "Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/policy-agent-installer.ts",
        fn: "downloadFromMirror", sink: "downloadFromMirrorUrl", verdict: "AUTHORIZED",
        why: "dynamic destination: the host is authorized through assertEgressHostAllowed on the initial URL and on every redirect hop (#161/#679/#729/#769/#799)",
    },
    {
        file: "Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/policy-agent-installer.ts",
        fn: "downloadFromMirror", sink: "verifyMirrorChecksum", verdict: "EXEMPT-OPERATOR-DECLARED",
        why: "destination is the registryUrl/mirrorBaseUrl the pipeline author typed; HTTPS-pinned, and fetchWithTimeout refuses any off-host redirect, so no third party chooses this host",
    },
    {
        file: "Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/policy-agent-installer.ts",
        fn: "downloadFromMirror", sink: "downloadFromMirrorUrl", verdict: "AUTHORIZED",
        why: "dynamic destination: the host is authorized through assertEgressHostAllowed on the initial URL and on every redirect hop (#161/#679/#729/#769/#799)",
    },
    {
        file: "Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/policy-agent-installer.ts",
        fn: "downloadFromMirror", sink: "fetchTextAllow404", verdict: "EXEMPT-OPERATOR-DECLARED",
        why: "destination is the registryUrl/mirrorBaseUrl the pipeline author typed; HTTPS-pinned, and fetchWithTimeout refuses any off-host redirect, so no third party chooses this host",
    },
    {
        file: "Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/registry-version-resolver.ts",
        fn: "resolveVersionFromRegistry", sink: "fetchJson", verdict: "EXEMPT-OPERATOR-DECLARED",
        why: "destination is the registryUrl/mirrorBaseUrl the pipeline author typed; HTTPS-pinned, and fetchWithTimeout refuses any off-host redirect, so no third party chooses this host",
    },
    {
        file: "Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src/registry-version-resolver.ts",
        fn: "resolveVersionFromRegistry", sink: "fetchJson", verdict: "EXEMPT-OPERATOR-DECLARED",
        why: "destination is the registryUrl/mirrorBaseUrl the pipeline author typed; HTTPS-pinned, and fetchWithTimeout refuses any off-host redirect, so no third party chooses this host",
    },
    {
        file: "Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src/terraform-docs-installer.ts",
        fn: "resolveLatestFromGitHub", sink: "fetchJson", verdict: "EXEMPT-CONSTANT-HOST",
        why: "compile-time constant host (releases.hashicorp.com / github.com / api.github.com / checkpoint-api.hashicorp.com) \u2014 nothing at run time can influence it",
    },
    {
        file: "Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src/terraform-docs-installer.ts",
        fn: "downloadOfficial", sink: "downloadTo", verdict: "EXEMPT-CONSTANT-HOST",
        why: "compile-time constant host (releases.hashicorp.com / github.com / api.github.com / checkpoint-api.hashicorp.com) \u2014 nothing at run time can influence it",
    },
    {
        file: "Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src/terraform-docs-installer.ts",
        fn: "downloadOfficial", sink: "verifyChecksumOrSkip", verdict: "EXEMPT-CONSTANT-HOST",
        why: "compile-time constant host (releases.hashicorp.com / github.com / api.github.com / checkpoint-api.hashicorp.com) \u2014 nothing at run time can influence it",
    },
    {
        file: "Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src/terraform-docs-installer.ts",
        fn: "downloadFromRegistry", sink: "fetchJson", verdict: "AUTHORIZED",
        why: "dynamic destination: the host is authorized through assertEgressHostAllowed on the initial URL and on every redirect hop (#161/#679/#729/#769/#799)",
    },
    {
        file: "Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src/terraform-docs-installer.ts",
        fn: "downloadFromRegistry", sink: "downloadToFile", verdict: "AUTHORIZED",
        why: "dynamic destination: the host is authorized through assertEgressHostAllowed on the initial URL and on every redirect hop (#161/#679/#729/#769/#799)",
    },
    {
        file: "Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src/terraform-docs-installer.ts",
        fn: "downloadFromMirror", sink: "downloadFromMirrorUrl", verdict: "AUTHORIZED",
        why: "dynamic destination: the host is authorized through assertEgressHostAllowed on the initial URL and on every redirect hop (#161/#679/#729/#769/#799)",
    },
    {
        file: "Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src/terraform-docs-installer.ts",
        fn: "downloadFromMirror", sink: "verifyChecksumOrSkip", verdict: "EXEMPT-OPERATOR-DECLARED",
        why: "destination is the registryUrl/mirrorBaseUrl the pipeline author typed; HTTPS-pinned, and fetchWithTimeout refuses any off-host redirect, so no third party chooses this host",
    },
    {
        file: "Tasks/TerraformInstaller/TerraformInstallerV1/src/registry-version-resolver.ts",
        fn: "resolveVersionFromRegistry", sink: "fetchJson", verdict: "EXEMPT-OPERATOR-DECLARED",
        why: "destination is the registryUrl/mirrorBaseUrl the pipeline author typed; HTTPS-pinned, and fetchWithTimeout refuses any off-host redirect, so no third party chooses this host",
    },
    {
        file: "Tasks/TerraformInstaller/TerraformInstallerV1/src/terraform-installer.ts",
        fn: "resolveVersionFromHashiCorp", sink: "fetchJson", verdict: "EXEMPT-CONSTANT-HOST",
        why: "compile-time constant host (releases.hashicorp.com / github.com / api.github.com / checkpoint-api.hashicorp.com) \u2014 nothing at run time can influence it",
    },
    {
        file: "Tasks/TerraformInstaller/TerraformInstallerV1/src/terraform-installer.ts",
        fn: "downloadZipFromHashiCorp", sink: "downloadTool", verdict: "EXEMPT-CONSTANT-HOST",
        why: "compile-time constant host (releases.hashicorp.com / github.com / api.github.com / checkpoint-api.hashicorp.com) \u2014 nothing at run time can influence it",
    },
    {
        file: "Tasks/TerraformInstaller/TerraformInstallerV1/src/terraform-installer.ts",
        fn: "downloadZipFromHashiCorp", sink: "fetchText", verdict: "EXEMPT-CONSTANT-HOST",
        why: "compile-time constant host (releases.hashicorp.com / github.com / api.github.com / checkpoint-api.hashicorp.com) \u2014 nothing at run time can influence it",
    },
    {
        file: "Tasks/TerraformInstaller/TerraformInstallerV1/src/terraform-installer.ts",
        fn: "downloadZipFromRegistry", sink: "fetchJson", verdict: "AUTHORIZED",
        why: "dynamic destination: the host is authorized through assertEgressHostAllowed on the initial URL and on every redirect hop (#161/#679/#729/#769/#799)",
    },
    {
        file: "Tasks/TerraformInstaller/TerraformInstallerV1/src/terraform-installer.ts",
        fn: "downloadZipFromRegistry", sink: "downloadToFile", verdict: "AUTHORIZED",
        why: "dynamic destination: the host is authorized through assertEgressHostAllowed on the initial URL and on every redirect hop (#161/#679/#729/#769/#799)",
    },
    {
        file: "Tasks/TerraformInstaller/TerraformInstallerV1/src/terraform-installer.ts",
        fn: "downloadZipFromMirror", sink: "downloadToFile", verdict: "AUTHORIZED",
        why: "dynamic destination: the host is authorized through assertEgressHostAllowed on the initial URL and on every redirect hop (#161/#679/#729/#769/#799)",
    },
    {
        file: "Tasks/TerraformInstaller/TerraformInstallerV1/src/terraform-installer.ts",
        fn: "downloadZipFromMirror", sink: "fetchTextAllow404", verdict: "AUTHORIZED",
        why: "dynamic destination: the host is authorized through assertEgressHostAllowed on the initial URL and on every redirect hop (#161/#679/#729/#769/#799)",
    },
    {
        file: "Tasks/TerraformInstaller/TerraformInstallerV1/src/terraform-installer.ts",
        fn: "resolveVersionFromOpenTofu", sink: "fetchJson", verdict: "EXEMPT-CONSTANT-HOST",
        why: "compile-time constant host (releases.hashicorp.com / github.com / api.github.com / checkpoint-api.hashicorp.com) \u2014 nothing at run time can influence it",
    },
    {
        file: "Tasks/TerraformInstaller/TerraformInstallerV1/src/terraform-installer.ts",
        fn: "downloadZipFromOpenTofu", sink: "downloadTool", verdict: "EXEMPT-CONSTANT-HOST",
        why: "compile-time constant host (releases.hashicorp.com / github.com / api.github.com / checkpoint-api.hashicorp.com) \u2014 nothing at run time can influence it",
    },
    {
        file: "Tasks/TerraformInstaller/TerraformInstallerV1/src/terraform-installer.ts",
        fn: "downloadZipFromOpenTofu", sink: "fetchText", verdict: "EXEMPT-CONSTANT-HOST",
        why: "compile-time constant host (releases.hashicorp.com / github.com / api.github.com / checkpoint-api.hashicorp.com) \u2014 nothing at run time can influence it",
    },
];

const REPO_ROOT = path.resolve(__dirname, '../../../..');

describe('egress authorization (class test #161/#188/#191/#200/#201)', function () {
    this.timeout(30000);

    describe('A. the authorization decision, over every address spelling', () => {
        for (const row of HOST_ROWS) {
            it(`${row.reject ? 'refuses' : 'allows'} ${row.what}`, async () => {
                const lookup = row.resolvesTo ? lookupReturning(...row.resolvesTo) : lookupReturning('93.184.216.34');
                const call = () => assertEgressHostAllowed(row.host, row.allowedHosts ?? [], MESSAGES, lookup);
                if (!row.reject) {
                    await call();
                    return;
                }
                await assert.rejects(call, (err: Error) => {
                    assert.ok(
                        err.message.startsWith(`${row.reject}:`),
                        `expected a ${row.reject} rejection for ${row.host}, got: ${err.message}`,
                    );
                    return true;
                });
            });
        }
    });

    describe('B. the SAME decision re-applied on every redirect hop', () => {
        for (const row of REDIRECT_ROWS) {
            it(`${row.rejected ? 'refuses' : 'follows'} a ${row.what}`, async () => {
                const originalFetch = globalThis.fetch;
                const destination = path.join(os.tmpdir(), `egress-hop-${process.pid}-${Math.random().toString(36).slice(2)}.bin`);
                let hops = 0;
                globalThis.fetch = (async (input: string) => {
                    hops++;
                    if (hops === 1) {
                        return new Response(null, { status: 302, headers: { location: `https://${row.hop}/payload.zip` } });
                    }
                    assert.ok(String(input).includes(row.hop), 'second hop should target the redirect Location');
                    return new Response('payload', { status: 200 });
                }) as typeof globalThis.fetch;
                const lookup = row.resolvesTo ? lookupReturning(...row.resolvesTo) : lookupReturning('93.184.216.34');
                try {
                    const run = downloadToFile(
                        'https://artifacts.example.com/terraform.zip',
                        destination,
                        5000,
                        hostname => assertEgressHostAllowed(hostname, [], MESSAGES, lookup),
                    );
                    if (row.rejected) {
                        await assert.rejects(run, /IS_PRIVATE:/);
                        assert.ok(!fs.existsSync(destination), 'a refused download must leave no file behind');
                    } else {
                        await run;
                        assert.strictEqual(fs.readFileSync(destination, 'utf8'), 'payload');
                    }
                } finally {
                    globalThis.fetch = originalFetch;
                    try { fs.unlinkSync(destination); } catch { /* best effort */ }
                }
            });
        }

        it('refuses a hop that an explicit allowlist does not cover', async () => {
            const originalFetch = globalThis.fetch;
            const destination = path.join(os.tmpdir(), `egress-hop-pin-${process.pid}.bin`);
            globalThis.fetch = (async () => new Response(null, {
                status: 302,
                headers: { location: 'https://elsewhere.example.com/payload.zip' },
            })) as typeof globalThis.fetch;
            try {
                await assert.rejects(
                    downloadToFile('https://artifacts.example.com/terraform.zip', destination, 5000,
                        hostname => assertEgressHostAllowed(hostname, ['artifacts.example.com'], MESSAGES)),
                    /NOT_ALLOWED:elsewhere\.example\.com/,
                );
            } finally {
                globalThis.fetch = originalFetch;
                try { fs.unlinkSync(destination); } catch { /* best effort */ }
            }
        });
    });

    describe('C. every enumerated egress site in this repo', () => {
        // The signature exits non-zero when it finds residuals, and execFileSync
        // throws on a non-zero exit — capture stdout from the error so a residual
        // fails an ASSERTION below rather than aborting the whole suite at load.
        let stdout: string;
        try {
            stdout = execFileSync(
                process.execPath,
                [path.join(REPO_ROOT, 'scripts/check-egress-authorization.js'), REPO_ROOT, '--json'],
                { encoding: 'utf8' },
            );
        } catch (err) {
            stdout = String((err as { stdout?: string }).stdout ?? '');
            assert.ok(stdout.trim().startsWith('{'), `signature produced no JSON: ${String(err)}`);
        }
        const raw = JSON.parse(stdout) as { sites: Array<{ rel: string; fn: string; sink: string; verdict: string }>; suspects: string[]; failures: number };
        const report = { ...raw, sites: raw.sites.map(s => ({ file: s.rel, fn: s.fn, sink: s.sink, verdict: s.verdict, why: '' })) };

        it('leaves no unauthorized or textual-only site anywhere in src/', () => {
            assert.strictEqual(report.failures, 0,
                `residual egress-authorization sites:\n${JSON.stringify(report.sites.filter(s => s.verdict === 'UNAUTHORIZED' || s.verdict === 'TEXTUAL-ONLY'), null, 2)}`);
            assert.deepStrictEqual(report.suspects, [], 'textual address classification found outside registry-allowlist.ts');
        });

        it('enumerates exactly the sites this table accounts for', () => {
            const seen = report.sites.map(s => `${s.file}:${s.fn}:${s.sink}`).sort();
            const known = SITE_ROWS.map(s => `${s.file}:${s.fn}:${s.sink}`).sort();
            assert.deepStrictEqual(seen, known,
                'a new egress site appeared (or one vanished) — add it to SITE_ROWS with its verdict and reason');
        });

        for (const row of SITE_ROWS) {
            it(`${row.fn}() -> ${row.sink}() is ${row.verdict}`, () => {
                const site = report.sites.find(s => s.file === row.file && s.fn === row.fn && s.sink === row.sink);
                assert.ok(site, `site not found: ${row.fn} -> ${row.sink}`);
                assert.strictEqual(site!.verdict, row.verdict, row.why);
            });
        }
    });

    describe('D. operator input interpolated into a URL path segment (#200)', () => {
        const SEGMENT_ROWS: Array<{ value: string; valid: boolean; what: string }> = [
            { value: 'packer', valid: true, what: 'an ordinary mirror name' },
            { value: 'terraform-docs', valid: true, what: 'a hyphenated name' },
            { value: 'v1.2_beta', valid: true, what: 'dots and underscores inside the name' },
            { value: '..', valid: false, what: 'the traversal segment the old charset pattern matched' },
            { value: '.', valid: false, what: 'the current-directory segment' },
            { value: '..packer', valid: false, what: 'a leading traversal pair' },
            { value: 'packer..name', valid: false, what: 'an embedded traversal pair' },
            { value: '.hidden', valid: false, what: 'a leading dot' },
            { value: '../../etc/passwd', valid: false, what: 'an explicit traversal path' },
            { value: 'a/b', valid: false, what: 'a path separator' },
            { value: 'a%2fb', valid: false, what: 'a percent-encoded separator' },
            { value: '', valid: false, what: 'an empty segment' },
        ];
        for (const row of SEGMENT_ROWS) {
            it(`${row.valid ? 'accepts' : 'rejects'} ${row.what}`, () => {
                if (row.valid) {
                    assert.strictEqual(validateUrlPathSegment('registryMirrorName', row.value), row.value);
                } else {
                    assert.throws(() => validateUrlPathSegment('registryMirrorName', row.value), /registryMirrorName/);
                }
            });
        }
    });

    describe('E. every guard message resolves through task.json (#201)', () => {
        // A key present only in the resjson is never loaded by task-lib, so the
        // guard renders as its raw key name. Assert the four SSRF rejections (and
        // every other loc key this task uses) are declared where task-lib reads.
        const taskDir = path.resolve(__dirname, '..');
        const taskJson = JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8')) as { messages: Record<string, string> };
        const resjsonPath = path.join(taskDir, 'Strings/resources.resjson/en-US/resources.resjson');
        const resjson = fs.existsSync(resjsonPath)
            ? JSON.parse(fs.readFileSync(resjsonPath, 'utf8')) as Record<string, string>
            : {};

        function readSrc(dir: string, out: string[] = []): string[] {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) readSrc(full, out);
                else if (entry.name.endsWith('.ts')) out.push(fs.readFileSync(full, 'utf8'));
            }
            return out;
        }
        const sources = readSrc(path.join(taskDir, 'src'));

        const GUARD_KEYS = [
            'MirrorDownloadHostIsPrivate', 'MirrorDownloadHostNotAllowed',
            'RegistryDownloadHostIsPrivate', 'RegistryDownloadHostNotAllowed',
        ];
        for (const key of GUARD_KEYS) {
            it(`${key} is declared in task.json messages`, () => {
                assert.ok(taskJson.messages[key], `${key} missing from task.json messages — task-lib would render the raw key`);
            });
        }

        it('every tasks.loc() key used by this task is declared in task.json', () => {
            const used = sources.flatMap(s => [...s.matchAll(/\bloc\(\s*['"`]([A-Za-z0-9_]+)['"`]/g)].map(m => m[1]));
            const missing = [...new Set(used)].filter(k => !taskJson.messages[k]);
            assert.deepStrictEqual(missing, [], 'loc keys used in src but absent from task.json messages');
        });

        it('declares no resjson-only message key (the #201 shape)', () => {
            const resjsonOnly = Object.keys(resjson)
                .filter(k => k.startsWith('loc.messages.'))
                .map(k => k.slice('loc.messages.'.length))
                .filter(k => !taskJson.messages[k]);
            assert.deepStrictEqual(resjsonOnly, [], 'resjson-only keys are never loaded by task-lib');
        });
    });
});
