import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import crypto = require('crypto');

// destroy()'s structured-summary path adds `-out=<planfile>` to the destroy
// command and later runs `terraform show -json <planfile>` on the SAME path
// (mirroring plan()'s AzurePlanSuccessPublishSummary.ts), so the mock exec
// answers below must know that path ahead of time. Pin crypto.randomUUID() to
// a fixed value for EVERY call (not just the first) -- call-order-independent,
// because azure-pipelines-task-lib >=5.276 also calls crypto.randomUUID()
// internally (Vault.genKey(), constructed before task code runs) against this
// same process-wide crypto module. The digest attachment's own random
// filename reuses the same fixed value too, which is harmless (different
// filename prefix/suffix, no path collision; the test never asserts the
// temp path).
const FIXED_UUID = 'cccccccc-0000-4000-8000-000000000003';
(crypto as unknown as { randomUUID: (...a: unknown[]) => string }).randomUUID = (): string => FIXED_UUID;

const planFilePath = path.join(os.tmpdir(), `terraform-destroy-${FIXED_UUID}.tfplan`);

let tp = path.join(__dirname, './AzureDestroySuccessPublishSummaryL0.js');
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
            "code": 0,
            "stdout": "Destroy complete! Resources: 1 destroyed."
        },
        [`terraform show -json ${planFilePath}`]: {
            "code": 0,
            "stdout": destroyPlanJson
        }
    }
}

tr.setAnswers(a);
tr.run();
