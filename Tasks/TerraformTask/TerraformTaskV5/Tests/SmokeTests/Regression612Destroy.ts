import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import { prepareScratchFixture, setFakeAzureServiceConnectionEnv } from './smoke-helpers';

/**
 * Baseline destroy scenario (real terraform, no mocks): auto-approve +
 * commandOptions forwarding against real state.
 *
 * NOTE: this deliberately does NOT combine destroy with publishPlanSummary --
 * building this harness discovered that combination is currently broken
 * against real terraform (destroy() unconditionally injects `-out=`, which
 * real `terraform destroy` -- a convenience alias for `apply -destroy` --
 * rejects outright: "flag provided but not defined: -out"). Filed as #749;
 * a publishPlanSummary+destroy scenario belongs in this suite once that's
 * fixed, as a real regression guard.
 */
const scratchDir = prepareScratchFixture();

const tp = path.join(__dirname, 'Regression612DestroyL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'destroy');
tr.setInput('workingDirectory', scratchDir);
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');
tr.setInput('commandOptions', '-var=env=prod');

setFakeAzureServiceConnectionEnv();

tr.run(true);

