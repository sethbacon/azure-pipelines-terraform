import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import { prepareScratchFixture, setFakeAzureServiceConnectionEnv } from './smoke-helpers';

/** Baseline matrix: plan + publishPlanSummary, task-owned tempfile -out (no user -out). */
const scratchDir = prepareScratchFixture();

const tp = path.join(__dirname, 'BaselinePlanSummaryL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'plan');
tr.setInput('workingDirectory', scratchDir);
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');
tr.setInput('publishPlanSummary', 'my-summary');

setFakeAzureServiceConnectionEnv();

tr.run(true);
