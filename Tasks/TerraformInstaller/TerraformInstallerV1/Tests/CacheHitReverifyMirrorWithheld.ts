import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #589: cache hit with NO integrity marker; the job requires checksum verification.
// The reverify re-download reaches a REACHABLE mirror that genuinely 404s the
// SHA256SUMS it is required to serve (required material WITHHELD, not a transport
// outage — fetchTextAllow404 returns null only on a real 404). The real reverify
// classification must FAIL CLOSED via the typed VerificationFailure, not degrade.
// The subject module (terraform-installer) is NOT mocked, so its real
// downloadZipFromMirror + reverify classification logic is what runs here.
const tp = path.join(__dirname, 'CacheHitReverifyMirrorWithheldL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', '1.9.8');
tr.setInput('downloadSource', 'mirror');
tr.setInput('mirrorBaseUrl', 'https://mirror.example.com/terraform');
tr.setInput('requireChecksum', 'true');
tr.setInput('requireGpgSignature', 'true');

tr.registerMock('os', {
    type: () => 'Windows_NT',
    arch: () => 'x64'
});

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        throw new Error('fetchJson should not be called for a mirror download. Called with: ' + url);
    },
    fetchText: async (url: string) => {
        throw new Error('fetchText should not be called: use fetchTextAllow404. Called with: ' + url);
    },
    // Genuine 404 for the required SHA256SUMS -> reachable mirror withholding material.
    fetchTextAllow404: async (_url: string) => null
});

tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./gpg-verifier', { verifyGpgSignature: async () => { } });
tr.registerMock('./cosign-verifier', { verifyCosignSignature: async () => { } });

tr.registerMock('fs', {
    existsSync: (_p: string) => false, // no stored integrity marker
    readFileSync: (_p: string, _enc?: string) => Buffer.from('cached-exe-content'),
    writeFileSync: () => {
        throw new Error('writeFileSync must not be called when re-verification fails closed');
    },
    chmodSync: (_path: string, _mode: string) => { }
});

tr.registerMock('crypto', {
    randomUUID: () => 'test-uuid-1234',
    createHash: (_algorithm: string) => ({
        update: (_data: unknown) => ({ digest: (_encoding: string) => 'unused' })
    })
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: (_toolName: string, _version: string) => '/tmp/terraform-cached',
    downloadTool: async (_url: string, _fileName: string) => '/tmp/terraform-reverify.zip',
    extractZip: async (_zipPath: string) => {
        throw new Error('extractZip must not be reached when required material is withheld');
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
