import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const dir = path.join(os.tmpdir(), 'tdr-fail');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const planFile = path.join(dir, 'plan.json');
fs.writeFileSync(planFile, JSON.stringify({
    resource_changes: [
        { address: 'aws_instance.gone', change: { actions: ['delete'], before: { ami: 'ami-1' }, after: null } },
    ],
}));

tr.setInput('planJsonFile', planFile);
tr.setInput('includeModuleProvenance', 'false');
tr.setInput('failOnDrift', 'true');

tr.run();
