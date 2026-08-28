import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

// #1031: an entry that only stays inside the working directory LEXICALLY, via
// a real in-tree symlink, must also be skipped -- proves readModuleLocks uses
// the real realpath-based isWithinWorkingDirectory helper, not a hand-rolled
// lexical-only check. cwd is pinned to a fresh tmpdir (own spawned child
// process, so chdir here cannot affect any other test).
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdr-manifest-symlink-'));
const workDir = path.join(root, 'work');
const outside = path.join(root, 'outside');
fs.mkdirSync(workDir);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'modules.json'), JSON.stringify({ Modules: [{ Key: 'leaked' }] }));
fs.symlinkSync(outside, path.join(workDir, 'link'), 'junction');
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
tr.setInput('moduleManifest', 'link/modules.json');
tr.setInput('failOnDrift', 'false');

tr.run();
