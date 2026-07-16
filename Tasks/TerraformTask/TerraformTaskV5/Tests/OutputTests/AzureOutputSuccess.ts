import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');
import os = require('os');

// The output command writes its JSON file under Agent.TempDirectory (#492);
// point it at a scrubbed per-scenario directory so runs don't accumulate
// files in the real temp directory.
const agentTempDirectory = path.join(os.tmpdir(), 'tf-output-azure-success-agenttemp');
fs.rmSync(agentTempDirectory, { recursive: true, force: true });
fs.mkdirSync(agentTempDirectory, { recursive: true });
process.env['AGENT_TEMPDIRECTORY'] = agentTempDirectory;

let tp = path.join(__dirname, './AzureOutputSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'output');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('commandOptions', '');
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');

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
        "terraform output -json": {
            "code": 0,
            "stdout": "{\"instance_ip\":{\"value\":\"10.0.0.1\"}}"
        }
    }
};

tr.setAnswers(a);
tr.run();
