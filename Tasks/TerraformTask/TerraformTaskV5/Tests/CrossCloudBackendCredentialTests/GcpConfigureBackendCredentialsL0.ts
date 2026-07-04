import * as assert from 'assert';
import * as fs from 'fs';
import tasks = require('azure-pipelines-task-lib/task');
import { TerraformCommandHandlerGCP } from '../../src/gcp-terraform-command-handler';
import { EnvironmentVariableHelper } from '../../src/environment-variables';
import * as idTokenGenerator from '../../src/id-token-generator';
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
});
