import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import tasks = require('azure-pipelines-task-lib/task');
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import adoModule = require('@4cloudguru/pipeline-task-ado');
import { TerraformCommandHandlerAzureRM } from '../src/azure-terraform-command-handler';
import { EnvironmentVariableHelper } from '@4cloudguru/pipeline-task-ado';

/**
 * `backendAzureRmUseCliFlagsForAuthentication` binds the azurerm backend to its
 * own service connection at init by saving that connection's identity in the
 * backend config, which later commands read instead of the provider's ARM_*
 * variables (#1180). It saved client_id but not tenant_id, so a backend in
 * another tenant signed in to the provider's (#1311): terraform reads
 * ARM_TENANT_ID only when tenant_id is empty (backendbase/sdklike.go, v1.17.2).
 *
 * Adding a setting to an already-initialized working directory makes
 * `terraform init` fail with "Backend configuration changed" (measured on
 * terraform 1.17.2), so a workspace an earlier init bound without tenant_id
 * keeps its settings and gets a warning instead.
 */
describe('azurerm backend bound at init saves its tenant (#1311)', function () {
    this.timeout(10000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch shared modules
    const t = tasks as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ado = adoModule as any;

    const orig = {
        debug: t.debug,
        warning: t.warning,
        setSecret: t.setSecret,
        getInput: t.getInput,
        getBoolInput: t.getBoolInput,
        getEndpointAuthorizationScheme: t.getEndpointAuthorizationScheme,
        getEndpointAuthorizationParameter: t.getEndpointAuthorizationParameter,
        getEndpointDataParameter: t.getEndpointDataParameter,
        generateIdToken: ado.generateIdToken,
    };

    const BACKEND_CONNECTION = {
        tenantid: '11111111-1111-1111-1111-111111111111',
        serviceprincipalid: '22222222-2222-2222-2222-222222222222',
        serviceprincipalkey: 'backend-secret',
        subscriptionid: '33333333-3333-3333-3333-333333333333',
    };
    const TENANT_ARG = `-backend-config=tenant_id=${BACKEND_CONNECTION.tenantid}`;

    let inputs: Record<string, string | undefined>;
    let bools: Record<string, boolean>;
    let scheme: string;
    let warnings: string[];
    let workDir: string;

    beforeEach(() => {
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurerm-tenant-binding-'));
        warnings = [];
        scheme = 'WorkloadIdentityFederation';
        bools = { backendAzureRmUseCliFlagsForAuthentication: true, backendAzureRmUseEntraIdForAuthentication: true };
        inputs = {
            workingDirectory: workDir,
            backendServiceArm: 'SC-BACKEND',
            backendAzureRmStorageAccountName: 'statesa',
            backendAzureRmContainerName: 'tfstate',
            backendAzureRmKey: 'prod.tfstate',
        };
        t.debug = () => { /* silence */ };
        t.warning = (message: string) => { warnings.push(message); };
        t.setSecret = () => { /* silence */ };
        t.getInput = (name: string, required?: boolean) => {
            const value = inputs[name];
            if (required && !value) throw new Error(`Input required: ${name}`);
            return value;
        };
        t.getBoolInput = (name: string) => bools[name] ?? false;
        t.getEndpointAuthorizationScheme = () => scheme;
        t.getEndpointAuthorizationParameter = (service: string, key: string) =>
            service === 'SystemVssConnection' && key === 'AccessToken'
                ? 'system-vss-access-token'
                : (BACKEND_CONNECTION as Record<string, string>)[key];
        t.getEndpointDataParameter = (_service: string, key: string) => (BACKEND_CONNECTION as Record<string, string>)[key];
        ado.generateIdToken = async () => 'mock-oidc-token';
        process.env['SYSTEM_OIDCREQUESTURI'] = 'https://vstoken.dev.azure.com/oidc';
    });

    afterEach(() => {
        Object.assign(t, orig);
        ado.generateIdToken = orig.generateIdToken;
        EnvironmentVariableHelper.clearTrackedVariables();
        delete process.env['SYSTEM_OIDCREQUESTURI'];
        fs.rmSync(workDir, { recursive: true, force: true });
    });

    /** The cache terraform writes: every attribute present, null when unset (#1309). */
    function keepWorkspace(set: Record<string, unknown>): void {
        const config: Record<string, unknown> = {
            storage_account_name: 'statesa', container_name: 'tfstate', key: 'prod.tfstate', use_azuread_auth: true,
            tenant_id: null, client_id: null, use_oidc: null, ado_pipeline_service_connection_id: null,
            client_secret: null, oidc_token: null, access_key: null, sas_token: null, use_msi: null, use_cli: null,
            ...set,
        };
        fs.mkdirSync(path.join(workDir, '.terraform'));
        fs.writeFileSync(path.join(workDir, '.terraform', 'terraform.tfstate'),
            JSON.stringify({ version: 3, backend: { type: 'azurerm', config } }));
    }

    async function initArgs(): Promise<string[]> {
        const args: string[] = [];
        const runner = { arg: (a: string) => { args.push(a); return runner; } } as unknown as ToolRunner;
        await new TerraformCommandHandlerAzureRM().handleBackend(runner);
        return args;
    }

    for (const idTokenGeneration of [false, true]) {
        const mode = idTokenGeneration ? 'ID token generation' : 'refresh mode';

        it(`a fresh init saves the backend connection's tenant beside its client_id (${mode})`, async () => {
            bools.backendAzureRmUseIdTokenGeneration = idTokenGeneration;
            const args = await initArgs();
            const tenant = args.indexOf(TENANT_ARG);
            assert.ok(tenant >= 0, `expected ${TENANT_ARG} in: ${args.join(' ')}`);
            assert.strictEqual(args[tenant + 1], `-backend-config=client_id=${BACKEND_CONNECTION.serviceprincipalid}`);
            assert.deepStrictEqual(warnings, []);
        });
    }

    it('a workspace an earlier init bound without tenant_id keeps its settings, with a warning', async () => {
        keepWorkspace({ client_id: BACKEND_CONNECTION.serviceprincipalid, use_oidc: true, ado_pipeline_service_connection_id: 'SC-BACKEND' });
        const args = await initArgs();
        assert.ok(!args.some(a => a.startsWith('-backend-config=tenant_id=')),
            `adding tenant_id to this workspace makes init fail with "Backend configuration changed": ${args.join(' ')}`);
        assert.ok(args.includes(`-backend-config=client_id=${BACKEND_CONNECTION.serviceprincipalid}`), 'the rest of the binding is unchanged');
        assert.strictEqual(warnings.length, 1, `expected one warning, got: ${warnings.join(' | ')}`);
        assert.match(warnings[0], /tenant_id/);
        assert.match(warnings[0], /\.terraform/);
    });

    it('a workspace that already has tenant_id is given the connection tenant', async () => {
        // A backend block that sets the same tenant is not a change (measured).
        keepWorkspace({ tenant_id: BACKEND_CONNECTION.tenantid, client_id: BACKEND_CONNECTION.serviceprincipalid, use_oidc: true });
        assert.ok((await initArgs()).includes(TENANT_ARG));
        assert.deepStrictEqual(warnings, []);
    });

    it('a workspace initialized without the binding gets all of it, tenant included', async () => {
        // client_id is new here as well, so the configuration changes either way.
        keepWorkspace({});
        assert.ok((await initArgs()).includes(TENANT_ARG));
        assert.deepStrictEqual(warnings, []);
    });

    // tenant_id is only saved where client_id is: a saved tenant beside the
    // provider's client_id from ARM_CLIENT_ID would sign in to the wrong tenant.
    const notBound: { name: string; arrange: () => void }[] = [
        { name: 'the binding is off', arrange: () => { bools.backendAzureRmUseCliFlagsForAuthentication = false; } },
        { name: 'the connection uses a client secret', arrange: () => { scheme = 'ServicePrincipal'; } },
        { name: 'the connection uses a managed identity', arrange: () => { scheme = 'ManagedServiceIdentity'; } },
    ];
    for (const row of notBound) {
        it(`saves no tenant_id when ${row.name}`, async () => {
            row.arrange();
            const args = await initArgs();
            assert.ok(!args.some(a => a.startsWith('-backend-config=tenant_id=') || a.startsWith('-backend-config=client_id=')),
                `nothing of the identity is saved: ${args.join(' ')}`);
        });
    }
});
