import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #799 (follow-up to #729): mirrorBaseUrl's host is a literal private/link-local
// address (the cloud metadata service). Unlike the registry path's download_url
// (dynamically returned by a remote API), mirrorBaseUrl is operator-configured --
// but the task must still refuse it outright before ever attempting a download.
const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('policyAgent', 'opa');
tr.setInput('version', '1.17.1');
tr.setInput('downloadSource', 'mirror');
tr.setInput('mirrorBaseUrl', 'https://169.254.169.254');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

tr.registerMock('./http-client', {
  fetchJson: async (url: string) => { throw new Error('Mirror path should not call fetchJson: ' + url); },
  downloadToFile: async (_url: string, _destPath: string, _timeoutMs: number, _isHostAllowed: (hostname: string) => void) => {
    throw new Error('downloadToFile should not be reached for a mirror host that is a literal private/link-local address');
  },
  DOWNLOAD_TIMEOUT_MS: 30000
});

tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./gpg-verifier', { verifyGpgSignature: async () => { } });

tr.registerMock('crypto', {
  randomUUID: () => 'test-uuid',
  createHash: () => ({ update: () => ({ digest: () => 'should-not-be-reached' }) })
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
  findLocalTool: () => null,
  downloadTool: async () => {
    throw new Error('downloadTool should not be reached for a mirror host that is a private/link-local address');
  },
  extractZip: async () => { throw new Error('extractZip should not be called for OPA'); },
  cacheDir: async () => '/tmp/opa-cached',
  cleanVersion: (v: string) => v,
  prependPath: () => { }
});

const a: ma.TaskLibAnswers = {
  find: { '/tmp/opa-cached': ['/tmp/opa-cached/opa'] }
};
tr.setAnswers(a);
tr.run();
