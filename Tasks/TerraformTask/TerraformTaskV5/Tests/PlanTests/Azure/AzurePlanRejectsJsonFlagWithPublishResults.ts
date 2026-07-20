import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #492 follow-up regression: publishPlanResults + a user-supplied -json in
// commandOptions must be rejected BEFORE any terraform command runs -- no
// "terraform plan ... -json ..." exec answer is registered below, so if the
// task somehow attempted to run it anyway, the mock runner would fail with an
// unrelated "unable to find mock" error rather than the expected message,
// which the L0 test below distinguishes.
let tp = path.join(__dirname, './AzurePlanRejectsJsonFlagWithPublishResultsL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'plan');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');
tr.setInput('commandOptions', '-json');
tr.setInput('publishPlanResults', 'my-plan');

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
    }
  }
}

tr.setAnswers(a);
tr.run();
