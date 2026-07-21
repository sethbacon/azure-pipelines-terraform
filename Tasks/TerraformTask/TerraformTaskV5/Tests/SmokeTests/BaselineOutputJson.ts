import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import { prepareScratchFixture, setFakeAzureServiceConnectionEnv } from './smoke-helpers';

/** Baseline matrix: output -json. */
const scratchDir = prepareScratchFixture();

const tp = path.join(__dirname, 'BaselineOutputJsonL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'output');
tr.setInput('workingDirectory', scratchDir);
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');

setFakeAzureServiceConnectionEnv();

tr.run(true);
