import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import { prepareScratchFixture, setFakeAzureServiceConnectionEnv } from './smoke-helpers';

/**
 * #612 regression floor (real terraform, no mocks): the user already saves
 * the plan via their own `-out=userplan.tfplan` in commandOptions AND enables
 * publishPlanSummary. The task must NOT inject a second `-out=` -- terraform
 * honors only the LAST `-out=` on the command line, so a task-injected
 * tempfile would silently shadow the user's file and userplan.tfplan would
 * never be written. Unlike the mock-runner sibling test (which proves this by
 * an exec-answer keyed on the exact expected command line -- itself unable to
 * catch a WRONG argv shape it wasn't told to expect), this scenario runs a
 * real terraform binary against a real fixture and asserts on the real
 * on-disk file.
 */
const scratchDir = prepareScratchFixture();

const tp = path.join(__dirname, 'Regression612PlanL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'plan');
tr.setInput('workingDirectory', scratchDir);
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');
tr.setInput('commandOptions', '-out=userplan.tfplan');
tr.setInput('publishPlanSummary', 'my-summary');

setFakeAzureServiceConnectionEnv();

tr.run(true);
