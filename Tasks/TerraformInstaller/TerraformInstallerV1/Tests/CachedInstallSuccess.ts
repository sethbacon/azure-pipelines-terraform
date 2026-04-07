import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'CachedInstallSuccessL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', '1.9.8');
tr.setInput('downloadSource', 'hashicorp');

tr.registerMock('os', {
    type: () => 'Windows_NT',
    arch: () => 'x64'
});

// node-fetch should NOT be called when tool is cached (no download, no SHA256)
tr.registerMock('node-fetch', async (url: string, _options?: any) => {
    throw new Error('node-fetch should not be called when tool is cached. Called with: ' + url);
});

tr.registerMock('uuid', { v4: () => 'test-uuid-1234' });
tr.registerMock('https-proxy-agent', function () { return {}; });

tr.registerMock('azure-pipelines-tool-lib/tool', {
    // findLocalTool returns a path, indicating the tool is already cached
    findLocalTool: (_toolName: string, _version: string) => '/tmp/terraform-cached',
    downloadTool: async (_url: string, _fileName: string) => {
        throw new Error('downloadTool should not be called when tool is cached');
    },
    extractZip: async (_zipPath: string) => {
        throw new Error('extractZip should not be called when tool is cached');
    },
    cacheDir: async (_srcPath: string, _tool: string, _version: string) => {
        throw new Error('cacheDir should not be called when tool is cached');
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
