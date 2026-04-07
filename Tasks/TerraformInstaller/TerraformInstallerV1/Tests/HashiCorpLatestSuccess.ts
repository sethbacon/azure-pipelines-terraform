import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'HashiCorpLatestSuccessL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', 'latest');
tr.setInput('downloadSource', 'hashicorp');

// Mock os: Windows_NT so chmodSync is skipped; arch x64 -> amd64
tr.registerMock('os', {
    type: () => 'Windows_NT',
    arch: () => 'x64'
});

const EXPECTED_SHA256 = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';

// Mock node-fetch: checkpoint API returns 1.9.8, SHA256SUMS returns matching hash
tr.registerMock('node-fetch', async (url: string, _options?: any) => {
    if (url.includes('checkpoint-api.hashicorp.com')) {
        return {
            ok: true,
            json: async () => ({ current_version: '1.9.8' })
        };
    }
    if (url.includes('SHA256SUMS')) {
        return {
            ok: true,
            text: async () => `${EXPECTED_SHA256}  terraform_1.9.8_windows_amd64.zip\n`
        };
    }
    throw new Error('Unexpected fetch URL: ' + url);
});

tr.registerMock('uuid', { v4: () => 'test-uuid-1234' });
tr.registerMock('https-proxy-agent', function () { return {}; });

// fs: readFileSync for verifySha256, chmodSync skipped on Windows
tr.registerMock('fs', {
    chmodSync: (_path: string, _mode: string) => { },
    readFileSync: (_path: string) => Buffer.from('fake-zip-content')
});

// crypto: return the expected hash so SHA256 verification passes
tr.registerMock('crypto', {
    createHash: (_algorithm: string) => ({
        update: (_data: any) => ({
            digest: (_encoding: string) => EXPECTED_SHA256
        })
    })
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: (_toolName: string, _version: string) => null,
    downloadTool: async (_url: string, _fileName: string) => '/tmp/terraform.zip',
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
