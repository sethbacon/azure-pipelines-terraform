import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');
import os = require('os');

// Strict mode for `show` to a JSON file (#488): the show output file is
// always retained (there is no cleanup input for it), so with
// failOnSensitiveOutputs=true a plan containing sensitive *outputs* must
// fail the task, and the just-written file must be deleted by the
// end-of-step cleanup. Sensitive resource *attributes* alone stay
// warning-only (nearly every real plan carries some).
const workingDirectory = path.join(os.tmpdir(), 'tf-show-strict-fail-test');
fs.rmSync(workingDirectory, { recursive: true, force: true });
fs.mkdirSync(workingDirectory, { recursive: true });

let tp = path.join(__dirname, './AzureShowFileJsonSensitiveStrictL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'show');
tr.setInput('workingDirectory', workingDirectory);
tr.setInput('outputTo', 'file');
tr.setInput('outputFormat', 'json');
tr.setInput('filename', 'plan.json');
tr.setInput('commandOptions', '');
tr.setInput('failOnSensitiveOutputs', 'true');
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');

process.env['ENDPOINT_AUTH_SCHEME_AzureRM'] = 'ServicePrincipal';
process.env['ENDPOINT_DATA_AzureRM_SUBSCRIPTIONID'] = 'DummySubscriptionId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALID'] = 'DummyServicePrincipalId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALKEY'] = 'DummyServicePrincipalKey';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_TENANTID'] = 'DummyTenantId';

// JSON plan with a sensitive output
const planJson = JSON.stringify({
    format_version: "1.2",
    planned_values: {
        outputs: {
            connection_string: { sensitive: true, value: "Server=..." },
            app_name: { sensitive: false, value: "myapp" }
        }
    },
    resource_changes: []
});

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    "which": {
        "terraform": "terraform"
    },
    "checkPath": {
        "terraform": true
    },
    "exec": {
        "terraform show -json": {
            "code": 0,
            "stdout": planJson
        }
    }
};

tr.setAnswers(a);
tr.run();
