import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #189 (sibling azure-pipelines-packer #189): every other scenario in this suite
// runs Tests/RunInstaller.js — a re-implementation of the task entry point that
// calls downloadTerraform() and stops there. The REAL entry point (src/index.ts, the
// file task.json's Node24/Node20_1 handlers point the ADO agent at) was loaded by
// no test and excluded from the coverage metric, so its PATH-prepend decision and
// its post-install `terraform version` verification shipped unverified.
//
// This scenario points the mock runner at ../src/index.js itself. PATH is set to a
// value that does NOT start with the install directory, so the prepend branch is
// taken; `terraform version` is answered so the verify step completes.
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
        [`${toolPath} version`]: { code: 0, stdout: 'Terraform v1.9.5', stderr: '' }
    }
};

tr.setAnswers(a);
tr.run();
