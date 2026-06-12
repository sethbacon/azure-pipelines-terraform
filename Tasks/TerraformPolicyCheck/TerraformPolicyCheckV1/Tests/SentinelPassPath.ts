import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const testDir = path.join(os.tmpdir(), 'tpc-sentinel-pass');
fs.rmSync(testDir, { recursive: true, force: true });
const policyDir = path.join(testDir, 'policies');
fs.mkdirSync(policyDir, { recursive: true });
fs.writeFileSync(path.join(policyDir, 'require-tags.sentinel'), 'main = rule { true }\n');
const planFile = path.join(testDir, 'plan.json');
fs.writeFileSync(planFile, '{}');

tr.setInput('engine', 'sentinel');
tr.setInput('inputFile', planFile);
tr.setInput('policySource', 'path');
tr.setInput('policyPath', policyDir);
tr.setInput('defaultEnforcementLevel', 'soft-mandatory');
tr.setInput('publishTestResults', 'false');

const sentinelPath = '/usr/bin/sentinel';
const a: ma.TaskLibAnswers = {
    which: { sentinel: sentinelPath },
    checkPath: { [sentinelPath]: true },
    exec: {
        [`${sentinelPath} apply`]: { code: 0, stdout: 'PASS - require-tags.sentinel\n' }
    }
};
tr.setAnswers(a);
tr.run();
