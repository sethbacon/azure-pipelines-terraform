import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// M9 mutation-coverage gap: the hashicorp call site's `if (!gpgVerified)`
// disclosure guard in downloadZipFromHashiCorp was never asserted against its
// own message -- GpgSignatureUnavailable.ts exercises the same permitted-skip
// shape but only asserts tr.succeeded, so a mutation forcing gpgVerified to
// always read true survived unnoticed. The .sig is genuinely absent and
// requireGpgSignature is false (a permitted skip): verifyGpgSignature returns
// false and the caller must still disclose GpgVerificationSkippedChecksumOnly.

const tp = path.join(__dirname, 'HashiCorpGpgOptOutDisclosesWarningL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', '1.9.8');
tr.setInput('downloadSource', 'hashicorp');
tr.setInput('requireGpgSignature', 'false');

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
