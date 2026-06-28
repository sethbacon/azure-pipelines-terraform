import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const FIXED_UUID = 'fixed-traversal-uuid';
const cloneDir = path.join(os.tmpdir(), `policy-repo-${FIXED_UUID}`);

const testDir = path.join(os.tmpdir(), 'tpc-traversal');
fs.rmSync(testDir, { recursive: true, force: true });
fs.rmSync(cloneDir, { recursive: true, force: true });
fs.mkdirSync(testDir, { recursive: true });
fs.mkdirSync(cloneDir, { recursive: true });
const planFile = path.join(testDir, 'plan.json');
fs.writeFileSync(planFile, '{}');

tr.registerMock('crypto', { randomUUID: () => FIXED_UUID });

tr.setInput('engine', 'opa');
tr.setInput('inputFile', planFile);
tr.setInput('policyAgentPath', '/usr/bin/opa');
tr.setInput('policySource', 'gitUrl');
tr.setInput('policyRepoUrl', 'https://github.com/example/policies');
tr.setInput('policyRepoRef', 'main');
// `../../` escapes the clone dir — must be rejected after the clone.
tr.setInput('policyRepoSubdir', '../../etc');
tr.setInput('publishTestResults', 'false');

const gitPath = '/usr/bin/git';
const a: ma.TaskLibAnswers = {
    which: { git: gitPath },
    checkPath: { [gitPath]: true, '/usr/bin/opa': true },
    exec: {
        [`${gitPath} clone --depth 1 --branch main -- https://github.com/example/policies ${cloneDir}`]: {
            code: 0, stdout: 'Cloning...'
        }
    }
};
tr.setAnswers(a);
tr.run();
