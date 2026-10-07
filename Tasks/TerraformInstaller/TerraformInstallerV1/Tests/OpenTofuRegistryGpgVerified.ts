import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import { HASHICORP_GPG_PUBLIC_KEY } from '../src/hashicorp-gpg-key';
import { OPENTOFU_GPG_PUBLIC_KEY } from '../src/opentofu-gpg-key';

// binary=tofu with downloadSource=registry, where the registry advertises BOTH
// shasums_url and shasums_signature_url (a terraform-registry-backend OpenTofu mirror with
// GPG verification enabled: the signature is OpenTofu's detached .gpgsig, which the backend
// verified at ingest). The installer verifies it under OpenTofu's pinned release key -- not
// HashiCorp's -- and derives the checksum from that VERIFIED SHA256SUMS rather than trusting
// the registry's own sha256 field. Sibling of RegistryGpgVerified.ts (Terraform) and of
// OpenTofuRegistrySpecificVersionSuccess.ts, the checksum-only case where the registry
// advertises neither URL.

const tp = path.join(__dirname, 'OpenTofuRegistryGpgVerifiedL0.js');
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

const VERIFIED_SHA256 = 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1';
// Deliberately DIFFERENT from VERIFIED_SHA256: if the implementation ever regresses to
// trusting data.sha256 instead of the value parsed from the GPG-verified SHA256SUMS
// content, verifySha256 is handed the wrong expected hash and this row fails instead of
// silently passing for the wrong reason.
const REGISTRY_ASSERTED_SHA256 = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
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
                sha256: REGISTRY_ASSERTED_SHA256,
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
    // console.log, not a shared array: TaskMockRunner runs this fixture in a separate
    // child process from the L0 assertions, so a module-level array would not be
    // observable there. The key is reported BY IDENTITY, so the row proves which trust
    // root was selected, not merely that a verifier ran.
    verifyGpgSignature: async (_sha256SumsContent: string, signatureUrl: string, required: boolean, armoredPublicKey?: string) => {
        const key = armoredPublicKey === OPENTOFU_GPG_PUBLIC_KEY ? 'opentofu'
            : armoredPublicKey === HASHICORP_GPG_PUBLIC_KEY ? 'hashicorp'
                : armoredPublicKey === undefined ? 'default' : 'unknown';
        console.log(`REGISTRY_GPG_VERIFY_CALLED:${signatureUrl}:required=${required}:key=${key}`);
        return true;
    }
});

tr.registerMock('./cosign-verifier', {
    verifyCosignSignature: async () => {
        console.log('COSIGN_VERIFY_CALLED');
    }
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
