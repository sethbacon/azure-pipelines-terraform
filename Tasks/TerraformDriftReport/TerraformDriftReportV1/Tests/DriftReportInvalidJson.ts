import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');
import os = require('os');

const planPath = path.join(os.tmpdir(), 'tdr-invalid-plan.json');
fs.writeFileSync(planPath, '{not valid json', 'utf8');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('planJsonFile', planPath);
tr.setInput('includeModuleProvenance', 'false');

tr.run();
