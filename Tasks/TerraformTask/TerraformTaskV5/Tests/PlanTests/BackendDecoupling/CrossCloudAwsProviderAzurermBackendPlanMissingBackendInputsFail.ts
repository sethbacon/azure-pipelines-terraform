import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');
import os = require('os');

// Real working directory whose .terraform/terraform.tfstate records an
// azurerm backend, but this step deliberately supplies NO azurerm backend
// inputs — it should fail fast with an actionable error, not the opaque
// "Please run 'az login'" failure this cross-cloud gap used to produce.
const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-cloud-missing-backend-inputs-'));
fs.mkdirSync(path.join(workingDirectory, '.terraform'));
fs.writeFileSync(
  path.join(workingDirectory, '.terraform', 'terraform.tfstate'),
  JSON.stringify({ backend: { type: 'azurerm' } }),
);

let tp = path.join(__dirname, './CrossCloudAwsProviderAzurermBackendPlanMissingBackendInputsFailL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'aws');
tr.setInput('command', 'plan');
tr.setInput('workingDirectory', workingDirectory);
tr.setInput('commandOptions', '');

tr.setInput('environmentServiceNameAWS', 'AWS');
process.env['ENDPOINT_AUTH_SCHEME_AWS'] = 'Basic';
process.env['ENDPOINT_AUTH_PARAMETER_AWS_USERNAME'] = 'DummyAccessKeyId';
process.env['ENDPOINT_AUTH_PARAMETER_AWS_PASSWORD'] = 'DummySecretAccessKey';

// Deliberately no backendServiceArm / azurerm inputs.

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
  "which": {
    "terraform": "terraform"
  },
  "checkPath": {
    "terraform": true
  },
  "exec": {}
}

tr.setAnswers(a);
tr.run();
