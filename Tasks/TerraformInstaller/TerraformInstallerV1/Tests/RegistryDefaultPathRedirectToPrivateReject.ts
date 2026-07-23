import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// registryAllowedHosts is NOT set (the default path). The registry's
// download_url host itself is benign, but the download is redirected
// (simulated via the downloadToFile mock invoking its isHostAllowed callback)
// to the cloud metadata address 169.254.169.254 -- proving the default path
// now re-validates redirect hops, not just the initial host (#729 follow-up).
const tp = path.join(__dirname, 'RegistryDefaultPathRedirectToPrivateRejectL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', '1.9.8');
tr.setInput('downloadSource', 'registry');
tr.setInput('registryUrl', 'https://registry.example.com');
tr.setInput('registryMirrorName', 'terraform');

tr.registerMock('os', {
  type: () => 'Windows_NT',
  arch: () => 'x64',
  tmpdir: () => '/tmp'
});
// dns: registry.example.com is the INITIAL host, not the redirect target under
// test here -- mock it to a public (non-private/link-local) address so the
// #769 resolvesToPrivateOrLinkLocalAddress initial-host check passes without a
// real network lookup, reaching the downloadToFile call this test exercises.
tr.registerMock('dns', {
  promises: {
    lookup: async (_host: string, _opts: any) => [{ address: '203.0.113.10', family: 4 }]
  }
});
tr.registerMock('./http-client', {
  fetchJson: async (url: string) => {
    if (url.includes('/terraform/binaries/terraform/versions/1.9.8/windows/amd64')) {
      return {
        os: 'windows',
        arch: 'amd64',
        version: '1.9.8',
        sha256: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
        download_url: 'https://storage.example.com/signed/terraform_1.9.8_windows_amd64.zip'
      };
    }
    throw new Error('Unexpected fetchJson URL: ' + url);
  },
  fetchText: async (url: string) => {
    throw new Error('fetchText should not be called for registry download. Called with: ' + url);
  },
  downloadToFile: async (_url: string, _destPath: string, _timeoutMs: number, isHostAllowed: (hostname: string) => void) => {
    // Simulate a redirect hop landing on the cloud metadata service.
    isHostAllowed('169.254.169.254');
  },
  DOWNLOAD_TIMEOUT_MS: 30000
});

tr.registerMock('undici', { ProxyAgent: class { } });

tr.registerMock('./gpg-verifier', {
  verifyGpgSignature: async () => { }
});

tr.registerMock('./cosign-verifier', {
  verifyCosignSignature: async () => { }
});

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
    throw new Error('downloadTool should not be reached on the default path -- downloadToFile must be used so every redirect hop is re-validated');
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
