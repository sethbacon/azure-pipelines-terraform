import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

// Audit id19 (2026-07-20): the default failMode ('nonEmpty') expects a
// collection (array/object) of violations. A decisionPath pointed at a rule
// that evaluates to a bare scalar (here: `true`) previously fell through to
// "no violations" silently -- a fail-open policy-gate bug. It must now fail
// loudly instead of passing.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpc-opa-nonempty-scalar-'));
fs.mkdirSync(path.join(testDir, 'policies'), { recursive: true });
const planFile = path.join(testDir, 'plan.json');
fs.writeFileSync(planFile, '{}');
const policyDir = path.join(testDir, 'policies');

tr.setInput('engine', 'opa');
tr.setInput('inputFile', planFile);
tr.setInput('policySource', 'path');
tr.setInput('policyPath', policyDir);
tr.setInput('decisionPath', 'terraform/deny');
// failMode intentionally left unset -- exercises the 'nonEmpty' default.
tr.setInput('publishTestResults', 'false');

const opaPath = '/usr/bin/opa';
const a: ma.TaskLibAnswers = {
    which: { opa: opaPath },
    checkPath: { [opaPath]: true },
    exec: {
        [`${opaPath} exec --decision terraform/deny --bundle ${policyDir} ${planFile}`]: {
            code: 0,
            // A scalar `true` decision -- neither an array nor an object -- under
            // the default 'nonEmpty' failMode.
            stdout: JSON.stringify({ result: [{ path: planFile, result: true }] })
        }
    }
};
tr.setAnswers(a);
tr.run();
