import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('planJsonFile', path.join(os.tmpdir(), 'tdr-does-not-exist', 'nope.json'));
tr.setInput('includeModuleProvenance', 'false');

tr.run();
