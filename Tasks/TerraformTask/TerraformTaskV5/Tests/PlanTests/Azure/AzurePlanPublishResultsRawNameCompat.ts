import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// COMPAT regression fixture: publishPlanResults set to a name containing
// logging-command control characters, publishPlanSummary NOT set. The legacy
// terraform-plan-results attachment name must be passed RAW (task-lib escapes
// it into the logging command), NOT run through sanitizeAttachmentName() -- which
// would STRIP those characters and change the publishPlanResults-only behavior.
let tp = path.join(__dirname, './AzurePlanPublishResultsRawNameCompatL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'plan');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');
tr.setInput('commandOptions', '');
// Injection-bearing publish name (CR/LF + ] ; % control sequences).
tr.setInput('publishPlanResults', 'raw;plan]name%end');

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
