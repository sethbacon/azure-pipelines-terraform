import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');
import os = require('os');

// Real working directory whose .terraform/terraform.tfstate records an s3
// backend — the SAME cloud as the aws provider below. This is a regression
// guard: cross-cloud injection must be a no-op here (no azurerm inputs are
// supplied, and none should be required) — only the aws provider's own
// credentials matter, exactly as before this change.
const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'same-cloud-aws-s3-'));
fs.mkdirSync(path.join(workingDirectory, '.terraform'));
fs.writeFileSync(
  path.join(workingDirectory, '.terraform', 'terraform.tfstate'),
  JSON.stringify({ backend: { type: 's3' } }),
);

let tp = path.join(__dirname, './SameCloudAwsProviderS3BackendPlanSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'aws');
tr.setInput('command', 'plan');
tr.setInput('workingDirectory', workingDirectory);
tr.setInput('commandOptions', '');

tr.setInput('environmentServiceNameAWS', 'AWS');
process.env['ENDPOINT_AUTH_SCHEME_AWS'] = 'Basic';
process.env['ENDPOINT_AUTH_PARAMETER_AWS_USERNAME'] = 'DummyAccessKeyId';
process.env['ENDPOINT_AUTH_PARAMETER_AWS_PASSWORD'] = 'DummySecretAccessKey';

// Deliberately NO backendServiceArm / azurerm inputs — proving cross-cloud
// injection did not fire and none were required.

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
      "stdout": "provider aws"
    },
    "terraform plan -detailed-exitcode": {
      "code": 0,
      "stdout": "Executed successfully"
    }
  }
}

tr.setAnswers(a);
tr.run();
