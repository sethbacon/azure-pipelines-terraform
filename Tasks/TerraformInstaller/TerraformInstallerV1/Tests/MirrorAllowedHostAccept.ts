import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #799 follow-up: mirrorAllowedHosts is set and the mirror host is a PRIVATE IP
// address that would otherwise be refused by the default baseline check --
// proving an operator running a legitimate mirror on a private/internal
// address (e.g. an air-gapped environment) can opt back in, mirroring the
// registry path's registryAllowedHosts escape hatch exactly.
const tp = path.join(__dirname, 'MirrorAllowedHostAcceptL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', '1.9.8');
tr.setInput('downloadSource', 'mirror');
tr.setInput('mirrorBaseUrl', 'https://10.0.5.10/hashicorp/terraform');
tr.setInput('mirrorAllowedHosts', '10.0.5.10');
tr.setInput('requireChecksum', 'false');
tr.setInput('requireGpgSignature', 'false');

tr.registerMock('os', {
  type: () => 'Windows_NT',
  arch: () => 'x64',
  tmpdir: () => '/tmp'
});

tr.registerMock('./http-client', {
  fetchJson: async (url: string) => {
    throw new Error('fetchJson should not be called for mirror download. Called with: ' + url);
  },
  fetchTextAllow404: async () => null, // no SHA256SUMS; requireChecksum=false -> warn + proceed
  downloadToFile: async (url: string, _destPath: string, _timeoutMs: number, isHostAllowed: (hostname: string) => void) => {
    // Genuinely exercises the isHostAllowed callback terraform-installer.ts
    // builds (real isRegistryHostAllowed logic against mirrorAllowedHosts),
    // proving the pinned private-IP host is accepted rather than refused by
    // the default baseline private/link-local check.
    isHostAllowed(new URL(url).hostname);
  },
  DOWNLOAD_TIMEOUT_MS: 30000
});

tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./gpg-verifier', { verifyGpgSignature: async () => { } });
tr.registerMock('./cosign-verifier', { verifyCosignSignature: async () => { } });

tr.registerMock('crypto', { randomUUID: () => 'test-uuid-1234' });

tr.registerMock('azure-pipelines-tool-lib/tool', {
  findLocalTool: (_toolName: string, _version: string) => null,
  downloadTool: async (_url: string, _fileName: string) => {
    throw new Error('downloadTool should not be called for a mirror download -- downloadToFile must be used (#799)');
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
