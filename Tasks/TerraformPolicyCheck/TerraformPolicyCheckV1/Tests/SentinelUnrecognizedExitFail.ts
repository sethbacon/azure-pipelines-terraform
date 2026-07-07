import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

// #448: Sentinel's documented exit codes are 0 (pass), 1/2 (policy failed), 3/9
// (runtime error, already handled). An unrecognized code (e.g. 137 = SIGKILL, an
// OOM-killed process) must NOT silently fall through to a policy pass — assert
// the task fails closed instead.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const testDir = path.join(os.tmpdir(), 'tpc-sentinel-unrecognized-exit');
fs.rmSync(testDir, { recursive: true, force: true });
const policyDir = path.join(testDir, 'policies');
fs.mkdirSync(policyDir, { recursive: true });
fs.writeFileSync(path.join(policyDir, 'deny-public.sentinel'), 'main = rule { true }\n');
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
    // 137 = SIGKILL (e.g. OOM-killed); not one of Sentinel's documented codes.
    [`${sentinelPath} apply`]: { code: 137, stdout: '' }
  }
};
tr.setAnswers(a);
tr.run();
