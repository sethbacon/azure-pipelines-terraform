import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const testDir = path.join(os.tmpdir(), 'tpc-opa-multi-result-error');
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
// opa exec can return one result entry per input FILE it evaluated -- a directory
// input yields more than one. entry[0] here is clean; the error sits on entry[1],
// so a check that only ever inspects result[0] (the #1113 finding) would miss it
// entirely and report success instead of an evaluation error.
const a: ma.TaskLibAnswers = {
    which: { opa: opaPath },
    checkPath: { [opaPath]: true },
    exec: {
        [`${opaPath} exec --decision terraform/deny --bundle ${policyDir} ${planFile}`]: {
            code: 0,
            stdout: JSON.stringify({
                result: [
                    { path: `${planFile}/a.json`, result: [] },
                    { path: `${planFile}/b.json`, error: { code: 'eval_type_error', message: 'deny is not a set' } },
                ],
            }),
        },
    },
};
tr.setAnswers(a);
tr.run();
