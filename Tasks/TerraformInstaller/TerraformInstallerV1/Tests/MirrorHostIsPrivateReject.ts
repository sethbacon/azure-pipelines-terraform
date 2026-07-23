import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #799 (follow-up to #729): mirrorBaseUrl's host is a literal private/link-local
// address (the cloud metadata service). Unlike the registry path's download_url
// (dynamically returned by a remote API), mirrorBaseUrl is operator-configured --
// but the task must still refuse it outright before ever attempting a download.
const tp = path.join(__dirname, 'MirrorHostIsPrivateRejectL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', '1.9.8');
tr.setInput('downloadSource', 'mirror');
tr.setInput('mirrorBaseUrl', 'https://169.254.169.254/hashicorp/terraform');

tr.registerMock('os', {
  type: () => 'Windows_NT',
  arch: () => 'x64'
});

tr.registerMock('./http-client', {
  fetchJson: async (url: string) => {
    throw new Error('fetchJson should not be called for mirror download. Called with: ' + url);
  },
  downloadToFile: async (_url: string, _destPath: string, _timeoutMs: number, _isHostAllowed: (hostname: string) => void) => {
    throw new Error('downloadToFile should not be reached for a mirror host that is a literal private/link-local address');
  },
  DOWNLOAD_TIMEOUT_MS: 30000
});

tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./gpg-verifier', { verifyGpgSignature: async () => { } });
tr.registerMock('./cosign-verifier', { verifyCosignSignature: async () => { } });

tr.registerMock('crypto', {
  randomUUID: () => 'test-uuid-1234',
  createHash: (_algorithm: string) => ({
    update: (_data: any) => ({
      digest: (_encoding: string) => 'should-not-be-reached'
    })
  })
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
  findLocalTool: (_toolName: string, _version: string) => null,
  downloadTool: async (_url: string, _fileName: string) => {
    throw new Error('downloadTool should not be reached for a mirror host that is a private/link-local address');
  },
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
