import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// Backward-compat regression fixture (design §12.3): publishPlanResults set,
// publishPlanSummary NOT set. The exec command line must be byte-for-byte the
// same as the pre-WP-2 behavior -- no `-out=` token -- so this scenario is
// intentionally identical to the pre-existing AzurePlanSuccessPublishResults
// fixture's mock answers.
let tp = path.join(__dirname, './AzurePlanPublishResultsOnlyBackwardCompatL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'plan');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');
tr.setInput('commandOptions', '');
tr.setInput('publishPlanResults', 'my-plan');

process.env['ENDPOINT_AUTH_SCHEME_AzureRM'] = 'ServicePrincipal';
process.env['ENDPOINT_DATA_AzureRM_SUBSCRIPTIONID'] = 'DummmySubscriptionId';
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
            "stdout": "provider azurerm"
        },
        "terraform plan -detailed-exitcode": {
            "code": 2,
            "stdout": "Plan: 1 to add, 0 to change, 0 to destroy."
        }
    }
}

tr.setAnswers(a);
tr.run();
