import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

// #1031: moduleManifest names an arbitrary operator-supplied path -- containment
// alone doesn't guarantee it's actually a `.terraform/modules/modules.json`
// (always a single top-level JSON object). A manifest that parses cleanly but
// is some OTHER top-level JSON shape (here, an array) must also be skipped
// rather than forwarded verbatim into the callback body and the on-agent
// summary artifact. cwd is pinned to a fresh tmpdir (this fixture runs in its
// own spawned child process, so chdir here cannot affect any other test).
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdr-manifest-non-object-'));
process.chdir(workDir);

const manifestPath = path.join(workDir, 'modules.json');
// Well within the working directory -- containment passes -- but the wrong
// top-level shape: a real modules.json is always `{"Modules": [...]}`, never
// a bare array.
fs.writeFileSync(manifestPath, JSON.stringify([{ Key: 'unexpected-array-shape' }]));

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
tr.setInput('moduleManifest', 'modules.json');
tr.setInput('failOnDrift', 'false');

tr.run();
