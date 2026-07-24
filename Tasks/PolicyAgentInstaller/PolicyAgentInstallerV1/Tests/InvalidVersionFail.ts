import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('policyAgent', 'opa');
tr.setInput('version', 'not-a-version');
tr.setInput('downloadSource', 'official');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });
tr.registerMock('undici', { ProxyAgent: class { } });

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: () => null,
    downloadTool: async () => { throw new Error('Should not download an invalid version'); },
    extractZip: async () => { throw new Error('no'); },
    cacheDir: async () => { throw new Error('no'); },
    cleanVersion: () => '',
    prependPath: () => { }
});

tr.setAnswers({});
tr.run();
