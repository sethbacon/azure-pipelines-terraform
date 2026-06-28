import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const FIXED_UUID = 'fixed-sha-uuid';
const cloneDir = path.join(os.tmpdir(), `policy-repo-${FIXED_UUID}`);

const testDir = path.join(os.tmpdir(), 'tpc-sha');
fs.rmSync(testDir, { recursive: true, force: true });
fs.rmSync(cloneDir, { recursive: true, force: true });
fs.mkdirSync(testDir, { recursive: true });
fs.mkdirSync(cloneDir, { recursive: true });
const planFile = path.join(testDir, 'plan.json');
fs.writeFileSync(planFile, '{}');

tr.registerMock('crypto', { randomUUID: () => FIXED_UUID });

const sha = '0123456789abcdef0123456789abcdef01234567';
const token = 'secrettoken';
const header = `Authorization: Basic ${Buffer.from(`:${token}`).toString('base64')}`;
const url = 'https://github.com/example/private';

tr.setInput('engine', 'opa');
tr.setInput('inputFile', planFile);
tr.setInput('policySource', 'gitUrl');
tr.setInput('policyRepoUrl', url);
// A full 40-char SHA takes the clone --no-checkout + checkout path; a token
// exercises the http.extraheader auth branch.
tr.setInput('policyRepoRef', sha);
tr.setInput('policyRepoToken', token);
tr.setInput('publishTestResults', 'false');

const gitPath = '/usr/bin/git';
const opaPath = '/usr/bin/opa';
const a: ma.TaskLibAnswers = {
    which: { git: gitPath, opa: opaPath },
    checkPath: { [gitPath]: true, [opaPath]: true },
    exec: {
        [`${gitPath} -c http.extraheader=${header} clone --no-checkout -- ${url} ${cloneDir}`]: {
            code: 0, stdout: 'Cloning...'
        },
        [`${gitPath} -C ${cloneDir} checkout ${sha}`]: {
            code: 0, stdout: `HEAD is now at ${sha.slice(0, 7)}`
        },
        [`${opaPath} exec --decision terraform/deny --bundle ${cloneDir} ${planFile}`]: {
            code: 0, stdout: JSON.stringify({ result: [{ path: planFile, result: [] }] })
        }
    }
};
tr.setAnswers(a);
tr.run();
