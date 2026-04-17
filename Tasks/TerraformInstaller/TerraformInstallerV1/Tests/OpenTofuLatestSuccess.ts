import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'OpenTofuLatestSuccessL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('binary', 'tofu');
tr.setInput('terraformVersion', 'latest');

// Mock os: Windows_NT so chmodSync is skipped; arch x64 -> amd64
tr.registerMock('os', {
    type: () => 'Windows_NT',
    arch: () => 'x64'
});

const EXPECTED_SHA256 = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';

// Mock http-client: GitHub API returns latest version, SHA256SUMS returns matching hash
tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        if (url.includes('api.github.com/repos/opentofu/opentofu/releases/latest')) {
            return { tag_name: 'v1.11.6' };
        }
        throw new Error('Unexpected fetchJson URL: ' + url);
    },
    fetchText: async (url: string) => {
        if (url.includes('SHA256SUMS')) {
            return `${EXPECTED_SHA256}  tofu_1.11.6_windows_amd64.zip\n`;
        }
        throw new Error('Unexpected fetchText URL: ' + url);
    },
    fetchBuffer: async (_url: string) => {
        throw new Error('fetchBuffer should not be called in this test');
    }
});

tr.registerMock('uuid', { v4: () => 'test-uuid-1234' });
tr.registerMock('undici', { ProxyAgent: class { } });

// gpg-verifier: mock to prevent openpgp from loading
tr.registerMock('./gpg-verifier', {
    verifyGpgSignature: async () => { }
});

// cosign-verifier: mock cosign as not required, skip verification
tr.registerMock('./cosign-verifier', {
    verifyCosignSignature: async () => { }
});

// fs: readFileSync for verifySha256, chmodSync skipped on Windows
tr.registerMock('fs', {
    chmodSync: (_path: string, _mode: string) => { },
    readFileSync: (_path: string) => Buffer.from('fake-zip-content'),
    writeFileSync: (_path: string, _content: any) => { },
    unlinkSync: (_path: string) => { }
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
    downloadTool: async (_url: string, _fileName: string) => '/tmp/tofu.zip',
    extractZip: async (_zipPath: string) => '/tmp/tofu-extracted',
    cacheDir: async (_srcPath: string, _tool: string, _version: string) => '/tmp/tofu-cached',
    cleanVersion: (version: string) => version,
    prependPath: (_toolPath: string) => { }
});

const a: ma.TaskLibAnswers = {
    'find': {
        '/tmp/tofu-cached': ['/tmp/tofu-cached/tofu.exe']
    }
};

tr.setAnswers(a);
tr.run();
