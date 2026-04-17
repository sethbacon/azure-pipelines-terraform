import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'GpgSignatureRequiredButMissingL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', '1.9.8');
tr.setInput('downloadSource', 'hashicorp');
tr.setInput('requireGpgSignature', 'true');

tr.registerMock('os', {
    type: () => 'Windows_NT',
    arch: () => 'x64'
});

const EXPECTED_SHA256 = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        throw new Error('fetchJson should not be called. Called with: ' + url);
    },
    fetchText: async (url: string) => {
        if (url.includes('SHA256SUMS')) {
            return `${EXPECTED_SHA256}  terraform_1.9.8_windows_amd64.zip\n`;
        }
        throw new Error('Unexpected fetchText URL: ' + url);
    }
});

tr.registerMock('uuid', { v4: () => 'test-uuid-1234' });
tr.registerMock('undici', { ProxyAgent: class { } });

// gpg-verifier: mock required=true path — throws when .sig unavailable
tr.registerMock('./gpg-verifier', {
    verifyGpgSignature: async (_sha256SumsContent: string, signatureUrl: string, required: boolean) => {
        if (required) {
            throw new Error(`GPG signature file unavailable (${signatureUrl}) and signature verification is required. Set 'requireGpgSignature' to false to skip.`);
        }
    }
});

tr.registerMock('./cosign-verifier', {
    verifyCosignSignature: async () => { }
});

tr.registerMock('fs', {
    chmodSync: (_path: string, _mode: string) => { },
    readFileSync: (_path: string) => Buffer.from('fake-zip-content')
});

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
