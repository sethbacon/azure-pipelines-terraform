import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import crypto = require('crypto');

// Pin the first crypto.randomUUID() call (the -out planfile path) so the mock
// exec answers below can match the exact command line -- see
// AzurePlanSuccessPublishSummary.ts for the full rationale.
const FIXED_UUID = 'bbbbbbbb-0000-4000-8000-000000000002';
const realRandomUUID = crypto.randomUUID.bind(crypto);
let usedFixed = false;
(crypto as unknown as { randomUUID: (...a: unknown[]) => string }).randomUUID = (...args: unknown[]): string => {
    if (!usedFixed) {
        usedFixed = true;
        return FIXED_UUID;
    }
    return (realRandomUUID as (...a: unknown[]) => string)(...args);
};

const planFilePath = path.join(os.tmpdir(), `terraform-plan-${FIXED_UUID}.tfplan`);

let tp = path.join(__dirname, './AzurePlanPublishSummaryNameInjectionRejectedL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'plan');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');
tr.setInput('commandOptions', '');
// A malicious name attempting to break out of the ##vso[task.addattachment ...]
// logging command via CR/LF and the ]/;/% control sequences (design §5.6).
tr.setInput('publishPlanSummary', 'evil\r\nname];type=warning;%oops');

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
        "terraform providers": {
            "code": 0,
            "stdout": "provider azurerm"
        },
        [`terraform plan -detailed-exitcode -out=${planFilePath}`]: {
            "code": 0,
            "stdout": "No changes."
        },
        [`terraform show -json ${planFilePath}`]: {
            "code": 0,
            "stdout": planJson
        }
    }
}

tr.setAnswers(a);
tr.run();
