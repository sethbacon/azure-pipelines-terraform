import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import { prepareScratchFixture } from './smoke-helpers';

/** Baseline matrix: validate (auth-free, createBaseCommand). */
const scratchDir = prepareScratchFixture();

const tp = path.join(__dirname, 'BaselineValidateL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'validate');
tr.setInput('workingDirectory', scratchDir);

tr.run(true);
