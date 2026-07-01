import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// The archive's computed SHA256 does not match the published checksum: the task
// must fail.
const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('version', '0.24.0');
tr.setInput('downloadSource', 'official');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

const SUMS_SHA = 'aa'.repeat(32);
const ACTUAL_SHA = 'bb'.repeat(32);

tr.registerMock('./http-client', {
  fetchJson: async (url: string) => { throw new Error('Specific version should not call fetchJson: ' + url); },
  fetchText: async (url: string) => {
    if (url.endsWith('.sha256sum')) {
      return `${SUMS_SHA}  terraform-docs-v0.24.0-linux-amd64.tar.gz\n`;
    }
    throw new Error('Unexpected fetchText URL: ' + url);
  }
});

tr.registerMock('undici', { ProxyAgent: class { } });

tr.registerMock('fs', {
  chmodSync: () => { },
  readFileSync: () => Buffer.from('fake-archive')
});

tr.registerMock('crypto', {
  randomUUID: () => 'test-uuid',
  createHash: () => ({ update: () => ({ digest: () => ACTUAL_SHA }) })
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

tr.run();
