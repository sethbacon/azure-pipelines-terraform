import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, './AzureApplyMessageNeutralizesVsoInjectionL0.js');
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

// #678 regression fixture: an apply -json event's @message can carry an
// embedded newline (a JSON string escape here, not a literal control
// character in the NDJSON line) followed by content shaped like an ADO
// logging command. echoApplyMessages must neutralize the leading `##` on
// the injected physical line rather than echoing it verbatim.
const events = [
    { '@level': 'info', '@message': 'Terraform 1.9.5', '@timestamp': '2026-07-15T00:00:00.000000Z', terraform: '1.9.5', type: 'version' },
    { '@level': 'error', '@message': 'Error: something failed\n##vso[task.setvariable variable=pwned]evil', '@timestamp': '2026-07-15T00:00:01.000000Z', type: 'diagnostic' },
    { '@level': 'info', '@message': 'Apply complete! Resources: 0 added, 0 changed, 0 destroyed.', '@timestamp': '2026-07-15T00:00:03.000000Z', changes: { add: 0, change: 0, remove: 0, operation: 'apply' }, type: 'change_summary' },
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
            "code": 0,
            "stdout": ndjson
        }
    }
}

tr.setAnswers(a);
tr.run();
