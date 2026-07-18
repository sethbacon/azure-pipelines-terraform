import * as assert from 'assert';
import * as fs from 'fs';
import tasks = require('azure-pipelines-task-lib/task');
import { TerraformCommandHandlerGCP } from '../src/gcp-terraform-command-handler';
import { EnvironmentVariableHelper } from '../src/environment-variables';
import { TEST_GCP_PRIVATE_KEY_PEM } from './test-gcp-fixtures';

/**
 * Direct unit tests for the GCP static-key token_uri validation (#494, #594):
 * the service connection's "Audience" field is written into the credentials
 * file as `token_uri` -- the URL the Google SDK POSTs the service-account-signed
 * JWT assertion to -- so it must be an https:// Google token endpoint, and
 * exactly one of the two hosts this task actually uses: oauth2.googleapis.com
 * or sts.googleapis.com (mirroring the WIF path's hardcoded
 * https://sts.googleapis.com/v1/token). Every other *.googleapis.com
 * subdomain is rejected (#594 narrowed the allowlist from the whole
 * *.googleapis.com namespace down to these two exact endpoints).
 */
describe('GCP static-key token_uri validation (#494)', function () {
    const originalGetInput = tasks.getInput;
    const originalGetEndpointAuthorizationParameter = tasks.getEndpointAuthorizationParameter;
    const originalSetSecret = tasks.setSecret;
    const originalLoc = tasks.loc;

    let audienceValue: string;

    beforeEach(() => {
        audienceValue = 'https://oauth2.googleapis.com/token';
        // monkeypatch the shared task-lib module
        const t = tasks as any;
        t.getInput = (name: string) => {
            if (name === 'backendServiceGCP') return 'GCP-Backend';
            if (name === 'backendAuthSchemeGCP') return undefined; // defaults to ServiceConnection
            return undefined;
        };
        t.setSecret = () => { /* no-op */ };
        t.loc = (key: string) => key;
        t.getEndpointAuthorizationParameter = (_id: string, name: string) => {
            if (name === 'Issuer') return 'sa@project.iam.gserviceaccount.com';
            if (name === 'Audience') return audienceValue;
            if (name === 'PrivateKey') return TEST_GCP_PRIVATE_KEY_PEM;
            return undefined;
        };
    });

    afterEach(() => {
        // restore the shared task-lib module
        const t = tasks as any;
        t.getInput = originalGetInput;
        t.getEndpointAuthorizationParameter = originalGetEndpointAuthorizationParameter;
        t.setSecret = originalSetSecret;
        t.loc = originalLoc;
        EnvironmentVariableHelper.clearTrackedVariables();
    });

    async function runStaticKeyPath(): Promise<TerraformCommandHandlerGCP> {
        const handler = new TerraformCommandHandlerGCP();
        await handler.configureBackendCredentials();
        return handler;
    }

    it('accepts the canonical https://oauth2.googleapis.com token endpoint', async () => {
        const handler = await runStaticKeyPath();
        const credsPath = process.env['GOOGLE_BACKEND_CREDENTIALS']!;
        const written = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
        assert.strictEqual(written.token_uri, 'https://oauth2.googleapis.com/token');
        // test-only access to the protected cleanup
        (handler as any).cleanupTempFiles();
    });

    it('accepts the other allowed host, sts.googleapis.com', async () => {
        audienceValue = 'https://sts.googleapis.com/v1/token';
        const handler = await runStaticKeyPath();
        const credsPath = process.env['GOOGLE_BACKEND_CREDENTIALS']!;
        const written = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
        assert.strictEqual(written.token_uri, 'https://sts.googleapis.com/v1/token');
        // test-only access to the protected cleanup
        (handler as any).cleanupTempFiles();
    });

    it('rejects a non-Google host', async () => {
        audienceValue = 'https://attacker.example/token';
        await assert.rejects(runStaticKeyPath(), /GcpTokenUriNotAllowed/);
    });

    it('rejects a lookalike host that merely ends in googleapis.com without the dot boundary', async () => {
        audienceValue = 'https://evilgoogleapis.com/token';
        await assert.rejects(runStaticKeyPath(), /GcpTokenUriNotAllowed/);
    });

    it('rejects a real but non-allowlisted *.googleapis.com subdomain (#594 narrowing)', async () => {
        audienceValue = 'https://iamcredentials.googleapis.com/v1/token';
        await assert.rejects(runStaticKeyPath(), /GcpTokenUriNotAllowed/);
    });

    it('rejects a non-https scheme even on a Google host', async () => {
        audienceValue = 'http://oauth2.googleapis.com/token';
        await assert.rejects(runStaticKeyPath(), /GcpTokenUriNotAllowed/);
    });

    it('rejects a value that is not a URL at all', async () => {
        audienceValue = 'DummyAudience';
        await assert.rejects(runStaticKeyPath(), /GcpTokenUriNotAllowed/);
    });
});
