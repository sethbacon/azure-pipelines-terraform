import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, './AzureApplyFailurePublishResultsExitCodePreservedL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'apply');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');
tr.setInput('commandOptions', '');
tr.setInput('publishApplyResults', 'my-apply');

process.env['ENDPOINT_AUTH_SCHEME_AzureRM'] = 'ServicePrincipal';
process.env['ENDPOINT_DATA_AzureRM_SUBSCRIPTIONID'] = 'DummmySubscriptionId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALID'] = 'DummyServicePrincipalId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALKEY'] = 'DummyServicePrincipalKey';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_TENANTID'] = 'DummyTenantId';

const events = [
    { '@level': 'info', '@message': 'Terraform 1.9.5', '@timestamp': '2026-07-15T00:00:00.000000Z', terraform: '1.9.5', type: 'version' },
    { '@level': 'info', '@message': 'azurerm_resource_group.example: Creating...', '@timestamp': '2026-07-15T00:00:01.000000Z', hook: { resource: { addr: 'azurerm_resource_group.example' }, action: 'create' }, type: 'apply_start' },
    { '@level': 'error', '@message': 'Error: A resource with this ID already exists in Azure.', '@timestamp': '2026-07-15T00:00:02.000000Z', diagnostic: { severity: 'error', summary: 'A resource with this ID already exists', detail: 'Full provider error text with internal detail.' }, type: 'diagnostic' },
    { '@level': 'error', '@message': 'azurerm_resource_group.example: Creation errored after 1s', '@timestamp': '2026-07-15T00:00:02.000000Z', hook: { resource: { addr: 'azurerm_resource_group.example' }, action: 'create', elapsed_seconds: 1 }, type: 'apply_errored' },
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
        "terraform apply -auto-approve -json": {
            "code": 1,
            "stdout": ndjson
        }
    }
}

tr.setAnswers(a);
tr.run();
