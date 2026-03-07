import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'HashiCorpLatestSuccessL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', 'latest');
tr.setInput('downloadSource', 'hashicorp');

// Mock os: Windows_NT so chmodSync is skipped; arch x64 → amd64
tr.registerMock('os', {
    type: () => 'Windows_NT',
    arch: () => 'x64'
});

// Mock node-fetch: checkpoint API returns 1.9.8
tr.registerMock('node-fetch', async (url: string, _options?: any) => {
    if (url.includes('checkpoint-api.hashicorp.com')) {
        return {
            ok: true,
            json: async () => ({ current_version: '1.9.8' })
        };
    }
    throw new Error('Unexpected fetch URL: ' + url);
});

tr.registerMock('uuid/v4', () => 'test-uuid-1234');
tr.registerMock('https-proxy-agent', function () { return {}; });

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: (_toolName: string, _version: string) => null,
    downloadTool: async (_url: string, _fileName: string) => '/tmp/terraform.zip',
    extractZip: async (_zipPath: string) => '/tmp/terraform-extracted',
    cacheDir: async (_srcPath: string, _tool: string, _version: string) => '/tmp/terraform-cached',
    cleanVersion: (version: string) => version,
    prependPath: (_toolPath: string) => {}
});

const a: ma.TaskLibAnswers = {
    'find': {
        '/tmp/terraform-cached': ['/tmp/terraform-cached/terraform.exe']
    }
};

tr.setAnswers(a);
tr.run();
