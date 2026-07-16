import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// Heuristic gate (Phase 5 §5.5): publishStateResults is set, but
// commandOptions names a plan-file positional argument ('tfplan.out') -- this
// is a PLANFILE show, not a state show, so hasPositionalCommandArg() must gate
// the new state-summary path off even though publishStateResults is set. Only
// the primary `terraform show -json tfplan.out` call is mocked; if the
// production code incorrectly attempted a second bare `terraform show -json`
// call, the mock-answer lookup would fail and the task would fail.
let tp = path.join(__dirname, './AzureShowPlanFileSkipsStateSummaryL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'show');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('outputTo', 'console');
tr.setInput('outputFormat', 'json');
tr.setInput('commandOptions', 'tfplan.out');
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');
tr.setInput('publishStateResults', 'my-state');

process.env['ENDPOINT_AUTH_SCHEME_AzureRM'] = 'ServicePrincipal';
process.env['ENDPOINT_DATA_AzureRM_SUBSCRIPTIONID'] = 'DummmySubscriptionId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALID'] = 'DummyServicePrincipalId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALKEY'] = 'DummyServicePrincipalKey';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_TENANTID'] = 'DummyTenantId';

const planJson = JSON.stringify({
    format_version: '1.2',
    terraform_version: '1.9.5',
    resource_changes: [],
    output_changes: {},
});

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    "which": {
        "terraform": "terraform"
    },
    "checkPath": {
        "terraform": true
    },
    "exec": {
        "terraform show -json tfplan.out": {
            "code": 0,
            "stdout": planJson
        }
    }
};

tr.setAnswers(a);
tr.run();
