import * as assert from 'assert';
import * as fs from 'fs';
import tasks = require('azure-pipelines-task-lib/task');
import { TerraformCommandHandlerAWS } from '../../src/aws-terraform-command-handler';
import { EnvironmentVariableHelper } from '../../src/environment-variables';
import * as idTokenGenerator from '../../src/id-token-generator';

/**
 * Direct unit tests for the AWS handler's cross-cloud
 * `configureBackendCredentials()` — invoked by ParentCommandHandler on
 * state-accessing commands when the initialized backend is s3 but the
 * `provider` input is a different cloud.
 */
describe('TerraformCommandHandlerAWS.configureBackendCredentials (cross-cloud)', function () {
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

  it('ServiceConnection (static credentials): sets AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY', async () => {
    (tasks as any).getInput = (name: string) => {
      if (name === 'backendServiceAWS') return 'AWS-Backend';
      if (name === 'backendAuthSchemeAWS') return undefined; // defaults to ServiceConnection
      return undefined;
    };
    (tasks as any).setSecret = () => { /* no-op */ };
    (tasks as any).getEndpointAuthorizationParameter = (_id: string, name: string) => {
      if (name === 'username') return 'AKIA-DUMMY';
      if (name === 'password') return 'dummy-secret-key';
      return undefined;
    };

    const handler = new TerraformCommandHandlerAWS();
    await handler.configureBackendCredentials();

    assert.strictEqual(process.env['AWS_ACCESS_KEY_ID'], 'AKIA-DUMMY');
    assert.strictEqual(process.env['AWS_SECRET_ACCESS_KEY'], 'dummy-secret-key');
  });

  it('WorkloadIdentityFederation: sets AWS_ROLE_ARN/AWS_REGION/AWS_WEB_IDENTITY_TOKEN_FILE and writes+cleans a token file', async () => {
    (tasks as any).getInput = (name: string) => {
      switch (name) {
        case 'backendServiceAWS': return 'AWS-Backend';
        case 'backendAuthSchemeAWS': return 'WorkloadIdentityFederation';
        case 'backendAWSRoleArn': return 'arn:aws:iam::922142189708:role/ADO-role';
        case 'backendAWSRegion': return 'us-east-1';
        case 'backendAWSSessionName': return undefined; // use default
        default: return undefined;
      }
    };
    (tasks as any).setSecret = () => { /* no-op */ };
    (idTokenGenerator as any).generateIdToken = async () => 'fake-oidc-jwt';

    const handler = new TerraformCommandHandlerAWS();
    await handler.configureBackendCredentials();

    assert.strictEqual(process.env['AWS_ROLE_ARN'], 'arn:aws:iam::922142189708:role/ADO-role');
    assert.strictEqual(process.env['AWS_REGION'], 'us-east-1');
    assert.strictEqual(process.env['AWS_ROLE_SESSION_NAME'], 'AzureDevOps-Terraform-Backend');

    const tokenFilePath = process.env['AWS_WEB_IDENTITY_TOKEN_FILE']!;
    assert.ok(tokenFilePath, 'AWS_WEB_IDENTITY_TOKEN_FILE should be set');
    assert.strictEqual(fs.readFileSync(tokenFilePath, 'utf-8'), 'fake-oidc-jwt');

    // The token file is tracked for cleanup — verify it actually gets removed.
    (handler as any).cleanupTempFiles();
    assert.strictEqual(fs.existsSync(tokenFilePath), false, 'token file should be removed by cleanupTempFiles()');
  });

  it('throws for an unrecognized backendAuthSchemeAWS value', async () => {
    (tasks as any).getInput = (name: string) => {
      if (name === 'backendServiceAWS') return 'AWS-Backend';
      if (name === 'backendAuthSchemeAWS') return 'NotARealScheme';
      return undefined;
    };

    const handler = new TerraformCommandHandlerAWS();
    await assert.rejects(() => handler.configureBackendCredentials(), /Unrecognized authorization scheme/);
  });
});
