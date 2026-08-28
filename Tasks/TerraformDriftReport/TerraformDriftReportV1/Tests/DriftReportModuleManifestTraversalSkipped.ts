import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

// #1031: moduleManifest had zero working-directory containment. A traversal
// value must be skipped (module_locks omitted, task still succeeds) rather
// than read from an arbitrary path. cwd is pinned to a fresh tmpdir (this
// fixture runs in its own spawned child process, so chdir here cannot affect
// any other test) since readModuleLocks checks containment against
// process.cwd() -- this task has no workingDirectory input of its own.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdr-manifest-traversal-'));
process.chdir(workDir);

const planFile = path.join(workDir, 'plan.json');
fs.writeFileSync(
    planFile,
    JSON.stringify({
        resource_changes: [
            { address: 'aws_instance.new', change: { actions: ['create'], before: null, after: { ami: 'ami-1' } } },
        ],
    }),
);

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('planJsonFile', planFile);
tr.setInput('includeModuleProvenance', 'true');
// Escapes the working directory -- must be skipped, not read.
tr.setInput('moduleManifest', '../evil-modules.json');
tr.setInput('failOnDrift', 'false');

tr.run();
