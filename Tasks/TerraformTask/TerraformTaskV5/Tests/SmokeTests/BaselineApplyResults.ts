import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import { prepareScratchFixture, setFakeAzureServiceConnectionEnv } from './smoke-helpers';

/** Baseline matrix: fresh apply (no saved plan) + publishApplyResults (-json structured path). */
const scratchDir = prepareScratchFixture();

const tp = path.join(__dirname, 'BaselineApplyResultsL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'apply');
tr.setInput('workingDirectory', scratchDir);
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');
tr.setInput('publishApplyResults', 'my-apply-results');

setFakeAzureServiceConnectionEnv();

tr.run(true);
