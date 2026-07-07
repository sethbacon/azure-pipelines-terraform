import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('policyAgent', 'sentinel');
tr.setInput('version', '0.40.0');
tr.setInput('downloadSource', 'mirror');
tr.setInput('mirrorBaseUrl', 'https://mirror.example.com');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

// A NON-404 mirror SHA256SUMS fetch failure (e.g. a 5xx after http-client retries)
// must be FATAL, not treated as "checksum absent". fetchTextAllow404 returns null
// ONLY for a genuine 404; here it throws, so the Sentinel install must fail closed.
tr.registerMock('./http-client', {
  fetchJson: async (url: string) => { throw new Error('Mirror path should not call fetchJson: ' + url); },
  fetchTextAllow404: async () => {
    throw new Error('HTTP 503 fetching SHA256SUMS (server error, exhausted retries)');
  }
});

tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./gpg-verifier', { verifyGpgSignature: async () => { } });

tr.registerMock('fs', {
  chmodSync: () => { },
  readFileSync: () => Buffer.from('fake-zip')
});

tr.registerMock('crypto', {
  randomUUID: () => 'test-uuid',
  createHash: () => ({ update: () => ({ digest: () => 'deadbeef' }) })
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
  findLocalTool: () => null,
  downloadTool: async () => '/tmp/sentinel.zip',
  extractZip: async () => '/tmp/sentinel-extracted',
  cacheDir: async () => '/tmp/sentinel-cached',
  cleanVersion: (v: string) => v,
  prependPath: () => { }
});

const a: ma.TaskLibAnswers = {
  find: { '/tmp/sentinel-cached': ['/tmp/sentinel-cached/sentinel'] }
};
tr.setAnswers(a);
tr.run();
