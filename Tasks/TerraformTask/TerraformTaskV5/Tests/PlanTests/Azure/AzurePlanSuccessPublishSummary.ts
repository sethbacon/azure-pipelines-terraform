import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import crypto = require('crypto');

// The structured plan-summary path adds `-out=<planfile>` to the plan command
// and later runs `terraform show -json <planfile>` on the SAME path, so the
// mock exec answers below must know that path ahead of time. Pin
// crypto.randomUUID() to a fixed value for EVERY call (not just the first) --
// call-order-independent, because azure-pipelines-task-lib >=5.276 also calls
// crypto.randomUUID() internally (Vault.genKey(), constructed before task code
// runs) against this same process-wide crypto module, so "first call" is not
// reliably the task's own -out planfile call. The digest attachment's own
// random filename reuses the same fixed value too, which is harmless: it gets
// a different filename prefix/suffix, so there is no path collision, and the
// test only asserts the attachment's logical name/content, never its temp path.
const FIXED_UUID = 'aaaaaaaa-0000-4000-8000-000000000001';
(crypto as unknown as { randomUUID: (...a: unknown[]) => string }).randomUUID = (): string => FIXED_UUID;

const planFilePath = path.join(os.tmpdir(), `terraform-plan-${FIXED_UUID}.tfplan`);

let tp = path.join(__dirname, './AzurePlanSuccessPublishSummaryL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'plan');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');
tr.setInput('commandOptions', '');
tr.setInput('publishPlanSummary', 'my-summary');

process.env['ENDPOINT_AUTH_SCHEME_AzureRM'] = 'ServicePrincipal';
process.env['ENDPOINT_DATA_AzureRM_SUBSCRIPTIONID'] = 'DummmySubscriptionId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALID'] = 'DummyServicePrincipalId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALKEY'] = 'DummyServicePrincipalKey';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_TENANTID'] = 'DummyTenantId';

const planJson = JSON.stringify({
    format_version: '1.2',
    terraform_version: '1.9.5',
    resource_changes: [
        {
            address: 'azurerm_resource_group.example',
            type: 'azurerm_resource_group',
            name: 'example',
            provider_name: 'registry.terraform.io/hashicorp/azurerm',
            change: {
                actions: ['create'],
                before: null,
                after: { location: 'eastus' },
                after_unknown: {},
                before_sensitive: false,
                after_sensitive: {},
            },
        },
    ],
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
            "code": 2,
            "stdout": "Plan: 1 to add, 0 to change, 0 to destroy."
        },
        [`terraform show -json ${planFilePath}`]: {
            "code": 0,
            "stdout": planJson
        }
    }
}

tr.setAnswers(a);
tr.run();
