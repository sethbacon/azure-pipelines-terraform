import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'CacheHitReverifySkippedL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', '1.9.8');
tr.setInput('downloadSource', 'hashicorp');
// The operator explicitly opted out of checksum verification: no remote
// re-verification attempt (and no repeated-download cost) on an unmarked cache
// hit — the documented escape hatch for offline/opted-out configurations.
tr.setInput('requireChecksum', 'false');

tr.registerMock('os', {
    type: () => 'Windows_NT',
    arch: () => 'x64'
});

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        throw new Error('fetchJson should not be called when re-verification is skipped. Called with: ' + url);
    },
    fetchText: async (url: string) => {
        throw new Error('fetchText should not be called when re-verification is skipped. Called with: ' + url);
    }
});

tr.registerMock('undici', { ProxyAgent: class { } });

tr.registerMock('./gpg-verifier', {
    verifyGpgSignature: async (_sha256SumsContent: string, _signatureUrl: string) => { }
});

tr.registerMock('./cosign-verifier', {
    verifyCosignSignature: async () => { }
});

tr.registerMock('fs', {
    existsSync: (_p: string) => false, // no stored integrity marker
    readFileSync: (_p: string, _enc?: string) => {
        throw new Error('readFileSync should not be called when re-verification is skipped');
    },
    writeFileSync: () => {
        throw new Error('writeFileSync should not be called when re-verification is skipped');
    },
    chmodSync: (_path: string, _mode: string) => { }
});

tr.registerMock('crypto', { randomUUID: () => 'test-uuid-1234' });

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: (_toolName: string, _version: string) => '/tmp/terraform-cached',
    downloadTool: async (url: string, _fileName: string) => {
        console.log('DOWNLOAD_ATTEMPTED:' + url);
        throw new Error('downloadTool should not be called when re-verification is skipped');
    },
    extractZip: async (_zipPath: string) => {
        throw new Error('extractZip should not be called when re-verification is skipped');
    },
    cacheDir: async (_srcPath: string, _tool: string, _version: string) => {
        throw new Error('cacheDir should not be called on a cache hit');
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
