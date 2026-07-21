import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import { prepareScratchFixture, setFakeAzureServiceConnectionEnv } from './smoke-helpers';

/** Baseline matrix: plan with no additional options (real terraform, no mocks). */
const scratchDir = prepareScratchFixture();

const tp = path.join(__dirname, 'BaselinePlainPlanL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'plan');
tr.setInput('workingDirectory', scratchDir);
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');

setFakeAzureServiceConnectionEnv();

tr.run(true);
