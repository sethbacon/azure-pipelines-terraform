import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// The real entry point's post-install check runs `<agent> version` for OPA and
// Sentinel. tfpolicy-plugin has no such command -- its only one is `rpcapi`,
// which Terraform calls -- so the same check would fail every install of it.
// Only `--version` is answered here: any other argument has no mock answer and
// fails the run.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const toolPath = path.join(path.sep + 'opt', 'hostedtoolcache', 'tfpolicy-plugin', '0.5.0', 'x64', 'tfpolicy-plugin');

tr.setInput('version', '0.5.0');
tr.setInput('policyAgent', 'tfpolicy-plugin');
tr.setInput('downloadSource', 'official');

tr.registerMock('./policy-agent-installer', {
    TERRAFORM_POLICY_PLUGIN_AGENT: 'tfpolicy-plugin',
    downloadPolicyAgent: async (_version: string) => toolPath
});
tr.registerMock('azure-pipelines-tool-lib/tool', { prependPath: () => { } });

process.env['PATH'] = path.join(path.sep + 'usr', 'bin');

const a: ma.TaskLibAnswers = {
    which: { 'tfpolicy-plugin': toolPath },
    checkPath: { [toolPath]: true },
    exec: {
        [`${toolPath} --version`]: { code: 0, stdout: '0.5.0', stderr: '' }
    }
};

tr.setAnswers(a);
tr.run();
