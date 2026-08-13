import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// Registry returns an empty sha256 but DOES advertise a shasums_url. The task must
// still fail closed, and must say the registry holds the checksum without publishing
// it, so the operator is pointed at the registry rather than at a missing upstream
// checksum. The shasums_url must NOT be used as a fallback: it is same-origin with
// download_url.
const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('version', '0.24.0');
tr.setInput('downloadSource', 'registry');
tr.setInput('registryUrl', 'https://registry.example.com');
tr.setInput('registryMirrorName', 'terraform-docs');
tr.setInput('requireChecksum', 'true');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

tr.registerMock('dns', {
  promises: {
    lookup: async (_host: string, _opts: any) => [{ address: '203.0.113.10', family: 4 }]
  }
});

tr.registerMock('./http-client', {
  fetchJson: async (url: string) => {
    if (url.includes('/terraform/binaries/terraform-docs/versions/0.24.0/linux/amd64')) {
      return {
        download_url: 'https://storage.example.com/signed/td?sig=abc',
        sha256: '',
        shasums_url: 'https://storage.example.com/signed/SHA256SUMS?sig=def'
      };
    }
    throw new Error('Unexpected fetchJson URL: ' + url);
  },
  fetchText: async (url: string) => { throw new Error('The shasums_url must not be fetched as a fallback: ' + url); },
  DOWNLOAD_TIMEOUT_MS: 600000,
  downloadToFile: async (url: string, _destPath: string, _timeoutMs: number, isHostAllowed: (hostname: string) => void) => {
    isHostAllowed(new URL(url).hostname);
  }
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
  downloadTool: async () => '/tmp/terraform-docs-download.tar.gz',
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
