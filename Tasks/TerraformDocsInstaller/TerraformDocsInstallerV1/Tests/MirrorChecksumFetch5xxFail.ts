import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('version', '0.24.0');
tr.setInput('downloadSource', 'mirror');
tr.setInput('mirrorBaseUrl', 'https://artifacts.example.com/terraform-docs');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

// dns: the mirror host is a fake test domain; mock it to a public (non-private/
// link-local) address so the #799 initial-host check passes without a real
// network lookup, reaching the checksum-fetch failure this test exercises.
tr.registerMock('dns', {
  promises: {
    lookup: async (_host: string, _opts: any) => [{ address: '203.0.113.10', family: 4 }]
  }
});

// A NON-404 mirror .sha256sum fetch failure (e.g. a 5xx after http-client retries)
// must be FATAL, not treated as "checksum absent". fetchTextAllow404 returns null
// ONLY for a genuine 404; here it throws, so the install must fail closed rather
// than silently skipping verification. Mirrors TerraformInstaller's
// MirrorChecksumFetch5xxFail.ts / PolicyAgentInstaller's MirrorSentinel5xxFail.ts.
tr.registerMock('./http-client', {
  fetchJson: async (url: string) => { throw new Error('Mirror path should not fetch json: ' + url); },
  fetchTextAllow404: async () => {
    throw new Error('HTTP 503 fetching .sha256sum (server error, exhausted retries)');
  },
  downloadToFile: async (_url: string, _destPath: string, _timeoutMs: number, isHostAllowed: (hostname: string) => void) => {
    // Mirror downloads now go through downloadToFile (#799); simulate a benign
    // successful download so the checksum-fetch failure under test is reached.
    isHostAllowed(new URL(_url).hostname);
  },
  DOWNLOAD_TIMEOUT_MS: 30000
});

tr.registerMock('undici', { ProxyAgent: class { } });

tr.registerMock('fs', {
  chmodSync: () => { },
  readFileSync: () => Buffer.from('fake-archive')
});

tr.registerMock('crypto', {
  randomUUID: () => 'test-uuid',
  createHash: () => ({ update: () => ({ digest: () => 'deadbeef' }) })
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
  findLocalTool: () => null,
  downloadTool: async () => {
    throw new Error('downloadTool should not be called for a mirror download -- downloadToFile must be used (#799)');
  },
  extractTar: async () => '/tmp/terraform-docs-extracted',
  extractZip: async () => { throw new Error('extractZip should not be called on Linux'); },
  cacheDir: async () => '/tmp/terraform-docs-cached',
  cleanVersion: (v: string) => v,
  prependPath: () => { }
});

const a: ma.TaskLibAnswers = {
  find: { '/tmp/terraform-docs-cached': ['/tmp/terraform-docs-cached/terraform-docs'] }
};
tr.setAnswers(a);
tr.run();
