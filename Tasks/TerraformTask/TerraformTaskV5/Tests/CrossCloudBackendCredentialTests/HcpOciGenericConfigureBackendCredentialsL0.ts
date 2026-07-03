import * as assert from 'assert';
import tasks = require('azure-pipelines-task-lib/task');
import { TerraformCommandHandlerHCP } from '../../src/hcp-terraform-command-handler';
import { TerraformCommandHandlerOCI } from '../../src/oci-terraform-command-handler';
import { TerraformCommandHandlerGeneric } from '../../src/generic-terraform-command-handler';
import { EnvironmentVariableHelper } from '../../src/environment-variables';

/**
 * Direct unit tests for the HCP handler's cross-cloud
 * `configureBackendCredentials()`, and the OCI/generic no-ops (these backends
 * have no separate cloud identity to inject: OCI's http/PAR backend embeds
 * auth in its cached, pre-authenticated request URL; generic/local backends
 * are authenticated, if at all, via the user's own environment).
 */
describe('HCP/OCI/Generic configureBackendCredentials (cross-cloud)', function () {
  const originalGetInput = tasks.getInput;
  const originalSetSecret = tasks.setSecret;

  afterEach(() => {
    (tasks as any).getInput = originalGetInput;
    (tasks as any).setSecret = originalSetSecret;
    EnvironmentVariableHelper.clearTrackedVariables();
  });

  it('HCP: sets TF_TOKEN_app_terraform_io, TF_CLOUD_ORGANIZATION, and TF_WORKSPACE', async () => {
    (tasks as any).getInput = (name: string) => {
      switch (name) {
        case 'backendHCPToken': return 'hcp-token';
        case 'backendHCPOrganization': return 'NavicoCloudTeam';
        case 'backendHCPWorkspace': return 'my-workspace';
        default: return undefined;
      }
    };
    (tasks as any).setSecret = () => { /* no-op */ };

    const handler = new TerraformCommandHandlerHCP();
    await handler.configureBackendCredentials();

    assert.strictEqual(process.env['TF_TOKEN_app_terraform_io'], 'hcp-token');
    assert.strictEqual(process.env['TF_CLOUD_ORGANIZATION'], 'NavicoCloudTeam');
    assert.strictEqual(process.env['TF_WORKSPACE'], 'my-workspace');
  });

  it('HCP: throws when backendHCPToken is not provided on this step', async () => {
    (tasks as any).getInput = (name: string, required?: boolean) => {
      if (name === 'backendHCPToken' && required) {
        throw new Error('Input required: backendHCPToken');
      }
      return undefined;
    };

    const handler = new TerraformCommandHandlerHCP();
    await assert.rejects(() => handler.configureBackendCredentials(), /backendHCPToken/);
  });

  it('OCI: is a no-op (no env vars set, does not throw)', async () => {
    const handler = new TerraformCommandHandlerOCI();
    await assert.doesNotReject(() => handler.configureBackendCredentials());
  });

  it('Generic: is a no-op (no env vars set, does not throw)', async () => {
    const handler = new TerraformCommandHandlerGeneric();
    await assert.doesNotReject(() => handler.configureBackendCredentials());
  });
});
