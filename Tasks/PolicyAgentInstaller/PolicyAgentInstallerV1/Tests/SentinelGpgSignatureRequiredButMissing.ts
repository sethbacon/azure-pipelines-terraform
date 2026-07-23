import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #786: end-to-end proof that a MISSING Sentinel SHA256SUMS.sig fails the whole
// task closed when requireGpgSignature is in effect (default true via
// getBoolInputDefaultTrue) -- mirrors TerraformInstallerV1's
// GpgSignatureRequiredButMissing for the terraform path.
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

// gpg-verifier: the .sig is unavailable AND verification is required -- the real
// implementation throws a VerificationFailure. Mock throws when required=true.
tr.registerMock('./gpg-verifier', {
    verifyGpgSignature: async (_sha256SumsContent: string, signatureUrl: string, required: boolean) => {
        if (required) {
            throw new Error(`GPG signature file unavailable (${signatureUrl}) and signature verification is required. Set 'requireGpgSignature' to false to skip.`);
        }
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
