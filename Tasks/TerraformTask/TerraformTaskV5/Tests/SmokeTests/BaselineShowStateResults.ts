import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import { prepareScratchFixture, setFakeAzureServiceConnectionEnv } from './smoke-helpers';

/** Baseline matrix: show current state + publishStateResults (structured state-inventory path). */
const scratchDir = prepareScratchFixture();

const tp = path.join(__dirname, 'BaselineShowStateResultsL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'show');
tr.setInput('workingDirectory', scratchDir);
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');
tr.setInput('outputTo', 'console');
tr.setInput('outputFormat', 'json');
tr.setInput('publishStateResults', 'my-state-results');

setFakeAzureServiceConnectionEnv();

tr.run(true);
