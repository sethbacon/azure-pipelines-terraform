import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #612: the user already saves the plan via their own `-out=<path>` in
// commandOptions AND enables publishPlanSummary. The task must NOT inject a
// second `-out=` (terraform honors only the LAST one, so the task's tempfile
// would silently shadow the user's file). The ONLY plan answer registered omits
// any task-injected -out -- so the broken code (which appended its own
// `-out=<tempfile>`) would MISS this mock. The subsequent `terraform show -json`
// runs against the USER's path.
let tp = path.join(__dirname, './AzurePlanUserOutHonoredL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'plan');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');
tr.setInput('commandOptions', '-out=userplan.tfplan');
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
        // Exactly ONE -out (the user's); NO task-injected tempfile -out.
        "terraform plan -out=userplan.tfplan -detailed-exitcode": {
            "code": 2,
            "stdout": "Plan: 1 to add, 0 to change, 0 to destroy."
        },
        // Digest is built against the USER's saved plan, not a throwaway tempfile.
        "terraform show -json userplan.tfplan": {
            "code": 0,
            "stdout": planJson
        }
    }
}

tr.setAnswers(a);
tr.run();
