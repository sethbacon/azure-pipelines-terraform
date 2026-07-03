import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');
import os = require('os');

// Real working directory with a real .terraform/terraform.tfstate recording an
// azurerm backend. detectBackendCloud() reads this straight off disk (it is
// not something the mock-run task-lib answers can fake), so the cross-cloud
// injection path under test needs a genuine file, not just mocked inputs.
const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-cloud-aws-azurerm-'));
fs.mkdirSync(path.join(workingDirectory, '.terraform'));
fs.writeFileSync(
  path.join(workingDirectory, '.terraform', 'terraform.tfstate'),
  JSON.stringify({ backend: { type: 'azurerm' } }),
);

let tp = path.join(__dirname, './CrossCloudAwsProviderAzurermBackendPlanSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'aws');
tr.setInput('command', 'plan');
tr.setInput('workingDirectory', workingDirectory);
tr.setInput('commandOptions', '');

// AWS provider credentials (ServiceConnection scheme, static keys) — same as
// any ordinary aws-provider plan step.
tr.setInput('environmentServiceNameAWS', 'AWS');
process.env['ENDPOINT_AUTH_SCHEME_AWS'] = 'Basic';
process.env['ENDPOINT_AUTH_PARAMETER_AWS_USERNAME'] = 'DummyAccessKeyId';
process.env['ENDPOINT_AUTH_PARAMETER_AWS_PASSWORD'] = 'DummySecretAccessKey';

// azurerm backend credentials — required on THIS step only because the
// backend (azurerm, detected above) differs from the provider (aws). This is
// exactly the tbd4770 scenario: an AWS WIF provider with Azure Blob state.
tr.setInput('backendServiceArm', 'AzureRM');
process.env['ENDPOINT_AUTH_SCHEME_AzureRM'] = 'ServicePrincipal';
process.env['ENDPOINT_DATA_AzureRM_SUBSCRIPTIONID'] = 'DummySubscriptionId';
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
