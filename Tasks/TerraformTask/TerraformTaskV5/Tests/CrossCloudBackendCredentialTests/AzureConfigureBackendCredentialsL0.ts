import * as assert from 'assert';
import tasks = require('azure-pipelines-task-lib/task');
import { TerraformCommandHandlerAzureRM } from '../../src/azure-terraform-command-handler';
import { EnvironmentVariableHelper } from '../../src/environment-variables';

/**
 * Direct unit tests for the azurerm handler's cross-cloud
 * `configureBackendCredentials()` — the method ParentCommandHandler calls on
 * state-accessing commands (plan/apply/...) when the initialized backend is
 * azurerm but the `provider` input is a different cloud (e.g. aws, the
 * tbd4770 case). Asserts the same ARM_* environment variables `handleBackend`
 * (init) would set are (re)supplied, and that nothing is written to
 * `-backend-config` (this method never touches a ToolRunner at all).
 */
describe('TerraformCommandHandlerAzureRM.configureBackendCredentials (cross-cloud)', function () {
  const originalGetInput = tasks.getInput;
  const originalGetBoolInput = tasks.getBoolInput;
  const originalGetEndpointAuthorizationScheme = tasks.getEndpointAuthorizationScheme;
  const originalGetEndpointAuthorizationParameter = tasks.getEndpointAuthorizationParameter;
  const originalGetEndpointDataParameter = tasks.getEndpointDataParameter;
  const originalSetSecret = tasks.setSecret;

  afterEach(() => {
    (tasks as any).getInput = originalGetInput;
    (tasks as any).getBoolInput = originalGetBoolInput;
    (tasks as any).getEndpointAuthorizationScheme = originalGetEndpointAuthorizationScheme;
    (tasks as any).getEndpointAuthorizationParameter = originalGetEndpointAuthorizationParameter;
    (tasks as any).getEndpointDataParameter = originalGetEndpointDataParameter;
    (tasks as any).setSecret = originalSetSecret;
    EnvironmentVariableHelper.clearTrackedVariables();
  });

  function mockCommonInputs(overrides: Record<string, string | undefined> = {}): void {
    (tasks as any).getInput = (name: string, _required?: boolean) => {
      if (name === 'backendServiceArm') return 'AzureRM-Backend';
      if (name in overrides) return overrides[name];
      return undefined;
    };
    (tasks as any).getBoolInput = () => false;
    (tasks as any).setSecret = () => { /* no-op */ };
    (tasks as any).getEndpointDataParameter = (_id: string, name: string) =>
      name === 'subscriptionid' ? 'sub-1234' : undefined;
  }

  it('ManagedServiceIdentity: sets ARM_USE_MSI, ARM_TENANT_ID, and ARM_SUBSCRIPTION_ID', async () => {
    mockCommonInputs();
    (tasks as any).getEndpointAuthorizationScheme = () => 'ManagedServiceIdentity';
    (tasks as any).getEndpointAuthorizationParameter = (_id: string, name: string) =>
      name === 'tenantid' ? 'tenant-msi' : undefined;

    const handler = new TerraformCommandHandlerAzureRM();
    await handler.configureBackendCredentials();

    assert.strictEqual(process.env['ARM_USE_MSI'], 'true');
    assert.strictEqual(process.env['ARM_TENANT_ID'], 'tenant-msi');
    assert.strictEqual(process.env['ARM_SUBSCRIPTION_ID'], 'sub-1234');
  });

  it('ServicePrincipal: sets ARM_CLIENT_ID, ARM_CLIENT_SECRET, and ARM_TENANT_ID', async () => {
    mockCommonInputs();
    (tasks as any).getEndpointAuthorizationScheme = () => 'ServicePrincipal';
    (tasks as any).getEndpointAuthorizationParameter = (_id: string, name: string) => {
      if (name === 'tenantid') return 'tenant-spn';
      if (name === 'serviceprincipalid') return 'spn-id';
      if (name === 'serviceprincipalkey') return 'spn-secret';
      return undefined;
    };

    const handler = new TerraformCommandHandlerAzureRM();
    await handler.configureBackendCredentials();

    assert.strictEqual(process.env['ARM_CLIENT_ID'], 'spn-id');
    assert.strictEqual(process.env['ARM_CLIENT_SECRET'], 'spn-secret');
    assert.strictEqual(process.env['ARM_TENANT_ID'], 'tenant-spn');
  });

  it('WorkloadIdentityFederation (token refresh): sets ARM_USE_OIDC, ARM_CLIENT_ID, and the ADO request token', async () => {
    mockCommonInputs(); // backendAzureRmUseIdTokenGeneration defaults false -> token-refresh path (no network call)
    (tasks as any).getEndpointAuthorizationScheme = () => 'WorkloadIdentityFederation';
    (tasks as any).getEndpointAuthorizationParameter = (id: string, name: string) => {
      if (id === 'SystemVssConnection' && name === 'AccessToken') return 'fake-ado-access-token';
      if (name === 'tenantid') return 'tenant-wif';
      if (name === 'serviceprincipalid') return 'wif-client-id';
      return undefined;
    };

    const handler = new TerraformCommandHandlerAzureRM();
    await handler.configureBackendCredentials();

    assert.strictEqual(process.env['ARM_USE_OIDC'], 'true');
    assert.strictEqual(process.env['ARM_CLIENT_ID'], 'wif-client-id');
    assert.strictEqual(process.env['ARM_TENANT_ID'], 'tenant-wif');
    assert.strictEqual(process.env['ARM_OIDC_REQUEST_TOKEN'], 'fake-ado-access-token');
    // Cross-cloud injection never uses CLI-flag/backend-config auth.
    assert.strictEqual(process.env['ARM_OIDC_AZURE_SERVICE_CONNECTION_ID'], 'AzureRM-Backend');
  });

  it('throws when backendServiceArm is not provided on this step', async () => {
    (tasks as any).getInput = (name: string, required?: boolean) => {
      if (name === 'backendServiceArm' && required) {
        throw new Error("Input required: backendServiceArm");
      }
      return undefined;
    };

    const handler = new TerraformCommandHandlerAzureRM();
    await assert.rejects(() => handler.configureBackendCredentials(), /backendServiceArm/);
  });
});
