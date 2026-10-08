import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

// #1231: what a pipeline gets when it sets only mirrorUrl. The agent supplies
// allowDirectFallback's task.json default of true; the mock runner applies no
// defaults, so it is set here. The mirror matches every provider, so the
// generated file must not also offer direct for them.
const tempDir = path.join(os.tmpdir(), 'tpm-defaults-mirror-only');
fs.rmSync(tempDir, { recursive: true, force: true });
fs.mkdirSync(tempDir, { recursive: true });
process.env['AGENT_TEMPDIRECTORY'] = tempDir;

tr.setInput('mirrorUrl', 'https://registry.example.com/terraform/providers');
tr.setInput('allowDirectFallback', 'true');

tr.run();
