import * as assert from 'assert';
import tasks = require('azure-pipelines-task-lib/task');
import { getManagedIdentityClientId } from '../src/azure-terraform-command-handler';

/**
 * Direct unit tests for the optional user-assigned managed identity client ID.
 * ARM_USE_MSI alone authenticates as the agent's system-assigned identity; if
 * the connection targets a user-assigned identity instead, the azurerm
 * provider needs ARM_CLIENT_ID to disambiguate. This reads the connection's
 * existing "Service Principal Id" field (the same endpoint parameter the
 * WorkloadIdentityFederation/ServicePrincipal schemes already read) rather
 * than introducing a new connection field.
 */
describe('getManagedIdentityClientId', function () {
    const originalGetEndpointAuthorizationParameter = tasks.getEndpointAuthorizationParameter;
    afterEach(() => { (tasks as any).getEndpointAuthorizationParameter = originalGetEndpointAuthorizationParameter; });

    it('returns the client ID when the MSI connection carries one', () => {
        (tasks as any).getEndpointAuthorizationParameter = (_id: string, name: string) =>
            name === 'serviceprincipalid' ? 'user-assigned-client-id' : undefined;
        assert.strictEqual(getManagedIdentityClientId('AzureRM'), 'user-assigned-client-id');
    });

    it('returns undefined for a system-assigned identity (field left blank)', () => {
        (tasks as any).getEndpointAuthorizationParameter = () => undefined;
        assert.strictEqual(getManagedIdentityClientId('AzureRM'), undefined);
    });

    it('returns undefined when the field is an empty string', () => {
        (tasks as any).getEndpointAuthorizationParameter = () => '';
        assert.strictEqual(getManagedIdentityClientId('AzureRM'), undefined);
    });
});
