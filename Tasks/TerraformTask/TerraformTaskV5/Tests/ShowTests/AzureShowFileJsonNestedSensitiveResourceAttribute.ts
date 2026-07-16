import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, './AzureShowFileJsonNestedSensitiveResourceAttributeL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'show');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('outputTo', 'file');
tr.setInput('outputFormat', 'json');
tr.setInput('filename', 'plan.json');
tr.setInput('commandOptions', '');
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');

process.env['ENDPOINT_AUTH_SCHEME_AzureRM'] = 'ServicePrincipal';
process.env['ENDPOINT_DATA_AzureRM_SUBSCRIPTIONID'] = 'DummySubscriptionId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALID'] = 'DummyServicePrincipalId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALKEY'] = 'DummyServicePrincipalKey';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_TENANTID'] = 'DummyTenantId';

// A plan whose only sensitive marking is NESTED two levels deep inside
// after_sensitive (design §5.2.7 regression): the previous one-level-only
// `Object.values(after_sensitive).some(v => v === true)` scan would see
// `{ tags: { password: true } }` and find only the non-boolean value
// `{ password: true }` at the top level, missing the sensitivity entirely.
// maskHasSensitiveLeaf must catch it.
const planJson = JSON.stringify({
    format_version: "1.2",
    planned_values: {
        outputs: {}
    },
    resource_changes: [
        {
            address: "azurerm_container_group.main",
            change: {
                actions: ["update"],
                after_sensitive: { tags: { password: true } }
            }
        }
    ]
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
