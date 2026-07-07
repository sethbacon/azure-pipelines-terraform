import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// Reuses the generic MirrorCustomUrlSuccessL0 entry (runs downloadTerraform).
const tp = path.join(__dirname, 'MirrorCustomUrlSuccessL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', '1.9.8');
tr.setInput('downloadSource', 'mirror');
tr.setInput('mirrorBaseUrl', 'https://artifacts.example.com/hashicorp/terraform');

tr.registerMock('os', {
  type: () => 'Windows_NT',
  arch: () => 'x64'
});

// A NON-404 mirror SHA256SUMS fetch failure (e.g. a 5xx after the retries baked into
// http-client) must be FATAL, not classified as "checksum absent". fetchTextAllow404
// returns null ONLY for a genuine 404; here it throws, so the install must fail closed
// even though requireChecksum / requireGpgSignature are left at their (true) defaults.
tr.registerMock('./http-client', {
  fetchJson: async (url: string) => {
    throw new Error('fetchJson should not be called for mirror download. Called with: ' + url);
  },
  fetchTextAllow404: async () => {
    throw new Error('HTTP 503 fetching SHA256SUMS (server error, exhausted retries)');
  }
});

tr.registerMock('crypto', { randomUUID: () => 'test-uuid-1234' });
tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./gpg-verifier', {
  verifyGpgSignature: async (_sha256SumsContent: string, _signatureUrl: string) => { }
});
tr.registerMock('./cosign-verifier', {
  verifyCosignSignature: async () => { }
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
  findLocalTool: (_toolName: string, _version: string) => null,
  downloadTool: async (_url: string, _fileName: string) => '/tmp/terraform.zip',
  extractZip: async (_zipPath: string) => '/tmp/terraform-extracted',
  cacheDir: async (_srcPath: string, _tool: string, _version: string) => '/tmp/terraform-cached',
  cleanVersion: (version: string) => version,
  prependPath: (_toolPath: string) => { }
});

const a: ma.TaskLibAnswers = {
  'find': {
    '/tmp/terraform-cached': ['/tmp/terraform-cached/terraform.exe']
  }
};

tr.setAnswers(a);
tr.run();
