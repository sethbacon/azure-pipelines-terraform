import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #786: end-to-end proof that an INVALID Sentinel SHA256SUMS GPG signature fails
// the whole task closed (mirrors TerraformInstallerV1's GpgVerificationFail for
// the terraform path). requireGpgSignature defaults to true (getBoolInputDefaultTrue),
// so no input is needed to enforce it.
const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('policyAgent', 'sentinel');
tr.setInput('version', '0.40.0');
tr.setInput('downloadSource', 'official');

tr.registerMock('os', { type: () => 'Windows_NT', arch: () => 'x64' });

const EXPECTED_SHA256 = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => { throw new Error('Specific version should not call fetchJson: ' + url); },
    fetchText: async (url: string) => {
        if (url.includes('SHA256SUMS')) {
            return `${EXPECTED_SHA256}  sentinel_0.40.0_windows_amd64.zip\n`;
        }
        throw new Error('Unexpected fetchText URL: ' + url);
    }
});

tr.registerMock('undici', { ProxyAgent: class { } });

// gpg-verifier: mock GPG verification as FAILING (invalid signature).
tr.registerMock('./gpg-verifier', {
    verifyGpgSignature: async (_sha256SumsContent: string, _signatureUrl: string) => {
        throw new Error('GPG signature verification failed for SHA256SUMS: Signature is not valid');
    }
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
    downloadTool: async () => '/tmp/sentinel.zip',
    extractZip: async () => '/tmp/sentinel-extracted',
    cacheDir: async () => '/tmp/sentinel-cached',
    cleanVersion: (v: string) => v,
    prependPath: () => { }
});

const a: ma.TaskLibAnswers = {
    find: { '/tmp/sentinel-cached': ['/tmp/sentinel-cached/sentinel.exe'] }
};
tr.setAnswers(a);
tr.run();
