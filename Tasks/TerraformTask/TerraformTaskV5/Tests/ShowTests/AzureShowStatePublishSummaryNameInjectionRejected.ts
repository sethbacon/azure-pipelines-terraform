import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, './AzureShowStatePublishSummaryNameInjectionRejectedL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'show');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('outputTo', 'console');
tr.setInput('outputFormat', '');
tr.setInput('commandOptions', '');
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');
// A malicious name attempting to break out of the ##vso[task.addattachment ...]
// logging command via CR/LF and the ]/;/% control sequences (design §5.6,
// mirroring AzurePlanPublishSummaryNameInjectionRejected.ts for publishStateResults).
tr.setInput('publishStateResults', 'evil\r\nname];type=warning;%oops');

process.env['ENDPOINT_AUTH_SCHEME_AzureRM'] = 'ServicePrincipal';
process.env['ENDPOINT_DATA_AzureRM_SUBSCRIPTIONID'] = 'DummmySubscriptionId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALID'] = 'DummyServicePrincipalId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALKEY'] = 'DummyServicePrincipalKey';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_TENANTID'] = 'DummyTenantId';

const stateJson = JSON.stringify({
    format_version: '1.0',
    terraform_version: '1.9.5',
    values: { root_module: { resources: [] } },
});

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    "which": {
        "terraform": "terraform"
    },
    "checkPath": {
        "terraform": true
    },
    "exec": {
        "terraform show": {
            "code": 0,
            "stdout": "No state."
        },
        "terraform show -json": {
            "code": 0,
            "stdout": stateJson
        }
    }
};

tr.setAnswers(a);
tr.run();
