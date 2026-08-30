import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('version', '0.24.0');
tr.setInput('downloadSource', 'official');
tr.setInput('forceOnlineReverification', 'true');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

const ARCHIVE_HASH = '1111111111111111111111111111111111111111111111111111111111111111';
const EXE_HASH = '2222222222222222222222222222222222222222222222222222222222222222';

// forceOnlineReverification=true, and the STORED MARKER EXISTS AND MATCHES —
// distinct from CacheHitReverifyPass, where there is no marker at all. The
// point of this fixture is that a passing marker must NOT be trusted: the
// download path below must still run.
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
  existsSync: (p: string) => p.includes('.installer-verified.sha256'), // marker EXISTS
  readFileSync: (p: string, _enc?: string) => {
    if (p.includes('.installer-verified.sha256')) {
      return EXE_HASH; // and MATCHES the cached executable's content below
    }
    if (p.includes('terraform-docs-reverify')) {
      return Buffer.from('fresh-archive-content');
    }
    return Buffer.from('shared-exe-content');
  },
  createReadStream: (p: string) => {
    const content = p.includes('terraform-docs-reverify') ? 'fresh-archive-content' : 'shared-exe-content';
    return require('stream').Readable.from(Buffer.from(content));
  },
  writeFileSync: (p: string, _data: any, _enc?: string) => {
    console.log('MARKER_WRITTEN:' + p);
  },
  chmodSync: () => { }
});

tr.registerMock('crypto', {
  randomUUID: () => 'test-uuid',
  createHash: () => {
    const chunks: Buffer[] = [];
    const hash: any = new (require('stream').Writable)({
      write(chunk: any, _e: any, cb: any) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        cb();
      }
    });
    hash.digest = () => Buffer.concat(chunks).toString() === 'fresh-archive-content' ? ARCHIVE_HASH : EXE_HASH;
    return hash;
  }
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
