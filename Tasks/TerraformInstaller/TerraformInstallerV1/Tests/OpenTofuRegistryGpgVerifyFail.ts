import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import { HASHICORP_GPG_PUBLIC_KEY } from '../src/hashicorp-gpg-key';
import { OPENTOFU_GPG_PUBLIC_KEY } from '../src/opentofu-gpg-key';

// binary=tofu with downloadSource=registry, where the registry advertises
// shasums_url/shasums_signature_url but the signature does not verify under OpenTofu's key
// (a tampered SHA256SUMS, a signature by some other key, a mirror configured with its own
// custom_gpg_key). The install must fail closed: the point of verifying here is that a bad
// signature is refused rather than silently degraded to trusting the registry's own sha256.
// Sibling of RegistryGpgVerifyFail.ts (Terraform).

const tp = path.join(__dirname, 'OpenTofuRegistryGpgVerifyFailL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('binary', 'tofu');
tr.setInput('terraformVersion', '1.11.6');
tr.setInput('downloadSource', 'registry');
tr.setInput('registryUrl', 'https://registry.example.com');
tr.setInput('registryMirrorName', 'opentofu');

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

const SHASUMS_URL = 'https://registry.example.com/storage/1.11.6/SHA256SUMS?sig=abc';
const SHASUMS_SIG_URL = 'https://registry.example.com/storage/1.11.6/SHA256SUMS.opentofu.sig?sig=def';

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        if (url === 'https://registry.example.com/terraform/binaries/opentofu/versions/1.11.6/windows/amd64') {
            return {
                os: 'windows',
                arch: 'amd64',
                version: '1.11.6',
                filename: 'tofu_1.11.6_windows_amd64.zip',
                sha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
                download_url: 'https://storage.example.com/signed/tofu_1.11.6_windows_amd64.zip',
                shasums_url: SHASUMS_URL,
                shasums_signature_url: SHASUMS_SIG_URL,
            };
        }
        throw new Error('Unexpected fetchJson URL: ' + url);
    },
    fetchText: async (url: string) => {
        if (url === SHASUMS_URL) {
            return 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd001122  tofu_1.11.6_windows_amd64.zip\n';
        }
        throw new Error('Unexpected fetchText URL: ' + url);
    },
    DOWNLOAD_TIMEOUT_MS: 600000,
    downloadToFile: async (url: string, _destPath: string, _timeoutMs: number, isHostAllowed: (hostname: string) => void) => {
        isHostAllowed(new URL(url).hostname);
    }
});

tr.registerMock('undici', { ProxyAgent: class { } });

// A real signature mismatch throws VerificationFailure regardless of `required` -- this
// simulates that outcome directly rather than re-testing openpgp itself (GpgVerifierL0
// already covers the real crypto against real OpenTofu releases). The call is logged with
// the key identity first, so a failure here still proves OpenTofu's key was the one asked.
tr.registerMock('./gpg-verifier', {
    verifyGpgSignature: async (_sha256SumsContent: string, signatureUrl: string, required: boolean, armoredPublicKey?: string) => {
        const key = armoredPublicKey === OPENTOFU_GPG_PUBLIC_KEY ? 'opentofu'
            : armoredPublicKey === HASHICORP_GPG_PUBLIC_KEY ? 'hashicorp'
                : armoredPublicKey === undefined ? 'default' : 'unknown';
        console.log(`REGISTRY_GPG_VERIFY_CALLED:${signatureUrl}:required=${required}:key=${key}`);
        throw new Error(`GPG signature verification FAILED for ${signatureUrl}: signature does not match the pinned OpenTofu key.`);
    }
});

tr.registerMock('./cosign-verifier', {
    verifyCosignSignature: async () => { }
});

tr.registerMock('fs', {
    chmodSync: (_path: string, _mode: string) => { },
    createReadStream: (_path: string) => require('stream').Readable.from(Buffer.from('fake-zip-content')),
    // The discard-on-failure path deletes the rejected artifact (#204); the installer
    // must not crash when it does.
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
    downloadTool: async (_url: string, _fileName: string) => {
        throw new Error('downloadTool should not be called for a registry download -- downloadToFile must be used (#729)');
    },
    extractZip: async (_zipPath: string) => '/tmp/tofu-extracted',
    cacheDir: async (_srcPath: string, tool: string, version: string) => {
        console.log('CACHE_DIR_CALLED:' + tool + '@' + version);
        return '/tmp/tofu-cached';
    },
    cleanVersion: (version: string) => version,
    prependPath: (_toolPath: string) => { }
});

const a: ma.TaskLibAnswers = {
    'find': {
        '/tmp/tofu-cached': ['/tmp/tofu-cached/tofu.exe']
    }
};

tr.setAnswers(a);
tr.run();
