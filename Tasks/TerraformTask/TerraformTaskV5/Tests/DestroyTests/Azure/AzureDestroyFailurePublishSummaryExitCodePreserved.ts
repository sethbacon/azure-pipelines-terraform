import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import crypto = require('crypto');

// Pin the first crypto.randomUUID() call (the -out planfile path) so the mock
// exec answers below can match the exact command line -- see
// AzureDestroySuccessPublishSummary.ts for the full rationale.
const FIXED_UUID = 'dddddddd-0000-4000-8000-000000000004';
const realRandomUUID = crypto.randomUUID.bind(crypto);
let usedFixed = false;
(crypto as unknown as { randomUUID: (...a: unknown[]) => string }).randomUUID = (...args: unknown[]): string => {
    if (!usedFixed) {
        usedFixed = true;
        return FIXED_UUID;
    }
    return (realRandomUUID as (...a: unknown[]) => string)(...args);
};

const planFilePath = path.join(os.tmpdir(), `terraform-destroy-${FIXED_UUID}.tfplan`);

let tp = path.join(__dirname, './AzureDestroyFailurePublishSummaryExitCodePreservedL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'destroy');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');
tr.setInput('commandOptions', '');
tr.setInput('publishPlanSummary', 'my-destroy-summary');

process.env['ENDPOINT_AUTH_SCHEME_AzureRM'] = 'ServicePrincipal';
process.env['ENDPOINT_DATA_AzureRM_SUBSCRIPTIONID'] = 'DummmySubscriptionId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALID'] = 'DummyServicePrincipalId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALKEY'] = 'DummyServicePrincipalKey';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_TENANTID'] = 'DummyTenantId';

// Terraform writes -out during the PLANNING phase, before the auto-approved
// apply phase runs -- so the plan file exists even when the apply portion of
// destroy fails partway through. The mocked show -json below simulates that:
// the plan file's content is available for the digest despite the destroy
// command itself exiting non-zero.
const destroyPlanJson = JSON.stringify({
    format_version: '1.2',
    terraform_version: '1.9.5',
    resource_changes: [
        {
            address: 'azurerm_resource_group.example',
            type: 'azurerm_resource_group',
            name: 'example',
            provider_name: 'registry.terraform.io/hashicorp/azurerm',
            change: {
                actions: ['delete'],
                before: { location: 'eastus' },
                after: null,
                after_unknown: {},
                before_sensitive: {},
                after_sensitive: false,
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
        [`terraform destroy -auto-approve -out=${planFilePath}`]: {
            "code": 1,
            "stdout": "Error: A resource could not be destroyed."
        },
        [`terraform show -json ${planFilePath}`]: {
            "code": 0,
            "stdout": destroyPlanJson
        }
    }
}

tr.setAnswers(a);
tr.run();
