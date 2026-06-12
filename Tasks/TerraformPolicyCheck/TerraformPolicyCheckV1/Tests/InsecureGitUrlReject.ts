import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const testDir = path.join(os.tmpdir(), 'tpc-insecure');
fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(testDir, { recursive: true });
const planFile = path.join(testDir, 'plan.json');
fs.writeFileSync(planFile, '{}');

tr.setInput('engine', 'opa');
tr.setInput('inputFile', planFile);
tr.setInput('policyAgentPath', '/usr/bin/opa');
tr.setInput('policySource', 'gitUrl');
tr.setInput('policyRepoUrl', 'http://github.com/example/policies');
tr.setInput('publishTestResults', 'false');

const a: ma.TaskLibAnswers = {
    checkPath: { '/usr/bin/opa': true }
};
tr.setAnswers(a);
tr.run();
