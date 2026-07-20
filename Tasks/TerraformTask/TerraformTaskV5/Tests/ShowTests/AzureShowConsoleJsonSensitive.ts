import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// Audit id0 (2026-07-20): `terraform show -json` to the CONSOLE must run the
// same sensitive-value detection the `outputTo=file` branch already applies,
// and warn -- the console content is still echoed (that is the whole point of
// outputTo=console), but silently is no longer acceptable.
let tp = path.join(__dirname, './AzureShowConsoleJsonSensitiveL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'show');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('outputTo', 'console');
tr.setInput('outputFormat', 'json');
tr.setInput('commandOptions', '');
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
            connection_string: { sensitive: true, value: "Server=..." },
            app_name: { sensitive: false, value: "myapp" }
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
