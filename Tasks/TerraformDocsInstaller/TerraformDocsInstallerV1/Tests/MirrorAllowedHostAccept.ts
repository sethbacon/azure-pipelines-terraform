import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #799 follow-up: mirrorAllowedHosts is set and the mirror host is a PRIVATE IP
// address that would otherwise be refused by the default baseline check --
// proving an operator running a legitimate mirror on a private/internal
// address (e.g. an air-gapped environment) can opt back in, mirroring the
// registry path's registryAllowedHosts escape hatch exactly.
const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('version', '0.24.0');
tr.setInput('downloadSource', 'mirror');
tr.setInput('mirrorBaseUrl', 'https://10.0.5.10/terraform-docs');
tr.setInput('mirrorAllowedHosts', '10.0.5.10');
tr.setInput('requireChecksum', 'false');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

tr.registerMock('./http-client', {
  fetchJson: async (url: string) => { throw new Error('Mirror path should not fetch json: ' + url); },
  fetchTextAllow404: async () => null, // no .sha256sum; requireChecksum=false -> warn + proceed
  downloadToFile: async (url: string, _destPath: string, _timeoutMs: number, isHostAllowed: (hostname: string) => void) => {
    // Genuinely exercises the isHostAllowed callback against mirrorAllowedHosts,
    // proving the pinned private-IP host is accepted.
    isHostAllowed(new URL(url).hostname);
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
  createHash: () => ({ update: () => ({ digest: () => 'unused' }) })
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
