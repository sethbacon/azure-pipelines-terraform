import * as assert from 'assert';
import tasks = require('azure-pipelines-task-lib/task');
import { TerraformCommandHandlerHCP } from '../../src/hcp-terraform-command-handler';
import { TerraformCommandHandlerOCI } from '../../src/oci-terraform-command-handler';
import { TerraformCommandHandlerGeneric } from '../../src/generic-terraform-command-handler';
import { EnvironmentVariableHelper } from '@4cloudguru/pipeline-task-ado';
import ado = require('@4cloudguru/pipeline-task-ado');

/**
 * Direct unit tests for the HCP handler's cross-cloud
 * `configureBackendCredentials()`, the generic no-op (generic/local backends
 * are authenticated, if at all, via the user's own environment), and the OCI
 * handler's cross-cloud requirement. OCI's identity paths are covered in
 * OciNativeBackendL0.ts; its PAR mode's `http` backend is never detected, so
 * this method is never reached for it.
 */
describe('HCP/OCI/Generic configureBackendCredentials (cross-cloud)', function () {
  const originalGetInput = tasks.getInput;
  // backendHCPToken and backendOCIPar are password-typed inputs, read through the
  // package's readSecretInput (#1105 class sweep) rather than getInput, which
  // debug-logs the value; delegate to this file's getInput stub, required flag and all.
  const originalReadSecretInput = (ado as any).readSecretInput;
  beforeEach(() => {
    (ado as any).readSecretInput = (name: string, required?: boolean) => (tasks as any).getInput(name, required);
  });
  const originalSetSecret = tasks.setSecret;

  afterEach(() => {
    (tasks as any).getInput = originalGetInput;
    (ado as any).readSecretInput = originalReadSecretInput;
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

  it('OCI: requires backendServiceOCI when the provider is another cloud (#1304)', async () => {
    (tasks as any).getInput = (name: string, required?: boolean) => {
      const value = name === 'provider' ? 'aws' : undefined;
      if (required && !value) throw new Error(`Input required: ${name}`);
      return value;
    };
    const handler = new TerraformCommandHandlerOCI();
    await assert.rejects(() => handler.configureBackendCredentials(), /backendServiceOCI/);
  });

  it('Generic: is a no-op (no env vars set, does not throw)', async () => {
    const handler = new TerraformCommandHandlerGeneric();
    await assert.doesNotReject(() => handler.configureBackendCredentials());
  });
});
