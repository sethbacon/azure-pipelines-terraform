import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('version', '0.24.0');
tr.setInput('downloadSource', 'official');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

const ARCHIVE_HASH = '1111111111111111111111111111111111111111111111111111111111111111';
const FRESH_EXE_HASH = '2222222222222222222222222222222222222222222222222222222222222222';
const CACHED_EXE_HASH = '3333333333333333333333333333333333333333333333333333333333333333';

// No stored integrity marker exists, so the installer re-downloads the release
// archive through the normal verified path. The freshly extracted executable
// does NOT match the cached one: the cached copy was cached unverified (or
// tampered with) and must be rejected — the #496 threat scenario where a job
// that demands verification would otherwise silently reuse an unverified cache
// entry seeded by an earlier job.
tr.registerMock('./http-client', {
  fetchJson: async (url: string) => { throw new Error('fetchJson should not be called for a specific version: ' + url); },
  fetchTextAllow404: async (url: string) => {
    if (url.includes('sha256sum')) {
      return `${ARCHIVE_HASH}  terraform-docs-v0.24.0-linux-amd64.tar.gz\n`;
    }
    throw new Error('Unexpected fetchTextAllow404 URL: ' + url);
  }
});

tr.registerMock('undici', { ProxyAgent: class { } });

tr.registerMock('fs', {
  existsSync: () => false, // no stored integrity marker
  readFileSync: (p: string, _enc?: string) => {
    if (p.includes('terraform-docs-reverify')) {
      return Buffer.from('fresh-archive-content');
    }
    if (p.includes('terraform-docs-fresh')) {
      return Buffer.from('fresh-exe-content');
    }
    return Buffer.from('cached-exe-content');
  },
  writeFileSync: () => {
    throw new Error('writeFileSync should not be called when re-verification rejects the cached copy');
  },
  chmodSync: () => { }
});

tr.registerMock('crypto', {
  randomUUID: () => 'test-uuid',
  createHash: () => ({
    update: (data: any) => ({
      digest: () => {
        const s = data.toString();
        if (s === 'fresh-archive-content') return ARCHIVE_HASH;
        if (s === 'fresh-exe-content') return FRESH_EXE_HASH;
        return CACHED_EXE_HASH;
      }
    })
  })
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
  findLocalTool: () => '/tmp/terraform-docs-cached',
  downloadTool: async () => '/tmp/terraform-docs-reverify.tar.gz',
  extractTar: async () => '/tmp/terraform-docs-fresh',
  extractZip: async () => { throw new Error('extractZip should not be called on Linux'); },
  cacheDir: async () => { throw new Error('cacheDir should not be called on a cache hit'); },
  cleanVersion: (v: string) => v,
  prependPath: () => { }
});

const a: ma.TaskLibAnswers = {
  find: {
    '/tmp/terraform-docs-cached': ['/tmp/terraform-docs-cached/terraform-docs'],
    '/tmp/terraform-docs-fresh': ['/tmp/terraform-docs-fresh/terraform-docs']
  }
};
tr.setAnswers(a);
tr.run();
