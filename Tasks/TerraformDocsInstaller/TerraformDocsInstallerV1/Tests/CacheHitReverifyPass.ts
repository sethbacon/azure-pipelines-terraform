import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('version', '0.24.0');
tr.setInput('downloadSource', 'official');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

const ARCHIVE_HASH = '1111111111111111111111111111111111111111111111111111111111111111';
const EXE_HASH = '2222222222222222222222222222222222222222222222222222222222222222';

// No stored integrity marker exists, so the installer re-downloads the release
// archive through the normal verified path. The freshly extracted executable
// byte-matches the cached one, so the cache entry is accepted AND an integrity
// marker is written (healing the entry: future cache hits verify locally,
// offline).
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
    // The freshly extracted executable and the cached executable carry the
    // same bytes — the cached entry matches the verified release.
    return Buffer.from('shared-exe-content');
  },
  writeFileSync: (p: string, _data: any, _enc?: string) => {
    console.log('MARKER_WRITTEN:' + p);
  },
  chmodSync: () => { }
});

tr.registerMock('crypto', {
  randomUUID: () => 'test-uuid',
  createHash: () => ({
    update: (data: any) => ({
      digest: () => data.toString() === 'fresh-archive-content' ? ARCHIVE_HASH : EXE_HASH
    })
  })
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
  findLocalTool: () => '/tmp/terraform-docs-cached',
  downloadTool: async (url: string) => {
    console.log('REVERIFY_DOWNLOAD_CALLED:' + url);
    return '/tmp/terraform-docs-reverify.tar.gz';
  },
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
