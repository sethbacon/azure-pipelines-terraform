import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const FIXED_UUID = 'fixed-userinfo-uuid';
const cloneDir = path.join(os.tmpdir(), `policy-repo-${FIXED_UUID}`);

// Unique per-run temp dir via fs.mkdtempSync instead of a predictable os.tmpdir()
// path, to avoid the insecure-temp-file symlink-race class (CodeQL js/insecure-temporary-file).
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpc-userinfo-'));
fs.rmSync(cloneDir, { recursive: true, force: true });
// The task writes its results file with O_EXCL; with a mocked fixed UUID a
// leftover from a previous local run would collide, so remove it up front.
fs.rmSync(path.join(os.tmpdir(), `policy-results-${FIXED_UUID}.txt`), { force: true });
const planFile = path.join(testDir, 'plan.json');
fs.writeFileSync(planFile, '{}');

tr.registerMock('crypto', { randomUUID: () => FIXED_UUID });

// #1105 finding 1: a PAT smuggled into the clone URL as userinfo must be refused
// before git ever runs, and the refusal must not echo it. No exec answer is
// registered for git, so if the guard were missing the run would fail LATER,
// for a different reason (an unanswered clone), which the L0 assertion tells
// apart from the guard's own message -- and it checks that the secret never
// reaches stdout/stderr either way.
tr.setInput('engine', 'opa');
tr.setInput('inputFile', planFile);
tr.setInput('policySource', 'gitUrl');
tr.setInput('policyRepoUrl', 'https://svc:PAT-s3cr3t-value@github.com/example/policies');
tr.setInput('policyRepoRef', 'main');
tr.setInput('publishTestResults', 'false');

const a: ma.TaskLibAnswers = {
  which: { git: '/usr/bin/git', opa: '/usr/bin/opa' },
  checkPath: { '/usr/bin/git': true, '/usr/bin/opa': true },
};
tr.setAnswers(a);
tr.run();
