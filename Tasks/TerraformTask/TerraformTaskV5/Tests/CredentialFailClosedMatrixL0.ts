import * as assert from 'assert';
import * as crypto from 'crypto';
import * as path from 'path';
import { execFileSync } from 'child_process';
import tasks = require('azure-pipelines-task-lib/task');
import idTokenGeneratorModule = require('@4cloudguru/pipeline-task-ado');
import ociTokenExchangeModule = require('../src/oci-token-exchange');
import { TerraformCommandHandlerAzureRM } from '../src/azure-terraform-command-handler';
import { TerraformCommandHandlerAWS } from '../src/aws-terraform-command-handler';
import { TerraformCommandHandlerGCP } from '../src/gcp-terraform-command-handler';
import { TerraformCommandHandlerOCI } from '../src/oci-terraform-command-handler';
import { TerraformCommandHandlerHCP } from '../src/hcp-terraform-command-handler';
import { TerraformCommandHandlerGeneric } from '../src/generic-terraform-command-handler';
import { BaseTerraformCommandHandler } from '../src/base-terraform-command-handler';
import { TempFileManager } from '../src/temp-file-manager';
import { TerraformAuthorizationCommandInitializer } from '../src/terraform-commands';
import { EnvironmentVariableHelper } from '@4cloudguru/pipeline-task-ado';

/**
 * THE CLASS TEST for the provider-auth fail-open defect class
 * (#97 and its terraform-side siblings of packer #187/#194/#199/#197).
 *
 * Its rows ARE the cells of the (handler x auth-branch x required-field) matrix
 * that `scripts/auth-parity-matrix.cjs` enumerates -- not the individual call
 * sites named in the issues. #97 reopened in the sibling packer extension
 * because its first fix hardened one branch of one file and its test asserted
 * that one branch; the WIF branch of the same file stayed fail-open and stayed
 * green. When that class was re-enumerated here, THIS repo turned out to still
 * carry the original defect verbatim: `mapAuthorizationScheme` defaulted an
 * absent authorization scheme to Workload Identity Federation with a warning,
 * and both Azure credential getters read `serviceprincipalid`/
 * `serviceprincipalkey` as optional behind a `!`.
 *
 * Each row is mutation-provable: invert the predicate of the guard the row names
 * and the row turns RED, because the row asserts the REJECTION, not the happy
 * path. The `complete` control row per branch proves the guards do not simply
 * reject everything.
 */
describe('credential fail-closed matrix (handler x auth-branch x required-field)', function () {
    this.timeout(20000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
    const t = tasks as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const itg = idTokenGeneratorModule as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ote = ociTokenExchangeModule as any;

    const orig = {
        debug: t.debug,
        warning: t.warning,
        setSecret: t.setSecret,
        getInput: t.getInput,
        getBoolInput: t.getBoolInput,
        getVariable: t.getVariable,
        getEndpointAuthorizationParameter: t.getEndpointAuthorizationParameter,
        getEndpointAuthorizationScheme: t.getEndpointAuthorizationScheme,
        getEndpointDataParameter: t.getEndpointDataParameter,
        getEndpointUrl: t.getEndpointUrl,
        generateIdToken: itg.generateIdToken,
        exchangeOidcForUpst: ote.exchangeOidcForUpst,
    };

    /** A real RSA key: the OCI/GCP handlers run normalizePem for real. */
    const { privateKey: REAL_PEM } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    interface Fixture {
        inputs?: Record<string, string>;
        bools?: Record<string, boolean>;
        vars?: Record<string, string>;
        auth?: Record<string, string>;
        data?: Record<string, string>;
        scheme?: string;
        /** Pre-existing agent environment for the neutralization rows. */
        env?: Record<string, string>;
        serviceConnection?: string;
    }

    const touchedEnv = new Set<string>();

    function install(fixture: Fixture): void {
        t.debug = () => { /* silence */ };
        t.warning = () => { /* silence */ };
        t.setSecret = () => { /* no-op: masking has its own tests */ };
        t.getInput = (name: string, required?: boolean) => {
            const v = fixture.inputs?.[name];
            if (required && !v) throw new Error(`Input required: ${name}`);
            return v;
        };
        t.getBoolInput = (name: string) => fixture.bools?.[name] ?? false;
        t.getVariable = (name: string) => fixture.vars?.[name];
        t.getEndpointAuthorizationParameter = (id: string, key: string, optional: boolean) => {
            // The WIF token-refresh path reads the pipeline's own access token
            // from SystemVssConnection, not from the provider connection.
            const v = id === 'SystemVssConnection' && key === 'AccessToken'
                ? 'system-vss-access-token'
                : fixture.auth?.[key];
            if (!optional && !v) throw new Error(`LIB_EndpointAuthNotExist: ${key}`);
            return v;
        };
        t.getEndpointAuthorizationScheme = (_id: string, optional: boolean) => {
            const v = fixture.scheme;
            if (!optional && !v) throw new Error('LIB_EndpointAuthNotExist: scheme');
            return v;
        };
        t.getEndpointDataParameter = (_id: string, key: string, optional: boolean) => {
            const v = fixture.data?.[key];
            if (!optional && !v) throw new Error(`LIB_EndpointDataNotExist: ${key}`);
            return v;
        };
        t.getEndpointUrl = (_id: string, optional: boolean) => {
            if (!optional) throw new Error('LIB_EndpointNotExist');
            return undefined;
        };
        itg.generateIdToken = async () => 'mock-oidc-jwt-for-matrix';
        ote.exchangeOidcForUpst = async () => 'mock-upst-for-matrix';
        installEndpointDataEnvironment(fixture);
        for (const [k, v] of Object.entries(fixture.env ?? {})) {
            process.env[k] = v;
            touchedEnv.add(k);
        }
    }

    /**
     * Provisions the REAL `ENDPOINT_DATA_<id>_<KEY>` channel the agent sets, in
     * addition to the `getEndpointDataParameter` stub above.
     *
     * A data-family SECRET is deliberately not read through
     * `tasks.getEndpointDataParameter` -- that accessor debug-logs the value at
     * read time and leaves `ENDPOINT_DATA_*` in `process.env` for the terraform
     * child, so `requireSecretField(..., { source: 'data' })` routes through
     * `readSecretEndpointDataParameter`, which reads this variable directly
     * (src/endpoint-data-secret.ts). Stubbing only the accessor would make the
     * `complete` control row for such a branch fail for the wrong reason and
     * would let its reject row pass without ever exercising the guard, so the
     * fixture has to deliver the value the way the agent does.
     *
     * Mirrored under every endpoint id the fixture names -- the real agent sets
     * these for every service connection referenced by the job -- so the next
     * handler that gains a data-family secret inherits the channel.
     */
    function installEndpointDataEnvironment(fixture: Fixture): void {
        const ids = new Set<string>();
        if (fixture.serviceConnection) ids.add(fixture.serviceConnection);
        for (const [name, value] of Object.entries(fixture.inputs ?? {})) {
            if (/^(environmentServiceName|backendService)/.test(name) && value) ids.add(value);
        }
        for (const id of ids) {
            for (const [key, value] of Object.entries(fixture.data ?? {})) {
                // task-lib's own derivation: the id verbatim, the key upper-cased.
                const name = `ENDPOINT_DATA_${id}_${key.toUpperCase()}`;
                process.env[name] = value;
                touchedEnv.add(name);
            }
        }
    }

    afterEach(() => {
        Object.assign(t, {
            debug: orig.debug,
            warning: orig.warning,
            setSecret: orig.setSecret,
            getInput: orig.getInput,
            getBoolInput: orig.getBoolInput,
            getVariable: orig.getVariable,
            getEndpointAuthorizationParameter: orig.getEndpointAuthorizationParameter,
            getEndpointAuthorizationScheme: orig.getEndpointAuthorizationScheme,
            getEndpointDataParameter: orig.getEndpointDataParameter,
            getEndpointUrl: orig.getEndpointUrl,
        });
        itg.generateIdToken = orig.generateIdToken;
        ote.exchangeOidcForUpst = orig.exchangeOidcForUpst;
        EnvironmentVariableHelper.clearTrackedVariables();
        for (const k of touchedEnv) delete process.env[k];
        touchedEnv.clear();
    });

    // --- complete, valid fixtures: one per (handler, auth-branch) -------------

    const AZURE_COMMON = {
        auth: {
            serviceprincipalid: 'e7a1b2c3-0000-4444-8888-99990000aaaa',
            serviceprincipalkey: 'sp-secret-value',
            tenantid: '11112222-3333-4444-5555-666677778888',
        },
        data: { subscriptionid: 'aaaabbbb-cccc-dddd-eeee-ffff00001111' },
    };

    const COMPLETE: Record<string, Fixture> = {
        'azurerm.WorkloadIdentityFederation': {
            inputs: { environmentServiceNameAzureRM: 'AzureRM' },
            scheme: 'WorkloadIdentityFederation',
            ...AZURE_COMMON,
        },
        'azurerm.ServicePrincipal': {
            inputs: { environmentServiceNameAzureRM: 'AzureRM' },
            scheme: 'ServicePrincipal',
            ...AZURE_COMMON,
        },
        'azurerm.ManagedServiceIdentity': {
            inputs: { environmentServiceNameAzureRM: 'AzureRM' },
            scheme: 'ManagedServiceIdentity',
            auth: { tenantid: '11112222-3333-4444-5555-666677778888' },
            data: { subscriptionid: 'aaaabbbb-cccc-dddd-eeee-ffff00001111' },
        },
        'aws.static': {
            serviceConnection: 'AWS',
            inputs: {},
            auth: { username: 'AKIAEXAMPLEKEYID', password: 'example-secret-access-key' },
        },
        'aws.WorkloadIdentityFederation': {
            serviceConnection: 'AWS',
            inputs: {
                environmentAuthSchemeAWS: 'WorkloadIdentityFederation',
                awsRoleArn: 'arn:aws:iam::123456789012:role/terraform',
                awsRegion: 'us-east-1',
            },
            vars: { 'System.TeamProject': 'Contoso Infra', 'Build.BuildId': '4242' },
        },
        'aws.backendStatic': {
            serviceConnection: 'AWS',
            inputs: { backendServiceAWS: 'AWS' },
            auth: { username: 'AKIAEXAMPLEKEYID', password: 'example-secret-access-key', region: 'us-east-1' },
        },
        'aws.backendWIF': {
            serviceConnection: 'AWS',
            inputs: {
                backendServiceAWS: 'AWS',
                backendAuthSchemeAWS: 'WorkloadIdentityFederation',
                backendAWSRoleArn: 'arn:aws:iam::123456789012:role/terraform-backend',
                backendAWSRegion: 'us-east-1',
            },
            vars: { 'System.TeamProject': 'Contoso Infra', 'Build.BuildId': '4242' },
        },
        'gcp.static': {
            serviceConnection: 'GCP',
            inputs: {},
            auth: {
                Issuer: 'terraform@example.iam.gserviceaccount.com',
                Audience: 'https://oauth2.googleapis.com/token',
                PrivateKey: REAL_PEM as string,
            },
            data: { project: 'example-project' },
        },
        'gcp.WorkloadIdentityFederation': {
            serviceConnection: 'GCP',
            inputs: {
                environmentAuthSchemeGCP: 'WorkloadIdentityFederation',
                gcpProjectNumber: '123456789012',
                gcpWorkloadIdentityPoolId: 'ado-pool',
                gcpWorkloadIdentityProviderId: 'ado-provider',
                gcpServiceAccountEmail: 'terraform@example.iam.gserviceaccount.com',
            },
        },
        'oci.static': {
            serviceConnection: 'OCI',
            inputs: {},
            data: {
                privateKey: (REAL_PEM as string).replace(/\n/g, ' ').trim(),
                tenancy: 'ocid1.tenancy.oc1..aaaaaaaaexampletenancyocid',
                user: 'ocid1.user.oc1..aaaaaaaaexampleuserocid',
                region: 'us-ashburn-1',
                fingerprint: 'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99',
            },
        },
        'oci.WorkloadIdentityFederation': {
            serviceConnection: 'OCI',
            inputs: {
                environmentAuthSchemeOCI: 'WorkloadIdentityFederation',
                ociWifIdentityDomainUrl: 'https://idcs-dummy.identity.oraclecloud.com',
                ociWifClientId: 'dummy-client-id',
                ociWifTenancyOcid: 'ocid1.tenancy.oc1..aaaaaaaaexampletenancyocid',
                ociWifRegion: 'us-ashburn-1',
            },
        },
        'hcp.backend': { inputs: { backendHCPToken: 'hcp-token-value' } },
        'generic.provider': { inputs: {} },
    };

    function clone(base: string | Fixture): Fixture {
        const source = typeof base === 'string' ? COMPLETE[base] : base;
        return JSON.parse(JSON.stringify(source)) as Fixture;
    }

    function makeHandler(handler: string): BaseTerraformCommandHandler {
        switch (handler) {
            case 'azurerm': return new TerraformCommandHandlerAzureRM();
            case 'aws': return new TerraformCommandHandlerAWS();
            case 'gcp': return new TerraformCommandHandlerGCP();
            case 'oci': return new TerraformCommandHandlerOCI();
            case 'hcp': return new TerraformCommandHandlerHCP();
            case 'generic': return new TerraformCommandHandlerGeneric();
            default: throw new Error(`unknown handler ${handler}`);
        }
    }

    /** `provider` exercises handleProvider; `backend` exercises configureBackendCredentials. */
    type Entry = 'provider' | 'backend';

    async function run(handler: string, fixture: Fixture, entry: Entry = 'provider'): Promise<BaseTerraformCommandHandler> {
        const impl = makeHandler(handler);
        install(fixture);
        try {
            if (entry === 'backend') {
                await impl.configureBackendCredentials();
            } else {
                await impl.handleProvider(
                    new TerraformAuthorizationCommandInitializer('plan', '', fixture.serviceConnection ?? ''));
            }
        } finally {
            // Drops tracking without deleting anything, as the previous `tempFiles = []`
            // did -- these fixtures assert on credential handling, not on cleanup.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tempFileManager is protected
            (impl as any).tempFileManager = new TempFileManager();
        }
        return impl;
    }

    /** Removes one field from a complete fixture -- the "absent credential" mutation. */
    function without(base: string, bucket: 'inputs' | 'auth' | 'data' | 'scheme' | 'serviceConnection', key?: string): Fixture {
        const f = clone(base);
        if (bucket === 'scheme' || bucket === 'serviceConnection') delete f[bucket];
        else delete (f[bucket] as Record<string, string>)?.[key!];
        return f;
    }

    /** Replaces one field with an HCL/INI-injecting value -- the "malformed" mutation. */
    function malformed(base: string, bucket: 'inputs' | 'auth' | 'data', key: string): Fixture {
        const f = clone(base);
        (f[bucket] as Record<string, string>)[key] = '${file("/etc/passwd")}';
        return f;
    }

    // --- ROWS: every required field of every branch must fail closed ----------

    interface Row { site: string; handler: string; entry?: Entry; fixture: () => Fixture }

    const REJECT_ROWS: Row[] = [
        // #97, still present verbatim in THIS repo before this change.
        { site: 'azurerm.schemeResolution.authorizationScheme', handler: 'azurerm', fixture: () => without('azurerm.WorkloadIdentityFederation', 'scheme') },
        { site: 'azurerm.WorkloadIdentityFederation.serviceprincipalid', handler: 'azurerm', fixture: () => without('azurerm.WorkloadIdentityFederation', 'auth', 'serviceprincipalid') },
        { site: 'azurerm.WorkloadIdentityFederation.tenantid', handler: 'azurerm', fixture: () => without('azurerm.WorkloadIdentityFederation', 'auth', 'tenantid') },
        { site: 'azurerm.ServicePrincipal.serviceprincipalid', handler: 'azurerm', fixture: () => without('azurerm.ServicePrincipal', 'auth', 'serviceprincipalid') },
        { site: 'azurerm.ServicePrincipal.serviceprincipalkey', handler: 'azurerm', fixture: () => without('azurerm.ServicePrincipal', 'auth', 'serviceprincipalkey') },
        { site: 'azurerm.ManagedServiceIdentity.tenantid', handler: 'azurerm', fixture: () => without('azurerm.ManagedServiceIdentity', 'auth', 'tenantid') },
        // The same guards must hold on the BACKEND entry point, not just the provider one.
        { site: 'azurerm.backend.schemeResolution.authorizationScheme', handler: 'azurerm', entry: 'backend', fixture: () => ({ ...without('azurerm.WorkloadIdentityFederation', 'scheme'), inputs: { backendServiceArm: 'AzureRM' } }) },
        { site: 'azurerm.backend.WorkloadIdentityFederation.serviceprincipalid', handler: 'azurerm', entry: 'backend', fixture: () => ({ ...without('azurerm.WorkloadIdentityFederation', 'auth', 'serviceprincipalid'), inputs: { backendServiceArm: 'AzureRM' } }) },
        // #199 -- value validation, not just presence.
        { site: 'azurerm.WorkloadIdentityFederation.serviceprincipalid[malformed]', handler: 'azurerm', fixture: () => malformed('azurerm.WorkloadIdentityFederation', 'auth', 'serviceprincipalid') },
        { site: 'azurerm.WorkloadIdentityFederation.tenantid[malformed]', handler: 'azurerm', fixture: () => malformed('azurerm.WorkloadIdentityFederation', 'auth', 'tenantid') },
        { site: 'azurerm.handleProvider.subscriptionid[malformed]', handler: 'azurerm', fixture: () => malformed('azurerm.ServicePrincipal', 'data', 'subscriptionid') },

        { site: 'aws.static.serviceConnection', handler: 'aws', fixture: () => without('aws.static', 'serviceConnection') },
        { site: 'aws.static.username', handler: 'aws', fixture: () => without('aws.static', 'auth', 'username') },
        { site: 'aws.static.password', handler: 'aws', fixture: () => without('aws.static', 'auth', 'password') },
        { site: 'aws.static.username[malformed]', handler: 'aws', fixture: () => malformed('aws.static', 'auth', 'username') },
        { site: 'aws.WorkloadIdentityFederation.serviceConnection', handler: 'aws', fixture: () => without('aws.WorkloadIdentityFederation', 'serviceConnection') },
        { site: 'aws.WorkloadIdentityFederation.awsRoleArn', handler: 'aws', fixture: () => without('aws.WorkloadIdentityFederation', 'inputs', 'awsRoleArn') },
        { site: 'aws.WorkloadIdentityFederation.awsRegion', handler: 'aws', fixture: () => without('aws.WorkloadIdentityFederation', 'inputs', 'awsRegion') },
        { site: 'aws.WorkloadIdentityFederation.awsRoleArn[malformed]', handler: 'aws', fixture: () => malformed('aws.WorkloadIdentityFederation', 'inputs', 'awsRoleArn') },
        { site: 'aws.backendStatic.username', handler: 'aws', entry: 'backend', fixture: () => without('aws.backendStatic', 'auth', 'username') },
        { site: 'aws.backendStatic.password', handler: 'aws', entry: 'backend', fixture: () => without('aws.backendStatic', 'auth', 'password') },
        // #197 -- an explicit session name outside AWS's grammar must fail here.
        {
            site: 'aws.WorkloadIdentityFederation.roleSessionName[malformed]', handler: 'aws', fixture: () => {
                const f = clone('aws.WorkloadIdentityFederation');
                f.inputs!.awsSessionName = 'not a valid session name!';
                return f;
            }
        },
        {
            site: 'aws.backendWIF.roleSessionName[malformed]', handler: 'aws', entry: 'backend', fixture: () => {
                const f = clone('aws.backendWIF');
                f.inputs!.backendAWSSessionName = 'not a valid session name!';
                return f;
            }
        },

        { site: 'gcp.static.serviceConnection', handler: 'gcp', fixture: () => without('gcp.static', 'serviceConnection') },
        { site: 'gcp.static.Issuer', handler: 'gcp', fixture: () => without('gcp.static', 'auth', 'Issuer') },
        { site: 'gcp.static.Audience', handler: 'gcp', fixture: () => without('gcp.static', 'auth', 'Audience') },
        { site: 'gcp.static.PrivateKey', handler: 'gcp', fixture: () => without('gcp.static', 'auth', 'PrivateKey') },
        { site: 'gcp.static.project', handler: 'gcp', fixture: () => without('gcp.static', 'data', 'project') },
        { site: 'gcp.static.project[malformed]', handler: 'gcp', fixture: () => malformed('gcp.static', 'data', 'project') },
        {
            site: 'gcp.static.Audience[foreign-origin]', handler: 'gcp', fixture: () => {
                const f = clone('gcp.static');
                f.auth!.Audience = 'https://attacker.example.com/token';
                return f;
            }
        },
        { site: 'gcp.WorkloadIdentityFederation.serviceConnection', handler: 'gcp', fixture: () => without('gcp.WorkloadIdentityFederation', 'serviceConnection') },
        { site: 'gcp.WorkloadIdentityFederation.gcpProjectNumber', handler: 'gcp', fixture: () => without('gcp.WorkloadIdentityFederation', 'inputs', 'gcpProjectNumber') },
        { site: 'gcp.WorkloadIdentityFederation.gcpServiceAccountEmail[malformed]', handler: 'gcp', fixture: () => malformed('gcp.WorkloadIdentityFederation', 'inputs', 'gcpServiceAccountEmail') },

        { site: 'oci.static.serviceConnection', handler: 'oci', fixture: () => without('oci.static', 'serviceConnection') },
        { site: 'oci.static.privateKey', handler: 'oci', fixture: () => without('oci.static', 'data', 'privateKey') },
        { site: 'oci.static.tenancy', handler: 'oci', fixture: () => without('oci.static', 'data', 'tenancy') },
        { site: 'oci.static.user', handler: 'oci', fixture: () => without('oci.static', 'data', 'user') },
        { site: 'oci.static.region', handler: 'oci', fixture: () => without('oci.static', 'data', 'region') },
        { site: 'oci.static.fingerprint', handler: 'oci', fixture: () => without('oci.static', 'data', 'fingerprint') },
        { site: 'oci.static.tenancy[malformed]', handler: 'oci', fixture: () => malformed('oci.static', 'data', 'tenancy') },
        { site: 'oci.WorkloadIdentityFederation.serviceConnection', handler: 'oci', fixture: () => without('oci.WorkloadIdentityFederation', 'serviceConnection') },
    ];

    for (const row of REJECT_ROWS) {
        it(`fails closed: ${row.site}`, async () => {
            await assert.rejects(
                () => run(row.handler, row.fixture(), row.entry),
                `${row.site}: an absent or malformed credential field must fail the task, not degrade to ambient credentials`);
        });
    }

    // --- CONTROL ROWS: the guards must accept a complete configuration --------

    const ACCEPT_ROWS: Row[] = [
        { site: 'azurerm.WorkloadIdentityFederation.complete', handler: 'azurerm', fixture: () => clone('azurerm.WorkloadIdentityFederation') },
        { site: 'azurerm.ServicePrincipal.complete', handler: 'azurerm', fixture: () => clone('azurerm.ServicePrincipal') },
        { site: 'azurerm.ManagedServiceIdentity.complete', handler: 'azurerm', fixture: () => clone('azurerm.ManagedServiceIdentity') },
        // The one designed-optional identity read in the matrix: an MSI-scheme
        // connection with a BLANK service principal id means "system-assigned",
        // which must keep working.
        { site: 'azurerm.ManagedServiceIdentity.serviceprincipalid[exempt-optional]', handler: 'azurerm', fixture: () => without('azurerm.ManagedServiceIdentity', 'auth', 'serviceprincipalid') },
        { site: 'aws.static.complete', handler: 'aws', fixture: () => clone('aws.static') },
        { site: 'aws.WorkloadIdentityFederation.complete', handler: 'aws', fixture: () => clone('aws.WorkloadIdentityFederation') },
        { site: 'aws.backendStatic.complete', handler: 'aws', entry: 'backend', fixture: () => clone('aws.backendStatic') },
        { site: 'aws.backendWIF.complete', handler: 'aws', entry: 'backend', fixture: () => clone('aws.backendWIF') },
        { site: 'gcp.static.complete', handler: 'gcp', fixture: () => clone('gcp.static') },
        { site: 'gcp.WorkloadIdentityFederation.complete', handler: 'gcp', fixture: () => clone('gcp.WorkloadIdentityFederation') },
        { site: 'oci.static.complete', handler: 'oci', fixture: () => clone('oci.static') },
        // The code-verified exemptions: neither handler has a cloud identity.
        { site: 'hcp.handleProvider.no-credentials[exempt]', handler: 'hcp', fixture: () => clone('hcp.backend') },
        { site: 'generic.handleProvider.no-credentials[exempt]', handler: 'generic', fixture: () => clone('generic.provider') },
    ];

    for (const row of ACCEPT_ROWS) {
        it(`accepts a complete configuration: ${row.site}`, async () => {
            await run(row.handler, row.fixture(), row.entry);
        });
    }

    // --- NEUTRALIZATION ROWS (#187) ------------------------------------------

    const NEUTRALIZE_ROWS: Array<{ site: string; handler: string; base: string; entry?: Entry; competing: string[] }> = [
        {
            site: 'aws.WorkloadIdentityFederation.competing-credential-env', handler: 'aws', base: 'aws.WorkloadIdentityFederation',
            competing: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_SHARED_CREDENTIALS_FILE'],
        },
        {
            site: 'aws.backendWIF.competing-credential-env', handler: 'aws', base: 'aws.backendWIF', entry: 'backend',
            competing: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'],
        },
        {
            site: 'aws.static.competing-credential-env', handler: 'aws', base: 'aws.static',
            competing: ['AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN', 'AWS_SESSION_TOKEN'],
        },
        {
            // ARM_USE_MSI only reaches the agent identity while these are absent.
            site: 'azurerm.ManagedServiceIdentity.competing-credential-env', handler: 'azurerm', base: 'azurerm.ManagedServiceIdentity',
            competing: ['ARM_CLIENT_SECRET', 'ARM_OIDC_TOKEN', 'ARM_CLIENT_CERTIFICATE_PATH', 'ARM_USE_OIDC', 'ARM_USE_CLI', 'ARM_USE_AKS_WORKLOAD_IDENTITY'],
        },
        {
            // The cell no per-branch list can close: MSI legitimately MAY set
            // ARM_CLIENT_ID (user-assigned), so the wholesale clear at the top of
            // setCommonVariables is what stops an inherited one substituting an
            // identity nobody configured.
            site: 'azurerm.ManagedServiceIdentity.competing-credential-env[ARM_CLIENT_ID]', handler: 'azurerm', base: 'azurerm.ManagedServiceIdentity',
            competing: ['ARM_CLIENT_ID'],
        },
        {
            site: 'azurerm.WorkloadIdentityFederation.competing-credential-env', handler: 'azurerm', base: 'azurerm.WorkloadIdentityFederation',
            competing: ['ARM_CLIENT_SECRET', 'ARM_CLIENT_CERTIFICATE_PATH', 'ARM_USE_MSI', 'ARM_USE_CLI', 'ARM_USE_AKS_WORKLOAD_IDENTITY'],
        },
        {
            site: 'azurerm.ServicePrincipal.competing-credential-env', handler: 'azurerm', base: 'azurerm.ServicePrincipal',
            competing: ['ARM_OIDC_TOKEN', 'ARM_CLIENT_CERTIFICATE_PATH', 'ARM_USE_MSI', 'ARM_USE_OIDC', 'ARM_USE_CLI', 'ARM_USE_AKS_WORKLOAD_IDENTITY'],
        },
        {
            // #1026: azurerm's enableOidc = use_oidc || use_aks_workload_identity,
            // so this flag re-enables OIDC on ITS OWN even with ARM_USE_OIDC absent
            // -- it needs the same wholesale clear ARM_USE_OIDC gets, not just a
            // per-branch mention.
            site: 'azurerm.ManagedServiceIdentity.competing-credential-env[ARM_USE_AKS_WORKLOAD_IDENTITY]', handler: 'azurerm', base: 'azurerm.ManagedServiceIdentity',
            competing: ['ARM_USE_AKS_WORKLOAD_IDENTITY'],
        },
        {
            site: 'gcp.static.competing-credential-env', handler: 'gcp', base: 'gcp.static',
            competing: ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_OAUTH_ACCESS_TOKEN', 'CLOUDSDK_AUTH_ACCESS_TOKEN'],
        },
        {
            site: 'gcp.WorkloadIdentityFederation.competing-credential-env', handler: 'gcp', base: 'gcp.WorkloadIdentityFederation',
            competing: ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_OAUTH_ACCESS_TOKEN'],
        },
        {
            site: 'oci.static.competing-credential-env', handler: 'oci', base: 'oci.static',
            competing: ['OCI_CLI_CONFIG_FILE', 'OCI_CLI_PROFILE', 'OCI_CLI_TENANCY', 'OCI_CLI_KEY_FILE'],
        },
    ];

    for (const row of NEUTRALIZE_ROWS) {
        it(`clears competing identity env vars: ${row.site}`, async () => {
            const fixture = clone(row.base);
            fixture.env = Object.fromEntries(row.competing.map((name) => [name, 'inherited-from-agent']));
            await run(row.handler, fixture, row.entry);
            for (const name of row.competing) {
                assert.strictEqual(process.env[name], undefined,
                    `${row.site}: '${name}' was inherited from the agent and can out-rank the credentials this branch injects; it must be cleared`);
            }
        });
    }

    // #1026: azurerm's OIDC config also has MultiEnvDefaultFunc fallbacks onto
    // ACTIONS_ID_TOKEN_REQUEST_TOKEN/URL, which chain onto SYSTEM_ACCESSTOKEN/
    // SYSTEM_OIDCREQUESTURI -- the agent sets SYSTEM_OIDCREQUESTURI on EVERY job
    // regardless of authorization scheme, so it must not survive into the
    // terraform child's environment for a scheme that never asked for OIDC.
    for (const base of ['azurerm.ManagedServiceIdentity', 'azurerm.ServicePrincipal', 'azurerm.WorkloadIdentityFederation']) {
        it(`clears SYSTEM_ACCESSTOKEN/SYSTEM_OIDCREQUESTURI: ${base}`, async () => {
            const fixture = clone(base);
            fixture.env = { SYSTEM_ACCESSTOKEN: 'agent-oauth-token', SYSTEM_OIDCREQUESTURI: 'https://vstoken.dev.azure.com/oidc' };
            await run('azurerm', fixture);
            assert.strictEqual(process.env['SYSTEM_ACCESSTOKEN'], undefined,
                `${base}: SYSTEM_ACCESSTOKEN is an alternate name azurerm's OIDC config also honors and must not reach the terraform child`);
            assert.strictEqual(process.env['SYSTEM_OIDCREQUESTURI'], undefined,
                `${base}: SYSTEM_OIDCREQUESTURI is set by the agent on every job and must not reach the terraform child`);
        });
    }

    // #1026 REGRESSION GUARD: clearing SYSTEM_OIDCREQUESTURI removed the only
    // name carrying the OIDC request URL, so WIF refresh mode (the DEFAULT --
    // environmentAzureRmUseIdTokenGeneration unset) lost its endpoint and the
    // provider fell through to the Azure CLI authorizer. The rows above can only
    // ever prove the variable is GONE; this one proves the capability that
    // depended on it survives, under a name the task itself owns.
    it('pins ARM_OIDC_REQUEST_URL before clearing SYSTEM_OIDCREQUESTURI: azurerm.WorkloadIdentityFederation', async () => {
        const fixture = clone('azurerm.WorkloadIdentityFederation');
        fixture.env = { SYSTEM_OIDCREQUESTURI: 'https://vstoken.dev.azure.com/oidc' };
        await run('azurerm', fixture);
        assert.strictEqual(process.env['SYSTEM_OIDCREQUESTURI'], undefined,
            'the ambient name must still be cleared (#1026)');
        assert.strictEqual(process.env['ARM_OIDC_REQUEST_URL'], 'https://vstoken.dev.azure.com/oidc',
            'refresh mode must keep an OIDC request endpoint: without it azurerm falls through to the Azure CLI authorizer');
        assert.ok(process.env['ARM_OIDC_REQUEST_TOKEN'],
            'the request token is the other half of the same refresh call and must still be present');
    });

    it('refuses an untrusted SYSTEM_OIDCREQUESTURI host rather than forwarding the job token to it', async () => {
        const fixture = clone('azurerm.WorkloadIdentityFederation');
        fixture.env = { SYSTEM_OIDCREQUESTURI: 'https://evil.example.com/oidc' };
        await assert.rejects(
            () => run('azurerm', fixture),
            /not a recognized Azure DevOps OIDC endpoint/,
            'a non-ADO host must fail closed, not become ARM_OIDC_REQUEST_URL',
        );
    });

    it('leaves ARM_OIDC_REQUEST_URL unset when the agent published no SYSTEM_OIDCREQUESTURI', async () => {
        const fixture = clone('azurerm.WorkloadIdentityFederation');
        await run('azurerm', fixture);
        assert.strictEqual(process.env['ARM_OIDC_REQUEST_URL'], undefined,
            'an absent ambient value must not become an empty or fabricated endpoint');
    });

    // --- SESSION-NAME ROWS (#197) --------------------------------------------

    for (const [site, handler, entry, prefix] of [
        ['aws.WorkloadIdentityFederation.roleSessionName', 'aws', 'provider', 'ado-tf'],
        ['aws.backendWIF.roleSessionName', 'aws', 'backend', 'ado-tf-backend'],
    ] as Array<[string, string, Entry, string]>) {
        it(`derives a per-run role session name instead of a shared constant: ${site}`, async () => {
            await run(handler, clone(entry === 'backend' ? 'aws.backendWIF' : 'aws.WorkloadIdentityFederation'), entry);
            const sessionName = process.env['AWS_ROLE_SESSION_NAME'];
            assert.ok(sessionName, 'AWS_ROLE_SESSION_NAME must be set on the WIF path');
            assert.ok(!/^AzureDevOps-Terraform(-Backend)?$/.test(sessionName!),
                'a fixed constant collapses CloudTrail attribution across every federated run of every pipeline');
            assert.ok(sessionName!.startsWith(prefix), `expected the ${entry} prefix '${prefix}'; got '${sessionName}'`);
            assert.ok(sessionName!.includes('4242'),
                `the session name must identify the run (CloudTrail userIdentity.arn pivot); got '${sessionName}'`);
            assert.ok(/^[\w+=,.@-]{2,64}$/.test(sessionName!),
                `the session name must satisfy AWS's RoleSessionName grammar; got '${sessionName}'`);
        });
    }

    // --- STRUCTURAL ROW: the matrix itself must have no unguarded cell --------
    // This is what keeps the table above honest: a NEW handler, or a new branch
    // in an existing one, appears as a new matrix cell and fails here until it
    // is guarded or carries a code-verified @credential-exempt marker.

    it('scripts/auth-parity-matrix.cjs reports zero UNGUARDED cells', () => {
        const script = path.resolve(__dirname, '../../../../scripts/auth-parity-matrix.cjs');
        const repoRoot = path.resolve(__dirname, '../../../..');
        const out = execFileSync(process.execPath, [script, repoRoot, '--json'], { encoding: 'utf8' });
        const report = JSON.parse(out) as {
            cells: Array<{ site: string; verdict: string; detail: string }>;
            unguarded: number;
        };
        assert.ok(report.cells.length > 0, 'the signature must enumerate at least one cell');
        assert.strictEqual(report.unguarded, 0,
            'unguarded credential cells: ' + report.cells.filter((c) => c.verdict === 'UNGUARDED')
                .map((c) => `${c.site} (${c.detail})`).join('; '));
    });
});
