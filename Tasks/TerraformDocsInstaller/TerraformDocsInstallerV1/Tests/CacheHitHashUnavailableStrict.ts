import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #778 companion to CacheHitHashUnavailable: same scenario (cache hit, no
// integrity marker, source unreachable during re-verification) but with the
// opt-in requireOnlineReverification=true. The task must FAIL CLOSED
// (CachedToolReverificationSourceUnreachable) instead of degrading to a warning
// and trusting the unverified cache entry.
const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('version', '0.24.0');
tr.setInput('downloadSource', 'official');
tr.setInput('requireOnlineReverification', 'true');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

tr.registerMock('./http-client', {
  fetchJson: async (url: string) => { throw new Error('fetchJson should not be called for a specific version: ' + url); },
  fetchTextAllow404: async (url: string) => { throw new Error(`getaddrinfo ENOTFOUND while fetching ${url}`); }
});

tr.registerMock('undici', { ProxyAgent: class { } });

tr.registerMock('fs', {
  existsSync: () => false,
  readFileSync: () => { throw new Error('readFileSync should not be called when the re-verification download failed'); },
  writeFileSync: () => { throw new Error('writeFileSync should not be called when re-verification failed closed'); },
  chmodSync: () => { }
});

tr.registerMock('crypto', { randomUUID: () => 'test-uuid' });

tr.registerMock('azure-pipelines-tool-lib/tool', {
  findLocalTool: () => '/tmp/terraform-docs-cached',
  downloadTool: async (url: string) => { throw new Error(`getaddrinfo ENOTFOUND while downloading ${url}`); },
  extractTar: async () => { throw new Error('extractTar should not be called when the re-verification download failed'); },
  extractZip: async () => { throw new Error('extractZip should not be called when the re-verification download failed'); },
  cacheDir: async () => { throw new Error('cacheDir should not be called on a cache hit'); },
  cleanVersion: (v: string) => v,
  prependPath: () => { }
});

const a: ma.TaskLibAnswers = {
  find: { '/tmp/terraform-docs-cached': ['/tmp/terraform-docs-cached/terraform-docs'] }
};
tr.setAnswers(a);
tr.run();
