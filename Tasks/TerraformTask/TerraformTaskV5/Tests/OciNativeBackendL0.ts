import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import tasks = require('azure-pipelines-task-lib/task');
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
// One exports object: generateIdToken, readUrlInput and exchangeOidcForUpst are
// all patched on it, as OciWifHandleProviderL0.ts does.
import adoModule = require('@4cloudguru/pipeline-task-ado');
import { TerraformCommandHandlerOCI } from '../src/oci-terraform-command-handler';
import { TerraformAuthorizationCommandInitializer } from '../src/terraform-commands';
import { EnvironmentVariableHelper } from '@4cloudguru/pipeline-task-ado';
import { TEST_OCI_PRIVATE_KEY_SPACES, TEST_OCI_PRIVATE_KEY_PEM } from './test-oci-fixtures';

/**
 * Direct unit tests for the native OCI Object Storage state backend (#1304).
 *
 * Terraform's `oci` backend (1.12+) reads its identity from `OCI_<attribute>`
 * environment variables and, for a security token, from `$OCI_HOME_OVERRIDE/.oci/config`.
 * It ignores the provider's `OCI_CLI_*` variables. All of this was measured on
 * terraform 1.17.2 against a local capture server, reading the keyId of each
 * signed request. These tests pin the task's side of that contract:
 *   - credentials reach the backend as environment variables only, never as
 *     -backend-config (which terraform caches in .terraform/terraform.tfstate);
 *   - every field is read through the fail-closed guards;
 *   - WIF mints nothing until every input has been validated;
 *   - the provider pass that follows does not replace the backend identity.
 */
describe('OCI native Object Storage backend (#1304)', function () {
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
        getEndpointDataParameter: t.getEndpointDataParameter,
        getEndpointAuthorizationParameter: t.getEndpointAuthorizationParameter,
        readUrlInput: ado.readUrlInput,
        generateIdToken: ado.generateIdToken,
        exchangeOidcForUpst: ado.exchangeOidcForUpst,
    };

    const BACKEND_ENV = [
        'OCI_auth', 'OCI_tenancy_ocid', 'OCI_user_ocid', 'OCI_fingerprint', 'OCI_private_key',
        'OCI_private_key_path', 'OCI_private_key_password', 'OCI_config_file_profile', 'OCI_region',
        'OCI_HOME_OVERRIDE', 'private_key', 'private_key_password', 'config_file_profile',
    ];

    const WIF_DOMAIN = 'https://idcs-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.identity.oraclecloud.com';
    let inputs: Record<string, string | undefined>;
    let endpoints: Record<string, Record<string, string>>;
    let mintedFor: string[];

    const connection = (user: string): Record<string, string> => ({
        tenancy: 'ocid1.tenancy.oc1..dummy',
        user,
        region: 'us-ashburn-1',
        fingerprint: 'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99',
    });

    beforeEach(() => {
        for (const name of BACKEND_ENV) delete process.env[name];
        mintedFor = [];
        inputs = {
            backendOCIStateBackend: 'objectStorage',
            backendServiceOCI: 'OCI-Backend',
            backendOCIBucket: 'tfstate',
            backendOCINamespace: 'axaxnpcrorw5',
            backendOCIKey: 'env/prod.tfstate',
        };
        endpoints = {
            'OCI-Backend': connection('ocid1.user.oc1..backend'),
            'OCI-Provider': connection('ocid1.user.oc1..provider'),
        };
        t.debug = () => { /* silence */ };
        t.warning = () => { /* silence */ };
        t.setSecret = () => { /* silence */ };
        t.getInput = (name: string, required?: boolean) => {
            const value = inputs[name];
            if (required && !value) throw new Error(`Input required: ${name}`);
            return value;
        };
        t.getBoolInput = () => false;
        t.getEndpointDataParameter = (service: string, key: string) => endpoints[service]?.[key];
        t.getEndpointAuthorizationParameter = (service: string, key: string) =>
            key === 'privateKey' && endpoints[service] ? TEST_OCI_PRIVATE_KEY_SPACES : undefined;
        ado.readUrlInput = (name: string, required?: boolean) => t.getInput(name, required);
        ado.generateIdToken = async (service: string) => { mintedFor.push(service); return 'mock-oidc-token'; };
        ado.exchangeOidcForUpst = async () => 'mock-upst-token';
    });

    afterEach(() => {
        Object.assign(t, {
            debug: orig.debug, warning: orig.warning, setSecret: orig.setSecret, getInput: orig.getInput,
            getBoolInput: orig.getBoolInput, getEndpointDataParameter: orig.getEndpointDataParameter,
            getEndpointAuthorizationParameter: orig.getEndpointAuthorizationParameter,
        });
        Object.assign(ado, {
            readUrlInput: orig.readUrlInput, generateIdToken: orig.generateIdToken,
            exchangeOidcForUpst: orig.exchangeOidcForUpst,
        });
        EnvironmentVariableHelper.clearTrackedVariables();
        for (const name of BACKEND_ENV) delete process.env[name];
    });

    function fakeRunner(): { runner: ToolRunner; args: string[] } {
        const args: string[] = [];
        const runner = { arg: (a: string) => { args.push(a); return runner; } } as unknown as ToolRunner;
        return { runner, args };
    }

    function useBackendWif(): void {
        Object.assign(inputs, {
            backendAuthSchemeOCI: 'WorkloadIdentityFederation',
            backendOCIWifTenancyOcid: 'ocid1.tenancy.oc1..dummy',
            backendOCIWifRegion: 'eu-frankfurt-1',
            backendOCIWifIdentityDomainUrl: WIF_DOMAIN,
            backendOCIWifClientId: 'backend-client-id',
        });
    }

    describe('PAR mode', () => {
        it('is the default and never reads backendServiceOCI', async () => {
            inputs = { backendOCIConfigGenerate: 'no' };
            const { runner, args } = fakeRunner();
            await new TerraformCommandHandlerOCI().handleBackend(runner);
            assert.deepStrictEqual(args, []);
            assert.strictEqual(process.env['OCI_auth'], undefined);
        });

        it('rejects an unknown backendOCIStateBackend rather than guessing a mode', async () => {
            inputs.backendOCIStateBackend = 'objectstorage';
            await assert.rejects(
                () => new TerraformCommandHandlerOCI().handleBackend(fakeRunner().runner),
                /backendOCIStateBackend 'objectstorage'/,
            );
        });
    });

    describe('init, service connection (API key)', () => {
        it('passes only bucket, namespace and key as -backend-config; the identity goes in OCI_* variables', async () => {
            const { runner, args } = fakeRunner();
            const handler = new TerraformCommandHandlerOCI();
            await handler.handleBackend(runner);

            assert.deepStrictEqual(args, [
                '-backend-config=bucket=tfstate',
                '-backend-config=namespace=axaxnpcrorw5',
                '-backend-config=key=env/prod.tfstate',
            ]);
            assert.strictEqual(process.env['OCI_auth'], 'ApiKey');
            assert.strictEqual(process.env['OCI_tenancy_ocid'], 'ocid1.tenancy.oc1..dummy');
            assert.strictEqual(process.env['OCI_user_ocid'], 'ocid1.user.oc1..backend');
            assert.strictEqual(process.env['OCI_fingerprint'], 'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99');
            assert.strictEqual(process.env['OCI_region'], 'us-ashburn-1');
            const keyPath = process.env['OCI_private_key_path']!;
            assert.strictEqual(fs.readFileSync(keyPath, 'utf8'), TEST_OCI_PRIVATE_KEY_PEM);
            assert.strictEqual(process.env['OCI_HOME_OVERRIDE'], undefined);

            handler.cleanupTempFiles();
            assert.strictEqual(fs.existsSync(keyPath), false, 'the key file must be removed at cleanup');
        });

        it('clears inherited values the backend would prefer, such as an inline private_key', async () => {
            Object.assign(process.env, {
                OCI_private_key: 'inherited-inline-key', private_key: 'inherited-bare-key',
                OCI_private_key_password: 'inherited', OCI_config_file_profile: 'INHERITED',
                OCI_HOME_OVERRIDE: '/inherited/home',
            });
            await new TerraformCommandHandlerOCI().handleBackend(fakeRunner().runner);
            for (const name of ['OCI_private_key', 'private_key', 'OCI_private_key_password', 'OCI_config_file_profile', 'OCI_HOME_OVERRIDE']) {
                assert.strictEqual(process.env[name], undefined, `${name} must be cleared`);
            }
        });

        it('fails closed on an empty connection field and sets nothing', async () => {
            endpoints['OCI-Backend'].fingerprint = '';
            await assert.rejects(
                () => new TerraformCommandHandlerOCI().handleBackend(fakeRunner().runner),
                /field 'fingerprint' is missing or empty/,
            );
            assert.strictEqual(process.env['OCI_auth'], undefined);
        });

        it('requires bucket, namespace and key', async () => {
            for (const name of ['backendOCIBucket', 'backendOCINamespace', 'backendOCIKey']) {
                const saved = inputs[name];
                inputs[name] = undefined;
                await assert.rejects(
                    () => new TerraformCommandHandlerOCI().handleBackend(fakeRunner().runner),
                    new RegExp(`Input required: ${name}`),
                );
                inputs[name] = saved;
            }
        });
    });

    describe('init, Workload Identity Federation', () => {
        it('mints nothing when a backend WIF input is invalid, and names that input', async () => {
            useBackendWif();
            inputs.backendOCIWifTenancyOcid = 'ocid1.tenancy.oc1..x\nkey_file=/etc/passwd';
            await assert.rejects(
                () => new TerraformCommandHandlerOCI().handleBackend(fakeRunner().runner),
                /backendOCIWifTenancyOcid/,
            );
            assert.deepStrictEqual(mintedFor, [], 'no OIDC assertion may be minted for a config about to be rejected');
        });

        it('rejects a query string in the identity domain URL before anything is minted', async () => {
            useBackendWif();
            inputs.backendOCIWifIdentityDomainUrl = `${WIF_DOMAIN}/?x=`;
            await assert.rejects(
                () => new TerraformCommandHandlerOCI().handleBackend(fakeRunner().runner),
                /backendOCIWifIdentityDomainUrl/,
            );
            assert.deepStrictEqual(mintedFor, []);
        });

        it('writes a security-token profile under a per-run OCI_HOME_OVERRIDE and removes it at cleanup', async () => {
            useBackendWif();
            const { runner, args } = fakeRunner();
            const handler = new TerraformCommandHandlerOCI();
            await handler.handleBackend(runner);

            assert.deepStrictEqual(mintedFor, ['OCI-Backend']);
            assert.strictEqual(args.length, 3, 'still only bucket, namespace and key');
            assert.strictEqual(process.env['OCI_auth'], 'SecurityToken');
            assert.strictEqual(process.env['OCI_config_file_profile'], 'DEFAULT');
            assert.strictEqual(process.env['OCI_region'], 'eu-frankfurt-1');
            for (const name of ['OCI_tenancy_ocid', 'OCI_user_ocid', 'OCI_fingerprint', 'OCI_private_key_path']) {
                assert.strictEqual(process.env[name], undefined, `${name} must not be set for a security token`);
            }

            const home = process.env['OCI_HOME_OVERRIDE']!;
            const configPath = path.join(home, '.oci', 'config');
            const config = fs.readFileSync(configPath, 'utf8');
            const field = (k: string): string => (config.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1];
            assert.ok(config.startsWith('[DEFAULT]\n'));
            assert.strictEqual(field('tenancy'), 'ocid1.tenancy.oc1..dummy');
            assert.strictEqual(field('region'), 'eu-frankfurt-1');
            assert.match(field('fingerprint'), /^([0-9a-f]{2}:){15}[0-9a-f]{2}$/);
            assert.strictEqual(fs.readFileSync(field('security_token_file'), 'utf8'), 'mock-upst-token');
            assert.match(fs.readFileSync(field('key_file'), 'utf8'), /BEGIN PRIVATE KEY/);

            const files = [configPath, field('security_token_file'), field('key_file')];
            handler.cleanupTempFiles();
            for (const f of files) assert.strictEqual(fs.existsSync(f), false, `${f} must be removed`);
            assert.strictEqual(fs.existsSync(home), false, 'the per-run home directory must be removed');
        });
    });

    describe('state commands (configureBackendCredentials)', () => {
        it('uses the backend connection when the step names one', async () => {
            Object.assign(inputs, { provider: 'oci', environmentServiceNameOCI: 'OCI-Provider' });
            await new TerraformCommandHandlerOCI().configureBackendCredentials();
            assert.strictEqual(process.env['OCI_user_ocid'], 'ocid1.user.oc1..backend');
        });

        it('falls back to the provider identity on a same-cloud step that names no backend connection', async () => {
            inputs = {
                provider: 'oci',
                environmentServiceNameOCI: 'OCI-Provider',
                environmentAuthSchemeOCI: 'WorkloadIdentityFederation',
                ociWifTenancyOcid: 'ocid1.tenancy.oc1..dummy',
                ociWifRegion: 'us-ashburn-1',
                ociWifIdentityDomainUrl: WIF_DOMAIN,
                ociWifClientId: 'provider-client-id',
            };
            await new TerraformCommandHandlerOCI().configureBackendCredentials();
            assert.deepStrictEqual(mintedFor, ['OCI-Provider']);
            assert.strictEqual(process.env['OCI_auth'], 'SecurityToken');
            assert.strictEqual(process.env['OCI_region'], 'us-ashburn-1');
        });

        it('requires backendServiceOCI when the provider is another cloud', async () => {
            inputs = { provider: 'aws' };
            await assert.rejects(
                () => new TerraformCommandHandlerOCI().configureBackendCredentials(),
                /backendServiceOCI/,
            );
        });

        it('the provider pass that follows does not replace the backend identity', async () => {
            Object.assign(inputs, { provider: 'oci', environmentServiceNameOCI: 'OCI-Provider' });
            const backend = new TerraformCommandHandlerOCI();
            await backend.configureBackendCredentials();
            const provider = new TerraformCommandHandlerOCI();
            await provider.handleProvider(new TerraformAuthorizationCommandInitializer('plan', 'DummyWorkingDirectory', 'OCI-Provider'));

            assert.strictEqual(process.env['TF_VAR_user_ocid'], 'ocid1.user.oc1..provider');
            assert.strictEqual(process.env['OCI_user_ocid'], 'ocid1.user.oc1..backend',
                'the backend reads OCI_*, which the provider pass must leave alone');
            backend.cleanupTempFiles();
            provider.cleanupTempFiles();
        });
    });
});
