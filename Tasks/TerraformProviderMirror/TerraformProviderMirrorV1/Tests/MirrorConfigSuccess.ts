import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

// Deterministic temp dir under os.tmpdir() so the L0 case can read back the
// .terraformrc that index.ts writes there via Agent.TempDirectory.
const tempDir = path.join(os.tmpdir(), 'tpm-success');
fs.rmSync(tempDir, { recursive: true, force: true });
fs.mkdirSync(tempDir, { recursive: true });
process.env['AGENT_TEMPDIRECTORY'] = tempDir;

tr.setInput('mirrorUrl', 'https://registry.example.com/terraform/providers');
tr.setInput('allowDirectFallback', 'true');
tr.setInput('directExcludePatterns', 'registry.terraform.io/company-internal/*');

tr.run();
