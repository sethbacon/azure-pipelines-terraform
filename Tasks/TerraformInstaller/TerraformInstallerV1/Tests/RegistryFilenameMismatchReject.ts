import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// M5 mutation-coverage gap: `if (data.filename && data.filename !== expectedZipFileName)`
// in downloadZipFromRegistry (#1104/17) guards against a compromised registry
// answering a request for one version with a genuinely-signed SHA256SUMS
// naming a DIFFERENT, older artifact via a mismatched filename field. No
// existing fixture ever sets data.filename to something other than the
// expected zip name, so mutating that guard away survived. shasums_url/
// shasums_signature_url both correctly reference the REQUESTED version
// (1.9.8), so the M4 guard passes and this one is reached and exercised.

const tp = path.join(__dirname, 'RegistryFilenameMismatchRejectL0.js');
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
                // Deliberately DOES NOT match the expected
                // terraform_1.9.8_windows_amd64.zip lookup key.
                filename: 'terraform_1.9.8_linux_amd64.zip',
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

tr.registerMock('./gpg-verifier', {
    verifyGpgSignature: async () => {
        throw new Error('verifyGpgSignature must not be reached: the filename-mismatch guard must reject data.filename first.');
    }
});

tr.registerMock('./cosign-verifier', {
    verifyCosignSignature: async () => { }
});

tr.registerMock('fs', {
    chmodSync: (_path: string, _mode: string) => { },
    createReadStream: (_path: string) => require('stream').Readable.from(Buffer.from('fake-zip-content')),
    unlinkSync: (_path: string) => { },
    existsSync: (_path: string) => true
});

tr.registerMock('crypto', {
    randomUUID: () => 'test-uuid-1234',
    createHash: (_algorithm: string) => {
        const hash: any = new (require('stream').Writable)({ write(_chunk: any, _enc: any, cb: any) { cb(); } });
        hash.digest = (_encoding: string) => 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
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
