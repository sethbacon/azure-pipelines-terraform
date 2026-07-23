import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #778 companion to CacheHitHashUnavailable: same scenario (cache hit, no
// integrity marker, source unreachable during re-verification) but with the
// opt-in requireOnlineReverification=true. The task must FAIL CLOSED
// (CachedToolReverificationSourceUnreachable) instead of degrading to a warning
// and trusting the unverified cache entry.
const tp = path.join(__dirname, 'CacheHitHashUnavailableL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', '1.9.8');
tr.setInput('downloadSource', 'hashicorp');
tr.setInput('requireOnlineReverification', 'true');

tr.registerMock('os', {
  type: () => 'Windows_NT',
  arch: () => 'x64'
});

tr.registerMock('./http-client', {
  fetchJson: async (url: string) => {
    throw new Error('fetchJson should not be called for a specific version. Called with: ' + url);
  },
  fetchText: async (url: string) => {
    throw new Error(`getaddrinfo ENOTFOUND while fetching ${url}`);
  }
});

tr.registerMock('undici', { ProxyAgent: class { } });

tr.registerMock('./gpg-verifier', {
  verifyGpgSignature: async (_sha256SumsContent: string, _signatureUrl: string) => { }
});

tr.registerMock('./cosign-verifier', {
  verifyCosignSignature: async () => { }
});

tr.registerMock('fs', {
  existsSync: (_p: string) => false,
  readFileSync: (_p: string, _enc?: string) => {
    throw new Error('readFileSync should not be called when the re-verification download failed');
  },
  writeFileSync: () => {
    throw new Error('writeFileSync should not be called when re-verification failed closed');
  },
  chmodSync: (_path: string, _mode: string) => { }
});

tr.registerMock('crypto', { randomUUID: () => 'test-uuid-1234' });

tr.registerMock('azure-pipelines-tool-lib/tool', {
  findLocalTool: (_toolName: string, _version: string) => '/tmp/terraform-cached',
  downloadTool: async (url: string, _fileName: string) => {
    throw new Error(`getaddrinfo ENOTFOUND while downloading ${url}`);
  },
  extractZip: async (_zipPath: string) => {
    throw new Error('extractZip should not be called when the re-verification download failed');
  },
  cacheDir: async (_srcPath: string, _tool: string, _version: string) => {
    throw new Error('cacheDir should not be called on a cache hit');
  },
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
