import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

// Deterministic temp dir so the L0 case can read back the .terraformrc index.ts
// writes there — it must retain the mirror credential (terraform needs it), while
// the console echo of the config must not (#586).
const tempDir = path.join(os.tmpdir(), 'tpm-userinfo');
fs.rmSync(tempDir, { recursive: true, force: true });
fs.mkdirSync(tempDir, { recursive: true });
process.env['AGENT_TEMPDIRECTORY'] = tempDir;

tr.setInput('mirrorUrl', 'https://user:s3cr3t@mirror.example.com/terraform/providers');
tr.setInput('allowDirectFallback', 'false');

tr.run();
