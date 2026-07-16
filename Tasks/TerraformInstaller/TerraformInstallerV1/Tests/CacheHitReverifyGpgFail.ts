import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'CacheHitReverifyGpgFailL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', '1.9.8');
tr.setInput('downloadSource', 'hashicorp');

tr.registerMock('os', {
    type: () => 'Windows_NT',
    arch: () => 'x64'
});

const ZIP_HASH = '1111111111111111111111111111111111111111111111111111111111111111';

// No stored integrity marker: the installer re-downloads the release to
// re-verify the cache entry, and the source is serving a SHA256SUMS whose GPG
// signature does NOT verify (the "since-compromised mirror" scenario from
// #496). A verification failure during re-verification must FAIL CLOSED — it
// must never degrade to the trust-the-cache warning path the way a mere
// network/availability failure does.
tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        throw new Error('fetchJson should not be called for a specific version. Called with: ' + url);
    },
    fetchText: async (url: string) => {
        if (url.includes('SHA256SUMS')) {
            return `${ZIP_HASH}  terraform_1.9.8_windows_amd64.zip\n`;
        }
        throw new Error('Unexpected fetchText URL: ' + url);
    }
});

tr.registerMock('undici', { ProxyAgent: class { } });

tr.registerMock('./gpg-verifier', {
    verifyGpgSignature: async (_sha256SumsContent: string, _signatureUrl: string) => {
        // Same typed marker the real gpg-verifier attaches to a bad-signature
        // failure (classification is name-based across module instances).
        const err = new Error('GPG signature verification failed for SHA256SUMS: signature by unknown key (mock)');
        err.name = 'VerificationFailure';
        throw err;
    }
});

tr.registerMock('./cosign-verifier', {
    verifyCosignSignature: async () => { }
});

tr.registerMock('fs', {
    existsSync: (_p: string) => false, // no stored integrity marker
    readFileSync: (_p: string, _enc?: string) => Buffer.from('cached-exe-content'),
    writeFileSync: () => {
        throw new Error('writeFileSync should not be called when re-verification fails');
    },
    chmodSync: (_path: string, _mode: string) => { }
});

tr.registerMock('crypto', { randomUUID: () => 'test-uuid-1234' });

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: (_toolName: string, _version: string) => '/tmp/terraform-cached',
    downloadTool: async (_url: string, _fileName: string) => '/tmp/terraform-reverify.zip',
    extractZip: async (_zipPath: string) => {
        throw new Error('extractZip should not be reached when the signature fails verification');
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
