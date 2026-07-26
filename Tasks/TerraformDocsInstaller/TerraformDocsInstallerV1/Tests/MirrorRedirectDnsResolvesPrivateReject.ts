import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #769: mirrorBaseUrl's own host is benign, but the redirect hop's Location host
// is an ordinary-looking DNS name (not a literal private IP) that resolves (via
// the mocked dns module below) to the cloud metadata address 169.254.169.254.
// Proves the mirror path's per-redirect-hop guard now also performs DNS
// resolution, mirroring the initial-host check, instead of only catching a
// literal private/link-local host/IP redirect target (see the sibling literal-IP
// MirrorRedirectToPrivateReject test).
const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('version', '0.24.0');
tr.setInput('downloadSource', 'mirror');
tr.setInput('mirrorBaseUrl', 'https://artifacts.example.com/terraform-docs');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

// dns: artifacts.example.com (the initial mirror host) resolves to a public
// address so that check passes; redirect.example.com (the simulated redirect
// hop's host) resolves to the cloud metadata address, proving the per-hop check
// performs its own DNS resolution rather than only checking for a literal
// private/link-local IP string.
tr.registerMock('dns', {
  promises: {
    lookup: async (host: string, _opts: any) =>
      host === 'redirect.example.com'
        ? [{ address: '169.254.169.254', family: 4 }]
        : [{ address: '203.0.113.10', family: 4 }]
  }
});

tr.registerMock('./http-client', {
  fetchJson: async (url: string) => { throw new Error('Mirror path should not fetch json: ' + url); },
  downloadToFile: async (_url: string, _destPath: string, _timeoutMs: number, isHostAllowed: (hostname: string) => void | Promise<void>) => {
    // Simulate a redirect hop to a DNS name that resolves to the cloud metadata service.
    await isHostAllowed('redirect.example.com');
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
  createHash: () => ({ update: () => ({ digest: () => 'should-not-be-reached' }) })
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
  findLocalTool: () => null,
  downloadTool: async () => {
    throw new Error('downloadTool should not be reached -- downloadToFile must be used so every redirect hop is re-validated');
  },
  extractTar: async () => { throw new Error('extractTar should not be reached'); },
  extractZip: async () => { throw new Error('extractZip should not be reached'); },
  cacheDir: async () => '/tmp/terraform-docs-cached',
  cleanVersion: (v: string) => v,
  prependPath: () => { }
});

const a: ma.TaskLibAnswers = {
  find: { '/tmp/terraform-docs-cached': ['/tmp/terraform-docs-cached/terraform-docs'] }
};
tr.setAnswers(a);
tr.run();
