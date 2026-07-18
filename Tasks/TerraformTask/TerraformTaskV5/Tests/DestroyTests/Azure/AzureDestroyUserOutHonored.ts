import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #612 (sibling): destroy() DOES forward commandOptions (via applyAutoApprove's
// `terraformTool.line(commandOptions)`), so a user-supplied `-out=` collides with
// the task's injected `-out=` exactly as in plan(). This scenario registers only
// the single-`-out` destroy command; the broken code would append a second
// (task-owned) `-out=<tempfile>` and miss the mock.
let tp = path.join(__dirname, './AzureDestroyUserOutHonoredL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'destroy');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');
tr.setInput('commandOptions', '-out=userdestroy.tfplan');
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
        // Exactly ONE -out (the user's); NO task-injected tempfile -out.
        "terraform destroy -auto-approve -out=userdestroy.tfplan": {
            "code": 0,
            "stdout": "Destroy complete! Resources: 1 destroyed."
        },
        "terraform show -json userdestroy.tfplan": {
            "code": 0,
            "stdout": destroyPlanJson
        }
    }
}

tr.setAnswers(a);
tr.run();
