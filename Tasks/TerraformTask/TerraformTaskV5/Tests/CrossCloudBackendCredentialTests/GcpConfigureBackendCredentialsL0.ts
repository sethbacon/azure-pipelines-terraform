import * as assert from 'assert';
import * as fs from 'fs';
import tasks = require('azure-pipelines-task-lib/task');
import { TerraformCommandHandlerGCP } from '../../src/gcp-terraform-command-handler';
import { EnvironmentVariableHelper } from '@4cloudguru/pipeline-task-ado';
import * as idTokenGenerator from '@4cloudguru/pipeline-task-ado';
import { TEST_GCP_PRIVATE_KEY_PEM } from '../test-gcp-fixtures';

/**
 * Direct unit tests for the GCP handler's cross-cloud
 * `configureBackendCredentials()`, and a regression guard for the GCS
 * credentials-caching fix: credentials must be supplied via the
 * `GOOGLE_BACKEND_CREDENTIALS` environment variable only, never via a cached
 * `-backend-config=credentials=<path>` (which HashiCorp's own precedence
 * rules make override the environment variable, and which goes stale the
 * moment this task's temp file is cleaned up).
 */
describe('TerraformCommandHandlerGCP.configureBackendCredentials (cross-cloud)', function () {
  const originalGetInput = tasks.getInput;
  const originalGetEndpointAuthorizationParameter = tasks.getEndpointAuthorizationParameter;
  const originalSetSecret = tasks.setSecret;
  const originalGenerateIdToken = idTokenGenerator.generateIdToken;

  afterEach(() => {
    (tasks as any).getInput = originalGetInput;
    (tasks as any).getEndpointAuthorizationParameter = originalGetEndpointAuthorizationParameter;
    (tasks as any).setSecret = originalSetSecret;
    (idTokenGenerator as any).generateIdToken = originalGenerateIdToken;
    EnvironmentVariableHelper.clearTrackedVariables();
  });

  it('ServiceConnection (static JSON key): sets GOOGLE_BACKEND_CREDENTIALS to a fresh service_account credentials file, masking the key per-line', async () => {
    const maskedValues: string[] = [];
    (tasks as any).getInput = (name: string) => {
      if (name === 'backendServiceGCP') return 'GCP-Backend';
      if (name === 'backendAuthSchemeGCP') return undefined; // defaults to ServiceConnection
      return undefined;
    };
    (tasks as any).setSecret = (v: string) => { maskedValues.push(v); };
    (tasks as any).getEndpointAuthorizationParameter = (_id: string, name: string) => {
      if (name === 'Issuer') return 'sa@project.iam.gserviceaccount.com';
      if (name === 'Audience') return 'https://oauth2.googleapis.com/token';
      if (name === 'PrivateKey') return TEST_GCP_PRIVATE_KEY_PEM;
      return undefined;
    };

    const handler = new TerraformCommandHandlerGCP();
    await handler.configureBackendCredentials();

    const credsPath = process.env['GOOGLE_BACKEND_CREDENTIALS']!;
    assert.ok(credsPath, 'GOOGLE_BACKEND_CREDENTIALS should be set');
    const written = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    assert.strictEqual(written.type, 'service_account');
    assert.strictEqual(written.client_email, 'sa@project.iam.gserviceaccount.com');
    // The credentials file stores the normalized (re-wrapped) form, not the
    // raw input -- and every non-boundary line of it must have been
    // individually registered as a secret (#351), since ADO's log masker
    // matches per line, not across embedded newlines.
    const normalizedBodyLines = written.private_key
      .split('\n')
      .map((l: string) => l.trim())
      .filter((l: string) => l && !l.startsWith('-----'));
    for (const line of normalizedBodyLines) {
      assert.ok(maskedValues.includes(line), `normalized PEM line should be masked: ${line}`);
    }
    assert.ok(maskedValues.length > normalizedBodyLines.length, 'raw form should also have been masked, on top of the normalized lines');

    (handler as any).cleanupTempFiles();
    assert.strictEqual(fs.existsSync(credsPath), false, 'credentials file should be removed by cleanupTempFiles()');
  });

  it('WorkloadIdentityFederation: sets GOOGLE_BACKEND_CREDENTIALS to a fresh external_account credentials file', async () => {
    (tasks as any).getInput = (name: string) => {
      switch (name) {
        case 'backendServiceGCP': return 'GCP-Backend';
        case 'backendAuthSchemeGCP': return 'WorkloadIdentityFederation';
        case 'backendGCPProjectNumber': return '123456789012';
        case 'backendGCPWorkloadIdentityPoolId': return 'pool-1';
        case 'backendGCPWorkloadIdentityProviderId': return 'provider-1';
        case 'backendGCPServiceAccountEmail': return 'sa@project.iam.gserviceaccount.com';
        default: return undefined;
      }
    };
    (tasks as any).setSecret = () => { /* no-op */ };
    (idTokenGenerator as any).generateIdToken = async () => 'fake-oidc-jwt';

    const handler = new TerraformCommandHandlerGCP();
    await handler.configureBackendCredentials();

    const credsPath = process.env['GOOGLE_BACKEND_CREDENTIALS']!;
    assert.ok(credsPath, 'GOOGLE_BACKEND_CREDENTIALS should be set');
    const written = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    assert.strictEqual(written.type, 'external_account');
    assert.ok(written.audience.includes('pool-1'));

    (handler as any).cleanupTempFiles();
    assert.strictEqual(fs.existsSync(credsPath), false, 'credentials file should be removed by cleanupTempFiles()');
  });

  it('throws for an unrecognized backendAuthSchemeGCP value', async () => {
    (tasks as any).getInput = (name: string) => {
      if (name === 'backendServiceGCP') return 'GCP-Backend';
      if (name === 'backendAuthSchemeGCP') return 'NotARealScheme';
      return undefined;
    };

    const handler = new TerraformCommandHandlerGCP();
    await assert.rejects(() => handler.configureBackendCredentials(), /Unrecognized authorization scheme/);
  });

  // #1025 finding 1+3. The gcs backend resolves `access_token` AHEAD of
  // `credentials` ("If both are specified, access_token will be used over the
  // credentials field"), and the impersonation names redirect the effective
  // identity outright -- so an inherited value out-ranks the credentials file
  // this handler just wrote. The provider path already cleared its own
  // competing names; the backend path cleared nothing.
  it('clears the inherited credential sources that out-rank GOOGLE_BACKEND_CREDENTIALS (#1025)', async () => {
    const outranking = {
      GOOGLE_BACKEND_OAUTH_ACCESS_TOKEN: 'inherited-backend-token',
      GOOGLE_OAUTH_ACCESS_TOKEN: 'inherited-token',
      GOOGLE_BACKEND_IMPERSONATE_SERVICE_ACCOUNT: 'attacker@evil.iam.gserviceaccount.com',
      GOOGLE_IMPERSONATE_SERVICE_ACCOUNT: 'attacker@evil.iam.gserviceaccount.com',
    };
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(outranking)) { saved[k] = process.env[k]; process.env[k] = v; }
    // The provider's own credential, which the backend pass must NOT strip:
    // handleProvider sets it, and in a cross-cloud run it is still needed.
    const savedProviderCreds = process.env['GOOGLE_CREDENTIALS'];
    process.env['GOOGLE_CREDENTIALS'] = '/tmp/provider-creds.json';

    (tasks as any).getInput = (name: string) => {
      if (name === 'backendServiceGCP') return 'GCP-Backend';
      if (name === 'backendAuthSchemeGCP') return 'WorkloadIdentityFederation';
      if (name === 'backendGCPProjectNumber') return '123456789012';
      if (name === 'backendGCPWorkloadIdentityPoolId') return 'pool-1';
      if (name === 'backendGCPWorkloadIdentityProviderId') return 'provider-1';
      if (name === 'backendGCPServiceAccountEmail') return 'sa@project.iam.gserviceaccount.com';
      return undefined;
    };
    (tasks as any).setSecret = () => { /* no-op */ };
    (idTokenGenerator as any).generateIdToken = async () => 'fake-oidc-jwt';

    try {
      const handler = new TerraformCommandHandlerGCP();
      await handler.configureBackendCredentials();

      for (const k of Object.keys(outranking)) {
        assert.strictEqual(process.env[k], undefined, `${k} out-ranks GOOGLE_BACKEND_CREDENTIALS and must be cleared`);
      }
      assert.ok(process.env['GOOGLE_BACKEND_CREDENTIALS'], 'the backend credential must still be set');
      assert.strictEqual(
        process.env['GOOGLE_CREDENTIALS'], '/tmp/provider-creds.json',
        'the PROVIDER credential must survive the backend pass (cross-cloud ordering)',
      );
      (handler as any).cleanupTempFiles();
    } finally {
      for (const k of Object.keys(outranking)) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
      if (savedProviderCreds === undefined) delete process.env['GOOGLE_CREDENTIALS'];
      else process.env['GOOGLE_CREDENTIALS'] = savedProviderCreds;
    }
  });

  // #1025 finding 2. Each of these is interpolated into the audience /
  // impersonation URLs written into the credentials file; the provider WIF path
  // charset-validated them (#199), the backend WIF path did not.
  it('charset-validates the backend WIF identity inputs before interpolating them (#1025)', async () => {
    (tasks as any).getInput = (name: string) => {
      if (name === 'backendServiceGCP') return 'GCP-Backend';
      if (name === 'backendAuthSchemeGCP') return 'WorkloadIdentityFederation';
      if (name === 'backendGCPProjectNumber') return '123456789012';
      // A newline would otherwise be interpolated straight into the audience URL.
      if (name === 'backendGCPWorkloadIdentityPoolId') return 'pool-1\nevil: true';
      if (name === 'backendGCPWorkloadIdentityProviderId') return 'provider-1';
      if (name === 'backendGCPServiceAccountEmail') return 'sa@project.iam.gserviceaccount.com';
      return undefined;
    };
    (tasks as any).setSecret = () => { /* no-op */ };
    (idTokenGenerator as any).generateIdToken = async () => 'fake-oidc-jwt';

    const handler = new TerraformCommandHandlerGCP();
    await assert.rejects(
      () => handler.configureBackendCredentials(),
      /backendGCPWorkloadIdentityPoolId/,
    );
  });
});
