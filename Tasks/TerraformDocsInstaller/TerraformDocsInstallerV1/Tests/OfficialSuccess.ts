import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('version', '0.24.0');
tr.setInput('downloadSource', 'official');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

const EXPECTED_SHA256 = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';

tr.registerMock('./http-client', {
  fetchJson: async (url: string) => { throw new Error('Specific version should not call fetchJson: ' + url); },
  fetchTextAllow404: async (url: string) => {
    if (url.endsWith('.sha256sum')) {
      return `${EXPECTED_SHA256}  terraform-docs-v0.24.0-linux-amd64.tar.gz\n`;
    }
    throw new Error('Unexpected fetchTextAllow404 URL: ' + url);
  }
});

tr.registerMock('undici', { ProxyAgent: class { } });

tr.registerMock('fs', {
  chmodSync: () => { },
  createReadStream: () => require('stream').Readable.from(Buffer.from('fake-archive'))
});

tr.registerMock('crypto', {
  randomUUID: () => 'test-uuid',
  createHash: () => {
    const hash: any = new (require('stream').Writable)({ write(_c: any, _e: any, cb: any) { cb(); } });
    hash.digest = () => EXPECTED_SHA256;
    return hash;
  }
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
