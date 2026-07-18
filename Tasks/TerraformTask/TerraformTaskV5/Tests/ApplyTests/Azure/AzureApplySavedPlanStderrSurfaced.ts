import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #613 compounding issue: the structured apply path runs with silent:true, so
// the ToolRunner does NOT echo the child's output. When terraform fails with a
// CLI usage error / provider crash it writes to STDERR and NOTHING to the -json
// NDJSON stdout stream. This scenario reproduces exactly that: stdout empty,
// exit code 1, the diagnostic ONLY on stderr. The task must surface that stderr
// text instead of swallowing it behind a bare "exit code 1".
let tp = path.join(__dirname, './AzureApplySavedPlanStderrSurfacedL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'apply');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');
tr.setInput('commandOptions', 'badplan.tfplan');
tr.setInput('publishApplyResults', 'my-apply');

process.env['ENDPOINT_AUTH_SCHEME_AzureRM'] = 'ServicePrincipal';
process.env['ENDPOINT_DATA_AzureRM_SUBSCRIPTIONID'] = 'DummmySubscriptionId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALID'] = 'DummyServicePrincipalId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALKEY'] = 'DummyServicePrincipalKey';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_TENANTID'] = 'DummyTenantId';

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
        // Exit 1 with an EMPTY stdout and the error text ONLY on stderr -- the
        // exact shape of the production incident.
        "terraform apply -auto-approve -json badplan.tfplan": {
            "code": 1,
            "stdout": "",
            "stderr": "Error: Failed to read plan from plan file\nplan file could not be opened"
        }
    }
}

tr.setAnswers(a);
tr.run();
