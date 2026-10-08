import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

// #1231: a mirror limited to some providers. Direct serves the rest and must
// exclude exactly what the mirror includes, without the pipeline spelling it out.
const tempDir = path.join(os.tmpdir(), 'tpm-mirror-include-directs-the-rest');
fs.rmSync(tempDir, { recursive: true, force: true });
fs.mkdirSync(tempDir, { recursive: true });
process.env['AGENT_TEMPDIRECTORY'] = tempDir;

tr.setInput('mirrorUrl', 'https://registry.example.com/terraform/providers');
tr.setInput('allowDirectFallback', 'true');
tr.setInput('mirrorIncludePatterns', 'registry.terraform.io/hashicorp/*\nregistry.terraform.io/company-internal/*');

tr.run();
