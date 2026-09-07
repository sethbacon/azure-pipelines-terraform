import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// M11 mutation-coverage gap: the mirror call site's `if (!mirrorGpgVerified)`
// disclosure guard in downloadZipFromMirror was never asserted against its own
// message -- every existing mirror fixture either has requireChecksum=false
// (so the SHA256SUMS body is null and this branch is never reached) or mocks
// verifyGpgSignature to a truthy resolve. Here a real SHA256SUMS body IS
// published (fetchTextAllow404 returns content, not null) and
// requireGpgSignature is false (a permitted skip): verifyGpgSignature returns
// false, so the caller must still disclose GpgVerificationSkippedChecksumOnly.

const tp = path.join(__dirname, 'MirrorGpgOptOutDisclosesWarningL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', '1.9.8');
tr.setInput('downloadSource', 'mirror');
tr.setInput('mirrorBaseUrl', 'https://artifacts.example.com/hashicorp/terraform');
tr.setInput('requireGpgSignature', 'false');

tr.registerMock('os', {
    type: () => 'Windows_NT',
    arch: () => 'x64',
    tmpdir: () => '/tmp'
});

tr.registerMock('dns', {
    promises: {
        lookup: async (_host: string, _opts: any) => [{ address: '203.0.113.10', family: 4 }]
    }
});

const EXPECTED_SHA256 = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';
const SHA256SUMS_URL = 'https://artifacts.example.com/hashicorp/terraform/1.9.8/terraform_1.9.8_SHA256SUMS';

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        throw new Error('fetchJson should not be called for mirror download. Called with: ' + url);
    },
    fetchTextAllow404: async (url: string) => {
        if (url === SHA256SUMS_URL) {
            return `${EXPECTED_SHA256}  terraform_1.9.8_windows_amd64.zip\n`;
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
    verifyGpgSignature: async (_sha256SumsContent: string, _signatureUrl: string, _required: boolean) => false
});

tr.registerMock('./cosign-verifier', {
    verifyCosignSignature: async () => { }
});

tr.registerMock('fs', {
    chmodSync: (_path: string, _mode: string) => { },
    createReadStream: (_path: string) => require('stream').Readable.from(Buffer.from('fake-zip-content'))
});

tr.registerMock('crypto', {
    randomUUID: () => 'test-uuid-1234',
    createHash: (_algorithm: string) => {
        const hash: any = new (require('stream').Writable)({ write(_chunk: any, _enc: any, cb: any) { cb(); } });
        hash.digest = (_encoding: string) => EXPECTED_SHA256;
        return hash;
    }
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: (_toolName: string, _version: string) => null,
    downloadTool: async (_url: string, _fileName: string) => {
        throw new Error('downloadTool should not be called for a mirror download -- downloadToFile must be used (#799)');
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
