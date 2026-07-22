import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// registryAllowedHosts is NOT set (the default path). download_url's host is
// an ordinary-looking DNS name -- not a literal private IP, so
// isPrivateOrLinkLocalHost alone would miss it -- but it resolves (via the
// mocked dns module below) to the cloud metadata address 169.254.169.254. The
// task must still reject before downloading (#769).
const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('version', '0.24.0');
tr.setInput('downloadSource', 'registry');
tr.setInput('registryUrl', 'https://registry.example.com');
tr.setInput('registryMirrorName', 'terraform-docs');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

const EXPECTED_SHA256 = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';

tr.registerMock('./http-client', {
  fetchJson: async (url: string) => {
    if (url.includes('/terraform/binaries/terraform-docs/versions/0.24.0/linux/amd64')) {
      return { download_url: 'https://attacker.example.net/td.tar.gz', sha256: EXPECTED_SHA256 };
    }
    throw new Error('Unexpected fetchJson URL: ' + url);
  },
  fetchText: async (url: string) => { throw new Error('should not fetch text: ' + url); }
});

tr.registerMock('dns', {
  promises: {
    lookup: async (_host: string, _opts: any) => [{ address: '169.254.169.254', family: 4 }]
  }
});

tr.registerMock('undici', { ProxyAgent: class { } });

tr.registerMock('azure-pipelines-tool-lib/tool', {
  findLocalTool: () => null,
  downloadTool: async () => {
    throw new Error('downloadTool should not be reached for a download_url host that resolves to a private address');
  },
  cleanVersion: (v: string) => v,
  prependPath: () => { }
});

tr.run();
