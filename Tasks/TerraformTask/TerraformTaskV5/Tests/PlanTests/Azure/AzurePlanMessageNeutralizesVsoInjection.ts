import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// Audit id9 (2026-07-20) regression fixture, mirroring #678's apply-side
// AzureApplyMessageNeutralizesVsoInjection: terraform's human-readable plan
// text can carry provider/module/remote-state-controlled values rendered as
// a multi-line heredoc. A line beginning `##vso[...]` embedded in that text
// must be neutralized before the plan echo reaches the console, exactly like
// echoApplyMessages already does for apply's @message content.
let tp = path.join(__dirname, './AzurePlanMessageNeutralizesVsoInjectionL0.js');
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

const planText = [
    '  # azurerm_resource_group.example will be updated in-place',
    '  ~ resource "azurerm_resource_group" "example" {',
    '      ~ tags = {',
    '          ~ "note" = <<-EOT',
    '                normal line',
    '                ##vso[task.setvariable variable=pwned]evil',
    '            EOT',
    '        }',
    '    }',
    '',
    'Plan: 0 to add, 1 to change, 0 to destroy.',
].join('\n');

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
            "stdout": planText
        }
    }
}

tr.setAnswers(a);
tr.run();
