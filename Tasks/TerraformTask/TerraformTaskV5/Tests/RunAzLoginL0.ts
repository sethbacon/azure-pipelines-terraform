import * as assert from 'assert';
import tasks = require('azure-pipelines-task-lib/task');
import { TerraformCommandHandlerAzureRM } from '../src/azure-terraform-command-handler';
import { TerraformAuthorizationCommandInitializer } from '../src/terraform-commands';

/**
 * Direct unit tests for the opt-in `runAzLogin` path (#635). This is the one
 * handler path that places a live WIF federated token or service-principal
 * secret on `az login`'s argv, and it previously had zero test coverage — a
 * future refactor that flipped its default-off gate or broke a scheme branch
 * would have shipped green. These tests exercise the REAL runAzLogin/
 * handleProvider code (only the task-lib surface and `az` tool runner are
 * stubbed, never the handler itself): the default-off gate, the exact argv
 * built for each authorization scheme, the setSecret() masking of every
 * credential placed on argv, and the non-zero-exit / az-missing failures.
 */
describe('runAzLogin — opt-in az login gate, argv shape & secret masking (#635)', function () {
    // The WIF branch runs the real generateIdToken (fetch stubbed) with no retries.
    this.timeout(10000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
    const t = tasks as any;
    const orig = {
        debug: t.debug,
        warning: t.warning,
        which: t.which,
        tool: t.tool,
        setSecret: t.setSecret,
        loc: t.loc,
        getInput: t.getInput,
        getBoolInput: t.getBoolInput,
        getEndpointAuthorizationScheme: t.getEndpointAuthorizationScheme,
        getEndpointAuthorizationParameter: t.getEndpointAuthorizationParameter,
        getEndpointDataParameter: t.getEndpointDataParameter,
    };
    let originalFetch: typeof globalThis.fetch;
    let originalOidcUri: string | undefined;

    const setSecretCalls: string[] = [];
    // One record per `tasks.tool()` invocation, capturing the flattened argv and
    // the exec options passed to execAsync.
    let createdTools: { path: string; args: string[]; execOptions: unknown[] }[] = [];
    let nextExitCode = 0;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        originalOidcUri = process.env['SYSTEM_OIDCREQUESTURI'];
        setSecretCalls.length = 0;
        createdTools = [];
        nextExitCode = 0;

        t.debug = () => { /* silence */ };
        t.warning = () => { /* silence the SP deprecation warning */ };
        t.loc = (k: string) => k;
        t.which = () => '/usr/bin/az';
        t.setSecret = (s: string) => { setSecretCalls.push(s); };
        t.tool = (path: string) => {
            const rec = { path, args: [] as string[], execOptions: [] as unknown[] };
            createdTools.push(rec);
            const tool = {
                arg(a: string | string[]) {
                    if (Array.isArray(a)) { rec.args.push(...a); } else { rec.args.push(a); }
                    return tool;
                },
                async execAsync(opts?: unknown) {
                    rec.execOptions.push(opts);
                    return nextExitCode;
                },
            };
            return tool;
        };
        t.getEndpointAuthorizationParameter = (id: string, name: string) => {
            if (id === 'SystemVssConnection' && name === 'AccessToken') { return 'agent-access-token'; }
            switch (name) {
                case 'tenantid': return 'tenant-123';
                case 'serviceprincipalid': return 'spn-abc';
                case 'serviceprincipalkey': return 'spn-secret-xyz';
                default: return undefined;
            }
        };
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        if (originalOidcUri === undefined) {
            delete process.env['SYSTEM_OIDCREQUESTURI'];
        } else {
            process.env['SYSTEM_OIDCREQUESTURI'] = originalOidcUri;
        }
        // ARM_* env vars are set by setCommonVariables in the gate tests below.
        for (const v of ['ARM_TENANT_ID', 'ARM_USE_MSI', 'ARM_CLIENT_ID', 'ARM_SUBSCRIPTION_ID']) {
            delete process.env[v];
        }
        Object.assign(t, orig);
    });

    /* --- authorization-scheme branch argv + masking (real runAzLogin) --- */

    it('WIF branch: builds the federated-token argv and masks the token before use', async () => {
        process.env['SYSTEM_OIDCREQUESTURI'] = 'https://vstoken.dev.azure.com/oidc';
        globalThis.fetch = (async () =>
            new Response(JSON.stringify({ oidcToken: 'fed-oidc-token' }), { status: 200 })) as unknown as typeof globalThis.fetch;

        const handler = new TerraformCommandHandlerAzureRM();
        await (handler as any).runAzLogin('workloadidentityfederation', 'sc-1', '');

        assert.strictEqual(createdTools.length, 1, 'no subscription set → exactly one az invocation');
        assert.deepStrictEqual(createdTools[0].args, [
            'login', '--service-principal',
            '--username', 'spn-abc',
            '--tenant', 'tenant-123',
            '--allow-no-subscriptions',
            '--federated-token', 'fed-oidc-token',
        ]);
        // The federated token placed on argv must be registered as a secret so it
        // is masked in any log output.
        assert.ok(setSecretCalls.includes('fed-oidc-token'), 'the federated token on argv must be setSecret()-masked');
        assert.deepStrictEqual(createdTools[0].execOptions, [{ silent: true }], 'az login runs silent so argv is not echoed');
    });

    it('ServicePrincipal branch: builds the --password argv and masks the secret before use', async () => {
        const handler = new TerraformCommandHandlerAzureRM();
        await (handler as any).runAzLogin('serviceprincipal', 'sc-1', '');

        assert.strictEqual(createdTools.length, 1);
        assert.deepStrictEqual(createdTools[0].args, [
            'login', '--service-principal',
            '--username', 'spn-abc',
            '--password', 'spn-secret-xyz',
            '--tenant', 'tenant-123',
            '--allow-no-subscriptions',
        ]);
        assert.ok(setSecretCalls.includes('spn-secret-xyz'), 'the client secret on argv must be setSecret()-masked');
    });

    it('MSI branch: uses --identity with the user-assigned client id and carries no secret on argv', async () => {
        const handler = new TerraformCommandHandlerAzureRM();
        await (handler as any).runAzLogin('managedserviceidentity', 'sc-1', '');

        assert.strictEqual(createdTools.length, 1);
        assert.deepStrictEqual(createdTools[0].args, ['login', '--identity', '--username', 'spn-abc']);
        // MSI carries no secret in argv at all.
        assert.deepStrictEqual(setSecretCalls, [], 'the MSI branch places no credential on argv, so nothing to mask');
    });

    it('sets the active subscription with a second az invocation when a subscription is provided', async () => {
        const handler = new TerraformCommandHandlerAzureRM();
        await (handler as any).runAzLogin('managedserviceidentity', 'sc-1', 'sub-999');

        assert.strictEqual(createdTools.length, 2, 'login + account set');
        assert.deepStrictEqual(createdTools[1].args, ['account', 'set', '--subscription', 'sub-999']);
    });

    it('throws when az login exits non-zero', async () => {
        nextExitCode = 1;
        const handler = new TerraformCommandHandlerAzureRM();
        await assert.rejects(
            (handler as any).runAzLogin('managedserviceidentity', 'sc-1', ''),
            /az login failed with exit code 1/,
        );
    });

    it('throws an actionable error when the az CLI is not installed', async () => {
        t.which = () => { throw new Error('not found'); };
        const handler = new TerraformCommandHandlerAzureRM();
        await assert.rejects(
            (handler as any).runAzLogin('managedserviceidentity', 'sc-1', ''),
            /az CLI not found/,
        );
        assert.strictEqual(createdTools.length, 0, 'must not attempt any az invocation when the CLI is missing');
    });

    /* --- default-off gate in handleProvider --- */

    // A faithful stand-in for task-lib's getBoolInput: an input absent from the
    // map yields false, exactly as the real getBoolInput returns false for an
    // omitted input. (The real getBoolInput cannot be used directly here — it
    // snapshots inputs at module load, so a value set at test time is ignored.)
    function installBoolInputStub(present: Record<string, boolean>): [string, boolean][] {
        const calls: [string, boolean][] = [];
        t.getBoolInput = (name: string, required?: boolean) => {
            calls.push([name, required as boolean]);
            return name in present ? present[name] : false;
        };
        return calls;
    }

    function installHandleProviderStubs(): void {
        t.getInput = (name: string) => (name === 'environmentServiceNameAzureRM' ? 'sc-1' : undefined);
        t.getEndpointAuthorizationScheme = () => 'managedserviceidentity';
        t.getEndpointDataParameter = () => undefined;
    }

    it('does not invoke az login when runAzLogin is omitted (default false)', async () => {
        installHandleProviderStubs();
        const boolCalls = installBoolInputStub({}); // runAzLogin absent → default false

        const handler = new TerraformCommandHandlerAzureRM();
        let runAzLoginCalls = 0;
        (handler as any).runAzLogin = async () => { runAzLoginCalls++; };

        await handler.handleProvider({} as TerraformAuthorizationCommandInitializer);

        assert.strictEqual(runAzLoginCalls, 0, 'az login must not run when the input is omitted');
        assert.ok(
            boolCalls.some(([name, required]) => name === 'runAzLogin' && required === false),
            'the gate must read getBoolInput("runAzLogin", false) so an omitted input defaults to off',
        );
    });

    it('invokes az login when runAzLogin is explicitly enabled', async () => {
        installHandleProviderStubs();
        installBoolInputStub({ runAzLogin: true });

        const handler = new TerraformCommandHandlerAzureRM();
        const runAzLoginArgs: unknown[][] = [];
        (handler as any).runAzLogin = async (...args: unknown[]) => { runAzLoginArgs.push(args); };

        await handler.handleProvider({} as TerraformAuthorizationCommandInitializer);

        assert.strictEqual(runAzLoginArgs.length, 1, 'az login must run once when the input is true');
        assert.strictEqual(runAzLoginArgs[0][0], 'managedserviceidentity', 'passes the resolved auth scheme through');
    });
});
