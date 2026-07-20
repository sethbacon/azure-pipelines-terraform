import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// Audit id0 (2026-07-20): with the opt-in failOnSensitiveOutputs, the console
// path must fail BEFORE echoing anything -- unlike the file path (which must
// delete an already-written file), the console path has nothing to clean up
// because the silent capture never reaches console.log until after this
// check passes. This is a strictly stronger guarantee than the file path.
let tp = path.join(__dirname, './AzureShowConsoleJsonSensitiveStrictL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'show');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('outputTo', 'console');
tr.setInput('outputFormat', 'json');
tr.setInput('commandOptions', '');
tr.setInput('failOnSensitiveOutputs', 'true');
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');

process.env['ENDPOINT_AUTH_SCHEME_AzureRM'] = 'ServicePrincipal';
process.env['ENDPOINT_DATA_AzureRM_SUBSCRIPTIONID'] = 'DummySubscriptionId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALID'] = 'DummyServicePrincipalId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALKEY'] = 'DummyServicePrincipalKey';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_TENANTID'] = 'DummyTenantId';

const planJson = JSON.stringify({
    format_version: "1.2",
    planned_values: {
        outputs: {
            connection_string: { sensitive: true, value: "Server=SuperSecretConnectionString" }
        }
    },
    resource_changes: []
});

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    "which": {
        "terraform": "terraform"
    },
    "checkPath": {
        "terraform": true
    },
    "exec": {
        "terraform show -json": {
            "code": 0,
            "stdout": planJson
        }
    }
};

tr.setAnswers(a);
tr.run();
