import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// registryAllowedHosts is NOT set (the default path). The initial download_url
// host is benign, but the (simulated) download follows a redirect to the cloud
// metadata address 169.254.169.254 -- proving the default path re-validates
// every hop via downloadToFile, not just the initial host (#729 follow-up).
const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('version', '0.24.0');
tr.setInput('downloadSource', 'registry');
tr.setInput('registryUrl', 'https://registry.example.com');
tr.setInput('registryMirrorName', 'terraform-docs');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

// dns: registry.example.com is the INITIAL host, not the redirect target under
// test here -- mock it to a public (non-private/link-local) address so the
// #769 resolvesToPrivateOrLinkLocalAddress initial-host check passes without a
// real network lookup, reaching the downloadToFile call this test exercises.
tr.registerMock('dns', {
  promises: {
    lookup: async (_host: string, _opts: any) => [{ address: '203.0.113.10', family: 4 }]
  }
});

const EXPECTED_SHA256 = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';

tr.registerMock('./http-client', {
  fetchJson: async (url: string) => {
    if (url.includes('/terraform/binaries/terraform-docs/versions/0.24.0/linux/amd64')) {
      return { download_url: 'https://storage.example.com/td.tar.gz', sha256: EXPECTED_SHA256 };
    }
    throw new Error('Unexpected fetchJson URL: ' + url);
  },
  fetchText: async (url: string) => { throw new Error('should not fetch text: ' + url); },
  downloadToFile: async (_url: string, _destPath: string, _timeoutMs: number, isHostAllowed: (hostname: string) => void) => {
    // Simulate a redirect hop landing on the cloud metadata service.
    isHostAllowed('169.254.169.254');
  },
  DOWNLOAD_TIMEOUT_MS: 30000
});

tr.registerMock('undici', { ProxyAgent: class { } });

tr.registerMock('azure-pipelines-tool-lib/tool', {
  findLocalTool: () => null,
  downloadTool: async () => {
    throw new Error('downloadTool should not be reached on the default path -- downloadToFile must be used so every redirect hop is re-validated');
  },
  cleanVersion: (v: string) => v,
  prependPath: () => { }
});

tr.run();
