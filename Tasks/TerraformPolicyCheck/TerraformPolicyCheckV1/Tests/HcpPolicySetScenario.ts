import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

// hcpPolicySet through the real entry point. One file, several scenarios:
// HCP_POLICY_SET_SCENARIO picks the engine, the policy set and the engine's
// answer, so each L0 case runs src/index.ts end to end.
//
// The Sentinel answers are reports Sentinel 0.41.0 produced (fixtures/policy-sets);
// the OPA answers have the shape OPA 1.22.4's `opa exec` printed.
const scenario = process.env['HCP_POLICY_SET_SCENARIO'] || '';
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const FIXED_UUID = 'fixed-policy-set-uuid';
// A fresh, unpredictable directory (mkdtemp), removed when the run ends.
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), `tpc-hcp-policy-set-${scenario}-`));
process.on('exit', () => fs.rmSync(testDir, { recursive: true, force: true }));
const policyDir = path.join(testDir, 'set');
fs.mkdirSync(policyDir, { recursive: true });
const planFile = path.join(testDir, 'plan.json');
fs.writeFileSync(planFile, '{"format_version":"1.2","resource_changes":[]}');
const agentTemp = path.join(testDir, 'agent-temp');
fs.mkdirSync(agentTemp, { recursive: true });
process.env['AGENT_TEMPDIRECTORY'] = agentTemp;
tr.registerMock('crypto', { randomUUID: () => FIXED_UUID });

const fixture = (name: string): { exitCode: number; stdout: string } =>
    JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'policy-sets', `${name}.json`), 'utf-8'));
const opaOutput = (result: unknown): string =>
    JSON.stringify({ result: [{ decision_id: '00000000-0000-0000-0000-000000000000', path: 'input.json', result }] });

tr.setInput('inputFile', planFile);
tr.setInput('policySource', 'path');
tr.setInput('policyPath', policyDir);
tr.setInput('hcpPolicySet', 'true');
tr.setInput('publishTestResults', 'false');

const sentinelPath = '/usr/bin/sentinel';
const opaPath = '/usr/bin/opa';
const exec: ma.TaskLibAnswers['exec'] = {};

if (scenario.startsWith('sentinel')) {
    tr.setInput('engine', 'sentinel');
    fs.writeFileSync(path.join(policyDir, 'sentinel.hcl'), 'policy "no-forbidden" {\n  source = "./no-forbidden.sentinel"\n  enforcement_level = "hard-mandatory"\n}\n');
    const report = fixture(scenario === 'sentinel-blocking' ? 'sentinel-mixed-levels' : 'sentinel-advisory-only-failure');
    const config = path.join(agentTemp, `sentinel-config-${FIXED_UUID}`, 'sentinel.hcl');
    exec[`${sentinelPath} apply -json -config ${config}`] = { code: report.exitCode, stdout: report.stdout };
    if (scenario === 'sentinel-with-config') {
        tr.setInput('sentinelConfigPath', path.join(policyDir, 'sentinel.hcl'));
    }
} else {
    tr.setInput('engine', 'opa');
    fs.writeFileSync(path.join(policyDir, 'policies.hcl'),
        'policy "no-forbidden" {\n  query = "data.terraform.files.deny"\n  enforcement_level = "mandatory"\n}\n' +
        'policy "tagging" {\n  query = "data.terraform.files.warn"\n}\n');
    const input = path.join(agentTemp, `opa-input-${FIXED_UUID}`, 'input.json');
    const deny = scenario === 'opa-blocking' ? ["local_file.bad: content must not be 'forbidden'"] : [];
    exec[`${opaPath} exec --decision terraform/files/deny --bundle ${policyDir} ${input}`] = { code: 0, stdout: opaOutput(deny) };
    exec[`${opaPath} exec --decision terraform/files/warn --bundle ${policyDir} ${input}`] = { code: 0, stdout: opaOutput(['local_file.bad: consider tagging']) };
}

const a: ma.TaskLibAnswers = {
    which: { sentinel: sentinelPath, opa: opaPath },
    checkPath: { [sentinelPath]: true, [opaPath]: true },
    exec,
};
tr.setAnswers(a);
tr.run();
