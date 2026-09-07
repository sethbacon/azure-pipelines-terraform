import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// M13 mutation-coverage gap: the sentinel/mirror call site's
// `if (!mirrorGpgVerified)` disclosure guard in verifyMirrorChecksum was never
// asserted against its own message -- MirrorSentinelSuccess.ts mocks
// verifyGpgSignature with an implicit-undefined return (falsy, so this branch
// DOES fire today) but the L0 suite's expectSuccess() helper only asserts
// tr.succeeded, never the warning content, so mutating the guard away would
// still pass. Here the SHA256SUMS body IS published (fetchTextAllow404 returns
// content, not null) and requireGpgSignature is false (a permitted skip):
// verifyGpgSignature returns false and the caller must still disclose
// GpgVerificationSkippedChecksumOnly.

const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('policyAgent', 'sentinel');
tr.setInput('version', '0.40.0');
tr.setInput('downloadSource', 'mirror');
tr.setInput('mirrorBaseUrl', 'https://mirror.example.com');
tr.setInput('requireGpgSignature', 'false');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

tr.registerMock('dns', {
    promises: {
        lookup: async (_host: string, _opts: any) => [{ address: '203.0.113.10', family: 4 }]
    }
});

const EXPECTED_SHA256 = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => { throw new Error('Mirror path should not call fetchJson: ' + url); },
    fetchTextAllow404: async (url: string) => {
        if (url === 'https://mirror.example.com/0.40.0/sentinel_0.40.0_SHA256SUMS') {
            return `${EXPECTED_SHA256}  sentinel_0.40.0_linux_amd64.zip\n`;
        }
        throw new Error('Unexpected fetchTextAllow404 URL: ' + url);
    },
    downloadToFile: async (url: string, _destPath: string, _timeoutMs: number, isHostAllowed: (hostname: string) => void) => {
        isHostAllowed(new URL(url).hostname);
    },
    DOWNLOAD_TIMEOUT_MS: 30000
});

tr.registerMock('undici', { ProxyAgent: class { } });

// The .sig is genuinely absent (404) and requireGpgSignature is false: the real
// gpg-verifier would warn and return false. Mocked directly to false here so
// this fixture stays focused on the CALLER's disclosure behavior.
tr.registerMock('./gpg-verifier', {
    verifyGpgSignature: async (_content: string, _signatureUrl: string, _required: boolean) => false
});

tr.registerMock('fs', {
    chmodSync: () => { },
    createReadStream: () => require('stream').Readable.from(Buffer.from('fake-zip'))
});

tr.registerMock('crypto', {
    randomUUID: () => 'test-uuid',
    createHash: () => {
        const hash: any = new (require('stream').Writable)({ write(_c: any, _e: any, cb: any) { cb(); } });
        hash.digest = () => EXPECTED_SHA256;
        return hash;
    }
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: () => null,
    downloadTool: async () => {
        throw new Error('downloadTool should not be called for a mirror download -- downloadToFile must be used (#799)');
    },
    extractZip: async () => '/tmp/sentinel-extracted',
    cacheDir: async () => '/tmp/sentinel-cached',
    cleanVersion: (v: string) => v,
    prependPath: () => { }
});

const a: ma.TaskLibAnswers = {
    find: { '/tmp/sentinel-cached': ['/tmp/sentinel-cached/sentinel'] }
};
tr.setAnswers(a);
tr.run();
