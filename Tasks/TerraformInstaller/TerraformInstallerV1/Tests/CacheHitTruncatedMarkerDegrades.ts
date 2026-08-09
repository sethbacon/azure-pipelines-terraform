import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'CacheHitHashUnavailableL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', '1.9.8');
tr.setInput('downloadSource', 'hashicorp');

tr.registerMock('os', {
    type: () => 'Windows_NT',
    arch: () => 'x64'
});

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        throw new Error('fetchJson should not be called for a specific version. Called with: ' + url);
    },
    fetchText: async (url: string) => {
        throw new Error(`getaddrinfo ENOTFOUND while fetching ${url}`);
    }
});

tr.registerMock('undici', { ProxyAgent: class { } });

tr.registerMock('./gpg-verifier', {
    verifyGpgSignature: async (_sha256SumsContent: string, _signatureUrl: string) => { }
});

tr.registerMock('./cosign-verifier', {
    verifyCosignSignature: async () => { }
});

// #198: the stored integrity marker exists and is READABLE but is TRUNCATED -- a
// previous run's write was interrupted (disk full, cancelled job, container kill).
// Feeding that fragment to the hash comparison produced a
// CachedToolVerificationFailed, which reads as binary TAMPERING and permanently
// bricked that version on the agent: every later install failed the same way. A
// malformed marker is UNVERIFIABLE, not a mismatch, so it is now treated exactly like
// a missing one -- escalate to a remote re-verification and, when the source is
// unreachable (here), degrade with a warning instead of failing.
// No USABLE stored integrity marker exists (e.g. cached by an installer version that
// predates this check, or cached with checksum verification disabled), so the
// installer attempts a remote re-verification — but the source is unreachable
// (offline/air-gapped agent, simulated by downloadTool throwing a network
// error). The install must degrade gracefully to the pre-existing
// trust-the-cache behavior with a warning, never fail: offline cache reuse is
// an explicitly supported scenario.
tr.registerMock('fs', {
    existsSync: (p: string) => String(p).includes('.installer-verified.sha256'),
    readFileSync: (p: string, _enc?: string) => {
        // A torn write: the first 12 characters of a 64-character digest.
        if (String(p).includes('.installer-verified.sha256')) return 'aabbccddeeff';
        throw new Error('readFileSync should not be called on anything but the marker when the re-verification download failed');
    },
    writeFileSync: () => {
        throw new Error('writeFileSync should not be called when re-verification was degraded');
    },
    chmodSync: (_path: string, _mode: string) => { }
});

tr.registerMock('crypto', { randomUUID: () => 'test-uuid-1234' });

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: (_toolName: string, _version: string) => '/tmp/terraform-cached',
    downloadTool: async (url: string, _fileName: string) => {
        throw new Error(`getaddrinfo ENOTFOUND while downloading ${url}`);
    },
    extractZip: async (_zipPath: string) => {
        throw new Error('extractZip should not be called when the re-verification download failed');
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
