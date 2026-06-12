import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const testDir = path.join(os.tmpdir(), 'tpc-opa-fail');
fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(path.join(testDir, 'policies'), { recursive: true });
const planFile = path.join(testDir, 'plan.json');
fs.writeFileSync(planFile, '{}');
const policyDir = path.join(testDir, 'policies');

tr.setInput('engine', 'opa');
tr.setInput('inputFile', planFile);
tr.setInput('policySource', 'path');
tr.setInput('policyPath', policyDir);
tr.setInput('publishTestResults', 'false');

const opaPath = '/usr/bin/opa';
const a: ma.TaskLibAnswers = {
    which: { opa: opaPath },
    checkPath: { [opaPath]: true },
    exec: {
        [`${opaPath} exec --decision terraform/deny --bundle ${policyDir} ${planFile}`]: {
            code: 0,
            stdout: JSON.stringify({ result: [{ path: planFile, result: ['S3 bucket must not be public', 'Instance must be tagged'] }] })
        }
    }
};
tr.setAnswers(a);
tr.run();
