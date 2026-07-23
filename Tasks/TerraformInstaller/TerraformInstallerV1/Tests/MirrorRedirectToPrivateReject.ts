import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #799 (follow-up to #729): mirrorBaseUrl's own host is benign, but the (simulated)
// download follows a redirect to the cloud metadata address 169.254.169.254 --
// proving the mirror path re-validates every redirect hop via downloadToFile, not
// just the initial host (mirrors the registry path's #729 follow-up fix).
const tp = path.join(__dirname, 'MirrorRedirectToPrivateRejectL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', '1.9.8');
tr.setInput('downloadSource', 'mirror');
tr.setInput('mirrorBaseUrl', 'https://artifacts.example.com/hashicorp/terraform');

tr.registerMock('os', {
  type: () => 'Windows_NT',
  arch: () => 'x64',
  tmpdir: () => '/tmp'
});
// dns: the mirror host itself is benign (this test is about the REDIRECT hop,
// not the initial host); mock it to a public address so the initial-host check
// passes without a real network lookup, reaching the downloadToFile call.
tr.registerMock('dns', {
  promises: {
    lookup: async (_host: string, _opts: any) => [{ address: '203.0.113.10', family: 4 }]
  }
});
tr.registerMock('./http-client', {
  fetchJson: async (url: string) => {
    throw new Error('fetchJson should not be called for mirror download. Called with: ' + url);
  },
  downloadToFile: async (_url: string, _destPath: string, _timeoutMs: number, isHostAllowed: (hostname: string) => void) => {
    // Simulate a redirect hop landing on the cloud metadata service.
    isHostAllowed('169.254.169.254');
  },
  DOWNLOAD_TIMEOUT_MS: 30000
});

tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./gpg-verifier', { verifyGpgSignature: async () => { } });
tr.registerMock('./cosign-verifier', { verifyCosignSignature: async () => { } });

tr.registerMock('fs', {
  chmodSync: (_path: string, _mode: string) => { },
  readFileSync: (_path: string) => Buffer.from('fake-zip-content')
});

tr.registerMock('crypto', {
  randomUUID: () => 'test-uuid-1234',
  createHash: (_algorithm: string) => ({
    update: (_data: any) => ({
      digest: (_encoding: string) => 'should-not-be-reached'
    })
  })
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
  findLocalTool: (_toolName: string, _version: string) => null,
  downloadTool: async (_url: string, _fileName: string) => {
    throw new Error('downloadTool should not be reached -- downloadToFile must be used so every redirect hop is re-validated');
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
