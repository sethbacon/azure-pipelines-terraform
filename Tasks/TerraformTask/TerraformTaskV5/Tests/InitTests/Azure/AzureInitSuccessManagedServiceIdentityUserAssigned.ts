import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// MSI connection that also carries a user-assigned identity's client ID (the
// connection's "Service Principal Id" field) - ARM_CLIENT_ID must be set
// alongside ARM_USE_MSI so the azurerm provider authenticates as that
// identity rather than falling back to the agent's system-assigned one.
let tp = path.join(__dirname, './AzureInitSuccessManagedServiceIdentityUserAssignedL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'init');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('commandOptions', '');

tr.setInput('backendServiceArm', 'AzureRM');
tr.setInput('backendAzureRmResourceGroupName', 'DummyResourceGroup');
tr.setInput('backendAzureRmStorageAccountName', 'DummyStorageAccount');
tr.setInput('backendAzureRmContainerName', 'DummyContainer');
tr.setInput('backendAzureRmKey', 'DummyKey');

process.env['ENDPOINT_AUTH_SCHEME_AzureRM'] = 'ManagedServiceIdentity';
process.env['ENDPOINT_DATA_AzureRM_SUBSCRIPTIONID'] = 'DummmySubscriptionId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_TENANTID'] = 'DummyTenantId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALID'] = 'user-assigned-client-id';

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    "which": {
        "terraform": "terraform"
    },
    "checkPath": {
        "terraform": true
    },
    "exec": {
        "terraform init -backend-config=storage_account_name=DummyStorageAccount -backend-config=container_name=DummyContainer -backend-config=key=DummyKey -backend-config=resource_group_name=DummyResourceGroup -backend-config=subscription_id=DummmySubscriptionId": {
            "code": 0,
            "stdout": "Executed Successfully"
        }
    }
}

var mock = {
    "generateIdToken": function (_command) { return Promise.resolve('12345'); }
}

tr.registerMock('./id-token-generator', mock);
tr.setAnswers(a);
tr.run();
