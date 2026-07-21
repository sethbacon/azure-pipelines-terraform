import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import { prepareScratchFixture, setFakeAzureServiceConnectionEnv } from './smoke-helpers';

/**
 * #749 regression floor (real terraform, no mocks): destroy() +
 * publishPlanSummary. Real `terraform destroy` (a convenience alias for
 * `apply -destroy`) does not accept `-out=` at all -- a prior fix
 * unconditionally injected `-out=` on the real destroy command anyway, which
 * real terraform rejected outright ("flag provided but not defined: -out")
 * every time. The fix runs a SEPARATE, real `terraform plan -destroy -out=`
 * to build the digest, then the real (auto-approved, -out-free) destroy.
 * This scenario proves the whole combination now succeeds end-to-end against
 * real terraform.
 */
const scratchDir = prepareScratchFixture();

const tp = path.join(__dirname, 'Regression749DestroyPlanSummaryL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'destroy');
tr.setInput('workingDirectory', scratchDir);
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');
tr.setInput('publishPlanSummary', 'my-destroy-summary');

setFakeAzureServiceConnectionEnv();

tr.run(true);
