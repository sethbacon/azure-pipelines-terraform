import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

// #960: directIncludePatterns set with no matching mirrorExcludePatterns entry --
// the mirror is still consulted for this provider, so the task should warn.
const tempDir = path.join(os.tmpdir(), 'tpm-direct-include-no-mirror-exclude');
fs.rmSync(tempDir, { recursive: true, force: true });
fs.mkdirSync(tempDir, { recursive: true });
process.env['AGENT_TEMPDIRECTORY'] = tempDir;

tr.setInput('mirrorUrl', 'https://registry.example.com/terraform/providers');
tr.setInput('allowDirectFallback', 'true');
tr.setInput('directIncludePatterns', 'registry.terraform.io/hashicorp/time');

tr.run();
