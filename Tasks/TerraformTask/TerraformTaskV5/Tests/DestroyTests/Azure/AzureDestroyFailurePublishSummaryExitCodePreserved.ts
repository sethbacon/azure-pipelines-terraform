import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import crypto = require('crypto');

// Pin crypto.randomUUID() to a fixed value for EVERY call (not just the
// first) so the mock exec answers below can match the exact command line --
// call-order-independent, see AzureDestroySuccessPublishSummary.ts for the
// full rationale (azure-pipelines-task-lib's own Vault also calls
// randomUUID() before task code runs).
const FIXED_UUID = 'dddddddd-0000-4000-8000-000000000004';
(crypto as unknown as { randomUUID: (...a: unknown[]) => string }).randomUUID = (): string => FIXED_UUID;

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

// #749: the destroy-plan digest is now built by a SEPARATE, real
// `terraform plan -destroy -out=<file>` BEFORE the real (auto-approved,
// -out-free) destroy runs -- real `terraform destroy` (a convenience alias
// for `apply -destroy`) does not accept `-out=` at all. So the plan file
// exists (and the digest can be attached) even when the real destroy that
// follows fails outright.
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
        [`terraform plan -destroy -out=${planFilePath}`]: {
            "code": 0,
            "stdout": "Plan: 0 to add, 0 to change, 1 to destroy."
        },
        "terraform destroy -auto-approve": {
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
