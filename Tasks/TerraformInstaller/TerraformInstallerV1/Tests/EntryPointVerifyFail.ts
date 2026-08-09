import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #189, failure half: the real src/index.ts must FAIL CLOSED when the
// post-install `terraform version` verification does not succeed — a download that
// produced an unusable binary must not be reported as a successful install.
// Exercises index.ts's catch branch, which the re-implemented
// Tests/RunInstaller.js entry never covered.

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const installDir = path.join(path.sep + 'opt', 'hostedtoolcache', 'terraform', '1.9.5', 'x64');
const toolPath = path.join(installDir, 'terraform');

tr.setInput('terraformVersion', '1.9.5');

// Download-strategy selection and verification are covered exhaustively by the
// other scenarios via RunInstaller; this one is about the entry point's own wiring.
tr.registerMock('./terraform-installer', {
    downloadTerraform: async (_version: string) => toolPath
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
    which: { 'terraform': toolPath },
    checkPath: { [toolPath]: true },
    exec: {
        [`${toolPath} version`]: { code: 1, stdout: '', stderr: 'terraform: cannot execute binary file' }
    }
};

tr.setAnswers(a);
tr.run();
