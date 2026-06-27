import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const dir = path.join(os.tmpdir(), 'tdr-sarif');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const planFile = path.join(dir, 'plan.json');
fs.writeFileSync(
    planFile,
    JSON.stringify({
        resource_changes: [
            { address: 'aws_instance.web', change: { actions: ['update'], before: { ami: 'ami-1' }, after: { ami: 'ami-2' } } },
            { address: 'aws_s3_bucket.gone', change: { actions: ['delete'], before: { bucket: 'b' }, after: null } },
            { address: 'data.aws_ami.x', change: { actions: ['read'] } },
        ],
    }),
);
const sarifPath = path.join(dir, 'drift.sarif');

tr.setInput('planJsonFile', planFile);
tr.setInput('includeModuleProvenance', 'false');
tr.setInput('failOnDrift', 'false');
tr.setInput('sarifOutput', 'true');
tr.setInput('sarifPath', sarifPath);

tr.run();
