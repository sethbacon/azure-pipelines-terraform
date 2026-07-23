import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #799 (follow-up to #729): mirrorBaseUrl's own host is benign, but the (simulated)
// download follows a redirect to the cloud metadata address 169.254.169.254 --
// proving the mirror path re-validates every redirect hop via downloadToFile, not
// just the initial host (mirrors the registry path's #729 follow-up fix).
const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('policyAgent', 'opa');
tr.setInput('version', '1.17.1');
tr.setInput('downloadSource', 'mirror');
tr.setInput('mirrorBaseUrl', 'https://mirror.example.com');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

// dns: the mirror host itself is benign (this test is about the REDIRECT hop,
// not the initial host); mock it to a public address so the initial-host check
// passes without a real network lookup, reaching the downloadToFile call.
tr.registerMock('dns', {
  promises: {
    lookup: async (_host: string, _opts: any) => [{ address: '203.0.113.10', family: 4 }]
  }
});

tr.registerMock('./http-client', {
  fetchJson: async (url: string) => { throw new Error('Mirror path should not call fetchJson: ' + url); },
  downloadToFile: async (_url: string, _destPath: string, _timeoutMs: number, isHostAllowed: (hostname: string) => void) => {
    // Simulate a redirect hop landing on the cloud metadata service.
    isHostAllowed('169.254.169.254');
  },
  DOWNLOAD_TIMEOUT_MS: 30000
});

tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./gpg-verifier', { verifyGpgSignature: async () => { } });

tr.registerMock('fs', {
  chmodSync: () => { },
  readFileSync: () => Buffer.from('fake-binary')
});

tr.registerMock('crypto', {
  randomUUID: () => 'test-uuid',
  createHash: () => ({ update: () => ({ digest: () => 'should-not-be-reached' }) })
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
  findLocalTool: () => null,
  downloadTool: async () => {
    throw new Error('downloadTool should not be reached -- downloadToFile must be used so every redirect hop is re-validated');
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
