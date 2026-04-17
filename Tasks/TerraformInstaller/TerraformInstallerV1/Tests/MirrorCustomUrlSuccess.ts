import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'MirrorCustomUrlSuccessL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', '1.9.8');
tr.setInput('downloadSource', 'mirror');
tr.setInput('mirrorBaseUrl', 'https://artifacts.example.com/hashicorp/terraform');

tr.registerMock('os', {
    type: () => 'Windows_NT',
    arch: () => 'x64'
});

// http-client: mirror download — fetchText for SHA256SUMS will fail (unavailable), which is caught and warned
tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        throw new Error('fetchJson should not be called for mirror download. Called with: ' + url);
    },
    fetchText: async (url: string) => {
        // Mirror SHA256SUMS is unavailable — the installer catches this and warns
        throw new Error('Failed to fetch ' + url + ': HTTP 404');
    }
});

tr.registerMock('uuid', { v4: () => 'test-uuid-1234' });
tr.registerMock('undici', { ProxyAgent: class { } });

// gpg-verifier: mock to prevent openpgp from loading (not used in mirror path)
tr.registerMock('./gpg-verifier', {
    verifyGpgSignature: async (_sha256SumsContent: string, _signatureUrl: string) => { }
});

tr.registerMock('./cosign-verifier', {
    verifyCosignSignature: async () => { }
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: (_toolName: string, _version: string) => null,
    downloadTool: async (url: string, _fileName: string) => {
        // Verify the mirror URL has the correct structure
        const expectedUrl = 'https://artifacts.example.com/hashicorp/terraform/1.9.8/terraform_1.9.8_windows_amd64.zip';
        if (url !== expectedUrl) {
            throw new Error('Unexpected download URL: ' + url + '. Expected: ' + expectedUrl);
        }
        return '/tmp/terraform.zip';
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
