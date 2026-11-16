import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

// A passing Sentinel run whose output carries logging commands. Sentinel prints
// what policies print(), and a policy can print values taken from the plan, so
// this output is not under the pipeline's control. None of the commands may
// reach the agent: if they did, the run would gain a variable, a warning and a
// Failed result despite every policy passing.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

// Unique per-run temp dir via fs.mkdtempSync instead of a predictable os.tmpdir()
// path, to avoid the insecure-temp-file symlink-race class (CodeQL js/insecure-temporary-file).
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpc-sentinel-logging-commands-'));
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
        [`${sentinelPath} apply`]: {
            code: 0,
            stdout: [
                'PASS - require-tags.sentinel',
                '##vso[task.setvariable variable=injected]pwned',
                '##vso[task.issue type=warning;]injected warning',
                '##vso[task.complete result=Failed;]injected failure',
            ].join('\n') + '\n'
        }
    }
};
tr.setAnswers(a);
tr.run();
