import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #613: applying a SAVED PLAN (a positional plan-file path in commandOptions)
// with publishApplyResults set. The ONLY answer registered is the CORRECTED
// argv order `terraform apply -auto-approve -json <planfile>` -- `-json` BEFORE
// the positional. The old, broken code appended `-json` AFTER the positional
// (`terraform apply -auto-approve <planfile> -json`), which would MISS this mock
// (and, in real terraform, be rejected as "Too many command line arguments").
// So this scenario only passes once the flag precedes the positional.
let tp = path.join(__dirname, './AzureApplySavedPlanPublishResultsL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'apply');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');
tr.setInput('commandOptions', 'tfplan');
tr.setInput('publishApplyResults', 'my-apply');

process.env['ENDPOINT_AUTH_SCHEME_AzureRM'] = 'ServicePrincipal';
process.env['ENDPOINT_DATA_AzureRM_SUBSCRIPTIONID'] = 'DummmySubscriptionId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALID'] = 'DummyServicePrincipalId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALKEY'] = 'DummyServicePrincipalKey';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_TENANTID'] = 'DummyTenantId';

const events = [
    { '@level': 'info', '@message': 'Terraform 1.9.5', '@timestamp': '2026-07-15T00:00:00.000000Z', terraform: '1.9.5', type: 'version' },
    { '@level': 'info', '@message': 'azurerm_resource_group.example: Creating...', '@timestamp': '2026-07-15T00:00:01.000000Z', hook: { resource: { addr: 'azurerm_resource_group.example' }, action: 'create' }, type: 'apply_start' },
    { '@level': 'info', '@message': 'azurerm_resource_group.example: Creation complete after 2s', '@timestamp': '2026-07-15T00:00:03.000000Z', hook: { resource: { addr: 'azurerm_resource_group.example' }, action: 'create', elapsed_seconds: 2 }, type: 'apply_complete' },
    { '@level': 'info', '@message': 'Apply complete! Resources: 1 added, 0 changed, 0 destroyed.', '@timestamp': '2026-07-15T00:00:03.000000Z', changes: { add: 1, change: 0, remove: 0, operation: 'apply' }, type: 'change_summary' },
];
const ndjson = events.map((e) => JSON.stringify(e)).join('\n');

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
        // Corrected order: -json BEFORE the positional plan file. A successful
        // apply can still emit warnings to stderr -- proves the success-path
        // stderr passthrough (debug) does not break the run.
        "terraform apply -auto-approve -json tfplan": {
            "code": 0,
            "stdout": ndjson,
            "stderr": "Warning: Applying a saved plan file"
        }
    }
}

tr.setAnswers(a);
tr.run();
