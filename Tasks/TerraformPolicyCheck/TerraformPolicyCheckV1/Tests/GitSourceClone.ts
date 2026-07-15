import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const FIXED_UUID = 'fixed-clone-uuid';
const cloneDir = path.join(os.tmpdir(), `policy-repo-${FIXED_UUID}`);

const testDir = path.join(os.tmpdir(), 'tpc-git');
fs.rmSync(testDir, { recursive: true, force: true });
fs.rmSync(cloneDir, { recursive: true, force: true });
// The task writes its results file with O_EXCL; with a mocked fixed UUID a
// leftover from a previous local run would collide, so remove it up front.
fs.rmSync(path.join(os.tmpdir(), `policy-results-${FIXED_UUID}.txt`), { force: true });
fs.mkdirSync(testDir, { recursive: true });
// Pre-create the clone target so the post-clone existence check passes (clone is mocked).
fs.mkdirSync(cloneDir, { recursive: true });
const planFile = path.join(testDir, 'plan.json');
fs.writeFileSync(planFile, '{}');

// Deterministic uuid so the clone path (and thus the mocked git command) is predictable.
tr.registerMock('crypto', { randomUUID: () => FIXED_UUID });

tr.setInput('engine', 'opa');
tr.setInput('inputFile', planFile);
tr.setInput('policySource', 'gitUrl');
tr.setInput('policyRepoUrl', 'https://github.com/example/policies');
tr.setInput('policyRepoRef', 'main');
tr.setInput('publishTestResults', 'false');

const gitPath = '/usr/bin/git';
const opaPath = '/usr/bin/opa';
const a: ma.TaskLibAnswers = {
    which: { git: gitPath, opa: opaPath },
    checkPath: { [gitPath]: true, [opaPath]: true },
    exec: {
        [`${gitPath} clone --depth 1 --branch main -- https://github.com/example/policies ${cloneDir}`]: {
            code: 0, stdout: 'Cloning...'
        },
        [`${opaPath} exec --decision terraform/deny --bundle ${cloneDir} ${planFile}`]: {
            code: 0, stdout: JSON.stringify({ result: [{ path: planFile, result: [] }] })
        }
    }
};
tr.setAnswers(a);
tr.run();
