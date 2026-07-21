import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import { prepareScratchFixture } from './smoke-helpers';

/** Baseline matrix: fmt -check (auth-free, createBaseCommand). */
const scratchDir = prepareScratchFixture();

const tp = path.join(__dirname, 'BaselineFmtL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'fmt');
tr.setInput('workingDirectory', scratchDir);
tr.setInput('fmtCheck', 'true');

tr.run(true);
