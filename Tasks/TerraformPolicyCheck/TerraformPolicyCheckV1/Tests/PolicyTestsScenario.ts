import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

// mode: test through the real entry point. POLICY_TESTS_SCENARIO picks the
// engine, the mode and the engine's answer -- the real output captured in
// fixtures/policy-tests. No inputFile is set: test mode must not need one.
const scenario = process.env['POLICY_TESTS_SCENARIO'] || '';
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), `tpc-policy-tests-${scenario}-`));
process.on('exit', () => fs.rmSync(testDir, { recursive: true, force: true }));
const policyDir = path.join(testDir, 'repo');
fs.mkdirSync(path.join(policyDir, 'policies'), { recursive: true });
fs.mkdirSync(path.join(policyDir, 'tests'), { recursive: true });
process.env['AGENT_TEMPDIRECTORY'] = testDir;

const fixture = (name: string): { exitCode: number; stdout: string } =>
    JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'policy-tests', `${name}.json`), 'utf-8'));
const [engine, outcome] = scenario.split('-');

tr.setInput('mode', outcome === 'evaluate' ? 'evaluate' : outcome === 'badmode' ? 'audit' : 'test');
tr.setInput('engine', engine);
tr.setInput('policySource', 'path');
tr.setInput('policyPath', policyDir);
tr.setInput('publishTestResults', 'true');

const tools: Record<string, string> = { sentinel: '/usr/bin/sentinel', opa: '/usr/bin/opa', tfpolicy: '/usr/bin/tfpolicy', regula: '/usr/bin/regula' };
const commands: Record<string, string> = {
    sentinel: `${tools.sentinel} test -json`,
    opa: `${tools.opa} test --bundle --format=json ${policyDir}`,
    tfpolicy: `${tools.tfpolicy} test --policies=${path.join(policyDir, 'policies')} --tests=${path.join(policyDir, 'tests')}`,
};
const exec: ma.TaskLibAnswers['exec'] = {};
if (commands[engine]) {
    const answer = fixture(`${engine}-${outcome === 'pass' ? 'all-pass' : 'failures'}`);
    exec[commands[engine]] = { code: answer.exitCode, stdout: answer.stdout };
}

tr.setAnswers({
    which: tools,
    checkPath: Object.fromEntries(Object.values(tools).map(t => [t, true])),
    exec,
});
tr.run();
