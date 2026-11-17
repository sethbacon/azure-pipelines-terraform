import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');

// Every Sentinel run whose working directory is the policy source, through the
// real entry point. SENTINEL_CACHE_SCENARIO picks the entry point;
// SENTINEL_CACHE_ROOT is a directory the L0 test created, holding the policy
// source (policy/, with a stale .sentinel cache already in it) and the agent
// temp directory (agent-temp/). The L0 test checks the cache afterwards.
const scenario = process.env['SENTINEL_CACHE_SCENARIO'] || '';
const root = process.env['SENTINEL_CACHE_ROOT'] || '';
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const FIXED_UUID = 'fixed-sentinel-cache-uuid';
tr.registerMock('crypto', { randomUUID: () => FIXED_UUID });
const policyDir = path.join(root, 'policy');
const agentTemp = path.join(root, 'agent-temp');
process.env['AGENT_TEMPDIRECTORY'] = agentTemp;
const planFile = path.join(root, 'plan.json');
fs.writeFileSync(planFile, '{"format_version":"1.2","resource_changes":[]}');
fs.writeFileSync(path.join(policyDir, 'sentinel.hcl'), 'policy "has-files" {\n  source = "./has-files.sentinel"\n  enforcement_level = "hard-mandatory"\n}\n');

const fixture = (dir: string, name: string): { exitCode: number; stdout: string } =>
    JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', dir, `${name}.json`), 'utf-8'));

const sentinelPath = '/usr/bin/sentinel';
tr.setInput('engine', 'sentinel');
tr.setInput('policySource', 'path');
tr.setInput('policyPath', policyDir);
tr.setInput('publishTestResults', 'false');

const exec: ma.TaskLibAnswers['exec'] = {};
if (scenario === 'hcp-policy-set') {
    tr.setInput('inputFile', planFile);
    tr.setInput('hcpPolicySet', 'true');
    const report = fixture('policy-sets', 'sentinel-all-pass');
    const config = path.join(agentTemp, `sentinel-config-${FIXED_UUID}`, 'sentinel.hcl');
    exec[`${sentinelPath} apply -json -config ${config}`] = { code: report.exitCode, stdout: report.stdout };
} else if (scenario === 'test-mode') {
    tr.setInput('mode', 'test');
    const report = fixture('policy-tests', 'sentinel-all-pass');
    exec[`${sentinelPath} test -json`] = { code: report.exitCode, stdout: report.stdout };
} else if (scenario === 'own-config') {
    tr.setInput('inputFile', planFile);
    tr.setInput('sentinelConfigPath', path.join(policyDir, 'sentinel.hcl'));
    exec[`${sentinelPath} apply`] = { code: 0, stdout: 'PASS - has-files.sentinel\n' };
} else {
    throw new Error(`unknown SENTINEL_CACHE_SCENARIO '${scenario}'`);
}

tr.setAnswers({
    which: { sentinel: sentinelPath },
    checkPath: { [sentinelPath]: true },
    exec,
});
tr.run();
