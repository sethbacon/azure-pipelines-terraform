import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// cleanVersion returns an empty string for an unparseable version: the task must
// fail with a clear "not a valid semantic version" error before any download.
const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('version', 'not-a-version');
tr.setInput('downloadSource', 'official');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

tr.registerMock('./http-client', {
  fetchJson: async (url: string) => { throw new Error('should not fetch json: ' + url); },
  fetchText: async (url: string) => { throw new Error('should not fetch text: ' + url); }
});

tr.registerMock('undici', { ProxyAgent: class { } });

tr.registerMock('azure-pipelines-tool-lib/tool', {
  findLocalTool: () => null,
  downloadTool: async () => { throw new Error('downloadTool should not be called for an invalid version'); },
  cleanVersion: () => '',
  prependPath: () => { }
});

tr.run();
