import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// A non-HTTPS mirror base URL must be rejected before any download.
const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('version', '0.24.0');
tr.setInput('downloadSource', 'mirror');
tr.setInput('mirrorBaseUrl', 'http://insecure.example.com/terraform-docs');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

tr.registerMock('./http-client', {
  fetchJson: async (url: string) => { throw new Error('should not fetch json: ' + url); },
  fetchText: async (url: string) => { throw new Error('should not fetch text: ' + url); }
});

tr.registerMock('undici', { ProxyAgent: class { } });

tr.registerMock('azure-pipelines-tool-lib/tool', {
  findLocalTool: () => null,
  downloadTool: async () => { throw new Error('downloadTool should not be called for an insecure URL'); },
  cleanVersion: (v: string) => v,
  prependPath: () => { }
});

tr.run();
