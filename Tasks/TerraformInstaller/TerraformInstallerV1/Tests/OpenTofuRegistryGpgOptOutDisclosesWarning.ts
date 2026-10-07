import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import { HASHICORP_GPG_PUBLIC_KEY } from '../src/hashicorp-gpg-key';
import { OPENTOFU_GPG_PUBLIC_KEY } from '../src/opentofu-gpg-key';

// binary=tofu with downloadSource=registry, where the registry advertises BOTH
// shasums_url and shasums_signature_url but the signature file is genuinely absent (404)
// and requireGpgSignature is false -- a permitted skip. verifyGpgSignature then returns
// false, the SHA256SUMS was never authenticated, and the install must still disclose
// checksum-only trust with the OpenTofu wording rather than read identically to a
// signature-anchored verification. Mirror of RegistryGpgOptOutDisclosesWarning.ts
// (Terraform): the opt-out is mocked to false here so this fixture stays focused on the
// CALLER's disclosure behaviour.

const tp = path.join(__dirname, 'OpenTofuRegistryGpgOptOutDisclosesWarningL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('binary', 'tofu');
tr.setInput('terraformVersion', '1.11.6');
tr.setInput('downloadSource', 'registry');
tr.setInput('registryUrl', 'https://registry.example.com');
tr.setInput('registryMirrorName', 'opentofu');
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

const VERIFIED_SHA256 = 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1';
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
                sha256: VERIFIED_SHA256,
                download_url: 'https://storage.example.com/signed/tofu_1.11.6_windows_amd64.zip',
                shasums_url: SHASUMS_URL,
                shasums_signature_url: SHASUMS_SIG_URL,
            };
        }
        throw new Error('Unexpected fetchJson URL: ' + url);
    },
    fetchText: async (url: string) => {
        if (url === SHASUMS_URL) {
            return `${VERIFIED_SHA256}  tofu_1.11.6_windows_amd64.zip\n`;
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
    verifyGpgSignature: async (_sha256SumsContent: string, signatureUrl: string, required: boolean, armoredPublicKey?: string) => {
        const key = armoredPublicKey === OPENTOFU_GPG_PUBLIC_KEY ? 'opentofu'
            : armoredPublicKey === HASHICORP_GPG_PUBLIC_KEY ? 'hashicorp'
                : armoredPublicKey === undefined ? 'default' : 'unknown';
        console.log(`REGISTRY_GPG_VERIFY_CALLED:${signatureUrl}:required=${required}:key=${key}`);
        // The signature is genuinely absent and not required: the real gpg-verifier would
        // warn and return false.
        return false;
    }
});

tr.registerMock('./cosign-verifier', {
    verifyCosignSignature: async () => { }
});

tr.registerMock('fs', {
    chmodSync: (_path: string, _mode: string) => { },
    createReadStream: (_path: string) => require('stream').Readable.from(Buffer.from('fake-zip-content')),
    writeFileSync: (p: string, _content: any) => {
        console.log('MARKER_WRITTEN:' + p);
    },
    renameSync: (_from: string, _to: string) => { },
    unlinkSync: (_path: string) => { }
});

tr.registerMock('crypto', {
    randomUUID: () => 'test-uuid-1234',
    createHash: (_algorithm: string) => {
        const hash: any = new (require('stream').Writable)({ write(_chunk: any, _enc: any, cb: any) { cb(); } });
        hash.digest = (_encoding: string) => VERIFIED_SHA256;
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
