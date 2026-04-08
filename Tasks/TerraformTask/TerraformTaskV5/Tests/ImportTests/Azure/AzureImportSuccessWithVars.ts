import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, './AzureImportSuccessWithVarsL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'import');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');
tr.setInput('importAddress', 'azurerm_resource_group.example');
tr.setInput('importId', '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/example');
tr.setInput('commandOptions', '');
tr.setInput('terraformVariables', 'env=staging\n# comment line\nregion=eastus');

process.env['ENDPOINT_AUTH_SCHEME_AzureRM'] = 'ServicePrincipal';
process.env['ENDPOINT_DATA_AzureRM_SUBSCRIPTIONID'] = 'DummySubscriptionId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALID'] = 'DummyServicePrincipalId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALKEY'] = 'DummyServicePrincipalKey';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_TENANTID'] = 'DummyTenantId';

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    "which": {
        "terraform": "terraform"
    },
    "checkPath": {
        "terraform": true
    },
    "exec": {
        "terraform providers": {
            "code": 0,
            "stdout": "Executed successfully"
        },
        "terraform import -var 'env=staging' -var 'region=eastus' azurerm_resource_group.example /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/example": {
            "code": 0,
            "stdout": "Import successful!"
        }
    }
}

tr.setAnswers(a);
tr.run();
