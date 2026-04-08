import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'InsecureUrlRejectL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', '1.9.8');
tr.setInput('downloadSource', 'mirror');
tr.setInput('mirrorBaseUrl', 'http://insecure-mirror.example.com/terraform'); // HTTP, not HTTPS

tr.registerMock('os', {
    type: () => 'Windows_NT',
    arch: () => 'x64'
});

tr.registerMock('./http-client', {
    fetchJson: async (_url: string) => {
        throw new Error('fetchJson should not be called');
    },
    fetchText: async (_url: string) => {
        throw new Error('fetchText should not be called');
    }
});

tr.registerMock('uuid', { v4: () => 'test-uuid-1234' });
tr.registerMock('undici', { ProxyAgent: class {} });

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: (_toolName: string, _version: string) => null,
    downloadTool: async (_url: string, _fileName: string) => {
        throw new Error('downloadTool should not be called for an insecure URL');
    },
    extractZip: async (_zipPath: string) => '/tmp/terraform-extracted',
    cacheDir: async (_srcPath: string, _tool: string, _version: string) => '/tmp/terraform-cached',
    cleanVersion: (version: string) => version,
    prependPath: (_toolPath: string) => {}
});

const a: ma.TaskLibAnswers = {};
tr.setAnswers(a);
tr.run();
