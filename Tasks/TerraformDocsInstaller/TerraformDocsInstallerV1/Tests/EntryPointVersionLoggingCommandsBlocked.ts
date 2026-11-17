import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// The post-install `terraform-docs version` check runs the binary the task just installed.
// Its output must not be able to drive the agent: if the logging commands below
// reached it, the run would gain a variable, a warning and a Failed result.
// Otherwise identical to EntryPointInstallSuccess, which it is derived from.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const installDir = path.join(path.sep + 'opt', 'hostedtoolcache', 'terraform-docs', '0.19.0', 'x64');
const toolPath = path.join(installDir, 'terraform-docs');

tr.setInput('version', '0.19.0');
tr.setInput('downloadSource', 'official');

// Download-strategy selection and verification are covered exhaustively by the
// other scenarios via RunInstaller; this one is about the entry point's own wiring.
tr.registerMock('./terraform-docs-installer', {
    downloadTerraformDocs: async (_version: string) => toolPath
});

// The prepend is asserted from Tests/L0.ts against this marker rather than after
// tr.run() below: run() returns before the task's own async run() promise settles,
// so an in-file assertion would always read the pre-call value.
tr.registerMock('azure-pipelines-tool-lib/tool', {
    prependPath: (target: string) => {
        console.log(`EntryPoint test: prependPath(${target})`);
    }
});

process.env['PATH'] = path.join(path.sep + 'usr', 'bin');

const a: ma.TaskLibAnswers = {
    which: { 'terraform-docs': toolPath },
    checkPath: { [toolPath]: true },
    exec: {
        [`${toolPath} version`]: { code: 0, stdout: 'terraform-docs version v0.19.0\n##vso[task.setvariable variable=injected]pwned\n##vso[task.issue type=warning;]injected warning\n##vso[task.complete result=Failed;]injected failure', stderr: '' }
    }
};

tr.setAnswers(a);
tr.run();
