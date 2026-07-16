import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// The structured state-summary path (Phase 5 §5.5) runs its OWN independent
// `terraform show -json` (no plan-file argument) after the primary show
// command, regardless of that primary command's own outputTo/outputFormat --
// so the primary command here is left as a plain console show, and only the
// SEPARATE `terraform show -json` needs to be mocked for the digest.
let tp = path.join(__dirname, './AzureShowStateSuccessPublishSummaryL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'show');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('outputTo', 'console');
tr.setInput('outputFormat', '');
tr.setInput('commandOptions', '');
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');
tr.setInput('publishStateResults', 'my-state');

process.env['ENDPOINT_AUTH_SCHEME_AzureRM'] = 'ServicePrincipal';
process.env['ENDPOINT_DATA_AzureRM_SUBSCRIPTIONID'] = 'DummmySubscriptionId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALID'] = 'DummyServicePrincipalId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALKEY'] = 'DummyServicePrincipalKey';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_TENANTID'] = 'DummyTenantId';

const stateJson = JSON.stringify({
    format_version: '1.0',
    terraform_version: '1.9.5',
    values: {
        outputs: {
            connection_string: { value: 'Server=prod;Password=hunter2', type: 'string', sensitive: true },
            region: { value: 'eastus', type: 'string', sensitive: false },
        },
        root_module: {
            resources: [
                {
                    address: 'azurerm_resource_group.example',
                    mode: 'managed',
                    type: 'azurerm_resource_group',
                    name: 'example',
                    provider_name: 'registry.terraform.io/hashicorp/azurerm',
                    values: { location: 'eastus', name: 'example-rg' },
                    sensitive_values: {},
                },
                {
                    address: 'data.azurerm_client_config.current',
                    mode: 'data',
                    type: 'azurerm_client_config',
                    name: 'current',
                    provider_name: 'registry.terraform.io/hashicorp/azurerm',
                    values: { tenant_id: '00000000-0000-0000-0000-000000000000' },
                    sensitive_values: {},
                },
            ],
        },
    },
});

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    "which": {
        "terraform": "terraform"
    },
    "checkPath": {
        "terraform": true
    },
    "exec": {
        "terraform show": {
            "code": 0,
            "stdout": "No state."
        },
        "terraform show -json": {
            "code": 0,
            "stdout": stateJson
        }
    }
};

tr.setAnswers(a);
tr.run();
