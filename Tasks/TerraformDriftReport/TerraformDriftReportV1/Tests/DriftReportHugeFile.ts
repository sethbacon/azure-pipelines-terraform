import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');
import os = require('os');

// A sparse file just over the 100 MB MAX_PLAN_JSON_BYTES guard: ftruncate sets
// the reported size without writing 100 MB of bytes, so statSync trips the guard
// before the task ever reads/parses it (#632). Cross-platform and fast.
const planPath = path.join(os.tmpdir(), 'tdr-huge-plan.json');
const fd = fs.openSync(planPath, 'w');
fs.ftruncateSync(fd, 100 * 1024 * 1024 + 1);
fs.closeSync(fd);

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('planJsonFile', planPath);
tr.setInput('includeModuleProvenance', 'false');

tr.run();
