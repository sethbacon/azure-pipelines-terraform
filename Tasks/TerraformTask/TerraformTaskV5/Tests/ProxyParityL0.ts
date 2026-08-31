import * as assert from 'assert';
import * as crypto from 'crypto';
import * as path from 'path';
import { execFileSync } from 'child_process';
import tasks = require('azure-pipelines-task-lib/task');
import { generateIdToken } from '@4cloudguru/pipeline-task-ado';
import { exchangeOidcForUpst } from '../src/oci-token-exchange';

/**
 * CLASS TEST — outbound proxy parity (sibling azure-pipelines-packer #196).
 *
 * Defect class: an outbound HTTP request is issued through a transport
 * primitive that does NOT consult the ADO agent's configured proxy, in a repo
 * where sibling transports do. Node's global fetch() ignores HTTP_PROXY /
 * HTTPS_PROXY and every agent setting unless handed an undici dispatcher, and
 * node:https ignores them unless handed an `agent` — so "honours the proxy" is
 * a property of the CALL, not of the process environment.
 *
 * #196 was filed against the packer extension only. Per the run's signature
 * scope, the same signature is run here: this repo is the one that already had
 * a task-local proxy builder, so it is the parity reference, and these tables
 * pin that status so it cannot silently regress on a task that is added later.
 *
 * Two tables:
 *   A. WIF_CALL_ROWS — every outbound WIF/token-exchange call this task makes,
 *                      driven through its REAL entry point with a stubbed fetch,
 *                      asserting a dispatcher arrives when a proxy is configured
 *                      and does NOT when one is not.
 *   B. SITE_ROWS    — every outbound call site the re-runnable signature
 *                     (scripts/check-proxy-parity.js) enumerates across ALL
 *                     tasks in this repo, with its verdict.
 *
 * Mutation-provability: dropping `...buildAdoFetchOptions()` from either
 * fetch reddens that call's own table-A rows plus its own table-B site row and
 * the class-wide "no unproxied site" row — and no sibling row. Direct unit
 * coverage of buildAdoFetchOptions itself lives in ProxyConfigL0.ts.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
const t = tasks as any;

type ProxyConfig = { proxyUrl: string; proxyUsername?: string; proxyPassword?: string };

const { publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/**
 * Table A. Every outbound call on a WIF path, exercised through its real entry
 * point. `respond` returns the success body that entry point expects, so the row
 * asserts on the RequestInit the transport actually built rather than on a
 * hand-assembled one.
 */
type WifCallRow = {
    what: string;
    respond: () => Response;
    invoke: () => Promise<unknown>;
    /** The redirect policy this call must keep after the proxy options are spread in. */
    redirect: RequestRedirect;
};
const WIF_CALL_ROWS: WifCallRow[] = [
    {
        what: 'ADO OIDC token request (every WIF provider)',
        respond: () => new Response(JSON.stringify({ oidcToken: 'federated-token' }), {
            status: 200, headers: { 'content-type': 'application/json' },
        }),
        invoke: () => generateIdToken('service-connection-id'),
        redirect: 'error',
    },
    {
        what: 'OCI Identity Domains UPST token exchange',
        respond: () => new Response(JSON.stringify({ access_token: 'the-upst' }), { status: 200 }),
        invoke: () => exchangeOidcForUpst('jwt', 'https://idcs-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.identity.oraclecloud.com', 'client', publicKey),
        redirect: 'manual',
    },
];

/** Table B. Every outbound call site the signature enumerates in THIS repo. */
type SiteRow = { file: string; fn: string; sink: string; verdict: string; why: string };
const SITE_ROWS: SiteRow[] = [
    // --- fetch-based, proxied via buildAdoFetchOptions / buildFetchOptions ---
    //
    // The ADO OIDC token request (the terraform twin of the site reported as
    // #196 in packer) used to sit here as src/id-token-generator.ts, with the
    // fetch as its own sink. It now lives in @4cloudguru/pipeline-task-ado, so
    // the signature enumerates the five call sites below instead — each one a
    // handler reaching generateIdToken() — and the fetch itself is no longer in
    // this repo. Its proxy behaviour is still asserted from here by the
    // WIF_CALL_ROWS entry above, which drives generateIdToken() through a
    // stubbed transport and inspects the RequestInit the package actually built.
    {
        file: 'Tasks/TerraformTask/TerraformTaskV5/src/aws-terraform-command-handler.ts',
        fn: 'applyWifEnvironment', sink: 'generateIdToken', verdict: 'PROXIED-BY-PACKAGE',
        why: 'AWS WIF entry point; the proxy decision now lives in pipeline-task-ado, so the site is held to a version floor instead',
    },
    {
        file: 'Tasks/TerraformTask/TerraformTaskV5/src/azure-terraform-command-handler.ts',
        fn: 'getWorkloadIdentityFederationCredentials', sink: 'generateIdToken', verdict: 'PROXIED-BY-PACKAGE',
        why: 'Azure WIF credential path; proxying is the package\'s responsibility once the call crosses the module boundary',
    },
    {
        file: 'Tasks/TerraformTask/TerraformTaskV5/src/azure-terraform-command-handler.ts',
        fn: 'runAzLogin', sink: 'generateIdToken', verdict: 'PROXIED-BY-PACKAGE',
        why: 'az login federated-token path; same package-owned transport as the credential path above',
    },
    {
        file: 'Tasks/TerraformTask/TerraformTaskV5/src/gcp-terraform-command-handler.ts',
        fn: 'writeWifCredentials', sink: 'generateIdToken', verdict: 'PROXIED-BY-PACKAGE',
        why: 'GCP WIF credential file generation; token fetch is package-owned',
    },
    {
        file: 'Tasks/TerraformTask/TerraformTaskV5/src/oci-terraform-command-handler.ts',
        fn: 'handleProviderWIF', sink: 'generateIdToken', verdict: 'PROXIED-BY-PACKAGE',
        why: 'first hop of the OCI WIF flow; the second hop (oci-token-exchange) is still local and keeps its own row below',
    },
    {
        file: 'Tasks/TerraformTask/TerraformTaskV5/src/oci-token-exchange.ts',
        fn: 'attemptExchange', sink: 'fetch', verdict: 'PROXIED',
        why: 'second hop of the OCI WIF flow; carries the federated JWT, so it needs the same proxy path',
    },
    {
        file: 'Tasks/TerraformInstaller/TerraformInstallerV1/src/http-client.ts',
        fn: 'createDefaultClient', sink: 'createAdoHttpClient', verdict: 'PROXIED-BY-PACKAGE',
        why: 'installer transport; the proxy decision itself now lives in pipeline-task-ado, so there is no fetchOptions here to inspect and the site is held to a version floor instead',
    },
    {
        file: 'Tasks/TerraformInstaller/TerraformInstallerV1/src/http-client.ts',
        fn: 'createRegistryClient', sink: 'createAdoHttpClient', verdict: 'PROXIED-BY-PACKAGE',
        why: 'the same transport with the registry-specific failure message; a second construction is a second site the floor has to cover',
    },
    {
        file: 'Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/http-client.ts',
        fn: 'createDefaultClient', sink: 'createAdoHttpClient', verdict: 'PROXIED-BY-PACKAGE',
        why: 'byte-identical copy of the installer transport',
    },
    {
        file: 'Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/http-client.ts',
        fn: 'createRegistryClient', sink: 'createAdoHttpClient', verdict: 'PROXIED-BY-PACKAGE',
        why: 'byte-identical copy of the installer transport',
    },
    {
        file: 'Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src/http-client.ts',
        fn: 'createDefaultClient', sink: 'createAdoHttpClient', verdict: 'PROXIED-BY-PACKAGE',
        why: 'byte-identical copy of the installer transport',
    },
    {
        file: 'Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src/http-client.ts',
        fn: 'createRegistryClient', sink: 'createAdoHttpClient', verdict: 'PROXIED-BY-PACKAGE',
        why: 'byte-identical copy of the installer transport',
    },
    // --- the raw-https transport, delegated to @4cloudguru/pipeline-task-core ---
    // The real https.request() left this tree with the transport, so these rows
    // moved from PROXIED (an agent read out of the call) to PROXIED-BY-PACKAGE
    // (an agent read out of the call PLUS a version floor on the package that
    // implements it). What is still decided here is the `agent` argument, and
    // node:https reaches no proxy without one.
    {
        file: 'Tasks/TerraformDriftReport/TerraformDriftReportV1/src/https-client.ts',
        fn: 'createHttpsClient', sink: 'httpsRequest', verdict: 'PROXIED-BY-PACKAGE',
        why: 'the drift callback carries a TSM token; agent comes from buildProxyAgent()',
    },
    {
        file: 'Tasks/TerraformModulePublish/TerraformModulePublishV1/src/https-client.ts',
        fn: 'createHttpsClient', sink: 'httpsRequest', verdict: 'PROXIED-BY-PACKAGE',
        why: 'byte-identical transport shared with the drift report',
    },
    {
        file: 'Tasks/PublishKbArticle/PublishKbArticleV1/src/servicenow-http.ts',
        fn: 'snRequest', sink: 'httpsRequest', verdict: 'PROXIED-BY-PACKAGE',
        why: 'ServiceNow Table API calls carry an OAuth/Basic credential',
    },
    // --- exemptions, each verified against the code it names ---
    {
        file: 'Tasks/TerraformInstaller/TerraformInstallerV1/src/terraform-installer.ts',
        fn: 'downloadZipFromHashiCorp', sink: 'downloadTool', verdict: 'EXEMPT-TOOL-LIB',
        why: 'azure-pipelines-tool-lib/tool.js builds its HttpClient with proxy: tl.getHttpProxyConfiguration()',
    },
    {
        file: 'Tasks/TerraformInstaller/TerraformInstallerV1/src/terraform-installer.ts',
        fn: 'downloadZipFromOpenTofu', sink: 'downloadTool', verdict: 'EXEMPT-TOOL-LIB',
        why: 'same tool-lib transport as the HashiCorp path',
    },
    {
        file: 'Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/policy-agent-installer.ts',
        fn: 'downloadTo', sink: 'downloadTool', verdict: 'EXEMPT-TOOL-LIB',
        why: 'same tool-lib transport',
    },
    {
        file: 'Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src/terraform-docs-installer.ts',
        fn: 'downloadTo', sink: 'downloadTool', verdict: 'EXEMPT-TOOL-LIB',
        why: 'same tool-lib transport',
    },
    // The three EXEMPT-PROXY-TRANSPORT rows that used to sit here — the CONNECT
    // hop issued from inside each hand-copied ProxyTunnelAgent — are GONE, not
    // reclassified: that class now lives in @4cloudguru/pipeline-task-core, so
    // the call sites are genuinely not in this repository any more. Deleting
    // them is what keeps this table an inventory rather than a wish list; the
    // bidirectional check below fails on a vanished site exactly as it does on
    // a new one, which is how this deletion had to be made deliberately.
    {
        file: 'src/tab/tabContent.tsx',
        fn: 'loadDigestItems', sink: 'fetch', verdict: 'EXEMPT-BROWSER',
        why: 'runs in the build-results-tab iframe: no task-lib, no agent proxy config; the browser applies the user proxy',
    },
    {
        file: 'src/tab/tabContent.tsx',
        fn: 'loadRawAttachments', sink: 'fetch', verdict: 'EXEMPT-BROWSER',
        why: 'same iframe context as loadDigestItems',
    },
];

describe('outbound proxy parity (class test, sibling packer #196)', function () {
    this.timeout(30000);

    const origProxy = t.getHttpProxyConfiguration;
    const origSetSecret = t.setSecret;
    const origDebug = t.debug;
    const origGetEndpointAuthorizationParameter = t.getEndpointAuthorizationParameter;
    const origLoc = t.loc;
    let originalFetch: typeof globalThis.fetch;
    let originalOidcUri: string | undefined;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        originalOidcUri = process.env['SYSTEM_OIDCREQUESTURI'];
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        if (originalOidcUri === undefined) delete process.env['SYSTEM_OIDCREQUESTURI'];
        else process.env['SYSTEM_OIDCREQUESTURI'] = originalOidcUri;
        t.getHttpProxyConfiguration = origProxy;
        t.setSecret = origSetSecret;
        t.debug = origDebug;
        t.getEndpointAuthorizationParameter = origGetEndpointAuthorizationParameter;
        t.loc = origLoc;
    });

    describe('A. every WIF outbound call, driven through its real entry point', () => {
        function armFetchCapture(row: WifCallRow, proxy: ProxyConfig | undefined): { inits: RequestInit[] } {
            const inits: RequestInit[] = [];
            process.env['SYSTEM_OIDCREQUESTURI'] = 'https://vstoken.dev.azure.com/oidc';
            t.debug = () => { /* silence */ };
            t.setSecret = () => { /* not under test here */ };
            t.loc = (k: string) => k;
            t.getEndpointAuthorizationParameter = () => 'access-token';
            t.getHttpProxyConfiguration = () => proxy;
            globalThis.fetch = (async (_url: string, init: RequestInit) => {
                inits.push(init);
                return row.respond();
            }) as unknown as typeof globalThis.fetch;
            return { inits };
        }

        for (const row of WIF_CALL_ROWS) {
            it(`${row.what} is routed through the agent proxy when one is configured`, async () => {
                const captured = armFetchCapture(row, {
                    proxyUrl: 'http://proxy.example.com:8080',
                    proxyUsername: 'user',
                    proxyPassword: 'p@ss',
                });
                await row.invoke();
                assert.ok(captured.inits.length > 0, 'the stubbed fetch was never called');
                for (const init of captured.inits) {
                    assert.ok(init && 'dispatcher' in init,
                        `${row.what}: fetch was called without a proxy dispatcher — Node's global fetch would bypass the agent proxy`);
                }
            });

            it(`${row.what} connects directly when no proxy is configured`, async () => {
                const captured = armFetchCapture(row, undefined);
                await row.invoke();
                assert.ok(captured.inits.length > 0, 'the stubbed fetch was never called');
                for (const init of captured.inits) {
                    assert.ok(init && !('dispatcher' in init),
                        `${row.what}: a dispatcher was attached with no proxy configured`);
                }
            });

            it(`${row.what} keeps its existing transport hardening`, async () => {
                const captured = armFetchCapture(row, { proxyUrl: 'http://proxy.example.com:8080' });
                await row.invoke();
                for (const init of captured.inits) {
                    // Spreading proxy options must not relax the redirect policy: a
                    // 3xx could otherwise forward a bearer credential to an
                    // unvalidated hop through the proxy.
                    assert.strictEqual(init.redirect, row.redirect,
                        `${row.what}: redirect policy was weakened by the proxy options`);
                    assert.ok(init.signal, `${row.what}: the abort signal (30s timeout) was dropped`);
                }
            });
        }
    });

    describe('B. every enumerated outbound call site in this repo', () => {
        // The signature exits non-zero when it finds residuals, and execFileSync
        // throws on a non-zero exit — capture stdout from the error so a residual
        // fails an ASSERTION below rather than aborting the whole suite at load.
        let stdout: string;
        try {
            stdout = execFileSync(
                process.execPath,
                [path.join(REPO_ROOT, 'scripts/check-proxy-parity.js'), REPO_ROOT, '--json'],
                { encoding: 'utf8' },
            );
        } catch (err) {
            stdout = String((err as { stdout?: string }).stdout ?? '');
            assert.ok(stdout.trim().startsWith('{'), `signature produced no JSON: ${String(err)}`);
        }
        const report = JSON.parse(stdout) as {
            sites: Array<{ rel: string; fn: string; sink: string; verdict: string }>;
            failures: number;
        };

        it('leaves no unproxied outbound call site anywhere in src/', () => {
            assert.strictEqual(report.failures, 0,
                `residual unproxied call sites:\n${JSON.stringify(report.sites.filter(s => s.verdict === 'UNPROXIED'), null, 2)}`);
        });

        it('enumerates exactly the sites this table accounts for', () => {
            const seen = report.sites.map(s => `${s.rel}:${s.fn}:${s.sink}`).sort();
            const known = SITE_ROWS.map(s => `${s.file}:${s.fn}:${s.sink}`).sort();
            assert.deepStrictEqual(seen, known,
                'a new outbound call site appeared (or one vanished) — add it to SITE_ROWS with its verdict and reason');
        });

        for (const row of SITE_ROWS) {
            it(`${row.file.split('/').slice(-3).join('/')} ${row.fn}() -> ${row.sink}() is ${row.verdict}`, () => {
                const site = report.sites.find(s => s.rel === row.file && s.fn === row.fn && s.sink === row.sink);
                assert.ok(site, `site not found: ${row.file} ${row.fn} -> ${row.sink}`);
                assert.strictEqual(site!.verdict, row.verdict, row.why);
            });
        }
    });
});
