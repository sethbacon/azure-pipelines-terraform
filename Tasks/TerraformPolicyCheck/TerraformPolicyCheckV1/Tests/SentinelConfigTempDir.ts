import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const FIXED_UUID = 'fixed-tempdir-uuid';

const testDir = path.join(os.tmpdir(), 'tpc-sentinel-tempdir');
fs.rmSync(testDir, { recursive: true, force: true });
const policyDir = path.join(testDir, 'policies');
fs.mkdirSync(policyDir, { recursive: true });
fs.writeFileSync(path.join(policyDir, 'require-tags.sentinel'), 'main = rule { true }\n');
const planFile = path.join(testDir, 'plan.json');
fs.writeFileSync(planFile, '{}');

// Simulate the ADO agent's private, job-end-purged temp directory. Both the
// generated sentinel.hcl config dir and the raw-results file must land here,
// not in bare os.tmpdir() (issues #487, #503, #505).
const agentTemp = path.join(testDir, 'agent-temp');
fs.mkdirSync(agentTemp, { recursive: true });
process.env['AGENT_TEMPDIRECTORY'] = agentTemp;

tr.registerMock('crypto', { randomUUID: () => FIXED_UUID });

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
