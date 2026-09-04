import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #1024 follow-up: a registry that advertises shasums_url/shasums_signature_url
// but whose signature does not verify (tampered SHA256SUMS, wrong key, a
// misconfigured mirror) must fail closed -- the whole point of adding real
// verification here is that a bad signature is refused rather than silently
// falling back to trusting the registry's own checksum assertion.

const tp = path.join(__dirname, 'RegistryGpgVerifyFailL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', '1.9.8');
tr.setInput('downloadSource', 'registry');
tr.setInput('registryUrl', 'https://registry.example.com');
tr.setInput('registryMirrorName', 'terraform');

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

const SHASUMS_URL = 'https://registry.example.com/storage/1.9.8/SHA256SUMS?sig=abc';
const SHASUMS_SIG_URL = 'https://registry.example.com/storage/1.9.8/SHA256SUMS.terraform.sig?sig=def';

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        if (url.includes('/terraform/binaries/terraform/versions/1.9.8/windows/amd64')) {
            return {
                os: 'windows',
                arch: 'amd64',
                version: '1.9.8',
                filename: 'terraform_1.9.8_windows_amd64.zip',
                sha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
                download_url: 'https://storage.example.com/signed/terraform_1.9.8_windows_amd64.zip',
                shasums_url: SHASUMS_URL,
                shasums_signature_url: SHASUMS_SIG_URL,
            };
        }
        throw new Error('Unexpected fetchJson URL: ' + url);
    },
    fetchText: async (url: string) => {
        if (url === SHASUMS_URL) {
            return 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd001122  terraform_1.9.8_windows_amd64.zip\n';
        }
        throw new Error('Unexpected fetchText URL: ' + url);
    },
    DOWNLOAD_TIMEOUT_MS: 600000,
    downloadToFile: async (url: string, _destPath: string, _timeoutMs: number, isHostAllowed: (hostname: string) => void) => {
        isHostAllowed(new URL(url).hostname);
    }
});

tr.registerMock('undici', { ProxyAgent: class { } });

// A real signature mismatch throws VerificationFailure regardless of `required`
// -- this simulates that outcome directly rather than re-testing openpgp itself
// (GpgVerifierL0 already covers the real crypto).
tr.registerMock('./gpg-verifier', {
    verifyGpgSignature: async (_sha256SumsContent: string, signatureUrl: string) => {
        throw new Error(`GPG signature verification FAILED for ${signatureUrl}: signature does not match the pinned HashiCorp key.`);
    }
});

tr.registerMock('./cosign-verifier', {
    verifyCosignSignature: async () => { }
});

tr.registerMock('fs', {
    chmodSync: (_path: string, _mode: string) => { },
    createReadStream: (_path: string) => require('stream').Readable.from(Buffer.from('fake-zip-content')),
    // The discard-on-failure path deletes the rejected artifact (#204); the
    // installer must not crash when it does.
    unlinkSync: (_path: string) => { },
    existsSync: (_path: string) => true
});

tr.registerMock('crypto', {
    randomUUID: () => 'test-uuid-1234',
    createHash: (_algorithm: string) => {
        const hash: any = new (require('stream').Writable)({ write(_chunk: any, _enc: any, cb: any) { cb(); } });
        hash.digest = (_encoding: string) => 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd001122';
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
