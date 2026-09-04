import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #1024 follow-up: when the registry advertises BOTH shasums_url and
// shasums_signature_url (terraform-registry-backend v1.2.5+ with GPG
// verification enabled on the mirror config), the registry path now verifies
// the fetched SHA256SUMS against the SAME pinned HashiCorp key the hashicorp
// and mirror sources already use, and derives the checksum from that VERIFIED
// content rather than trusting data.sha256. Sibling of
// RegistrySpecificVersionSuccess.ts, which deliberately omits both URLs and
// stays on the checksum-only fallback this fixture supersedes.

const tp = path.join(__dirname, 'RegistryGpgVerifiedL0.js');
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

const VERIFIED_SHA256 = 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1';
// Deliberately DIFFERENT from VERIFIED_SHA256: if the implementation ever
// regresses to trusting data.sha256 instead of the value parsed from the
// GPG-verified SHA256SUMS content, verifySha256 will be handed the wrong
// expected hash and this row fails instead of silently passing for the wrong
// reason.
const REGISTRY_ASSERTED_SHA256 = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
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
                sha256: REGISTRY_ASSERTED_SHA256,
                download_url: 'https://storage.example.com/signed/terraform_1.9.8_windows_amd64.zip',
                shasums_url: SHASUMS_URL,
                shasums_signature_url: SHASUMS_SIG_URL,
            };
        }
        throw new Error('Unexpected fetchJson URL: ' + url);
    },
    fetchText: async (url: string) => {
        if (url === SHASUMS_URL) {
            return `${VERIFIED_SHA256}  terraform_1.9.8_windows_amd64.zip\n`;
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
    // console.log, not a shared array: TaskMockRunner runs this fixture in a
    // separate child process from the L0 assertions, so a module-level array
    // would not be observable there. Matches the MARKER_WRITTEN/
    // REVERIFY_DOWNLOAD_CALLED convention already used elsewhere in this suite.
    verifyGpgSignature: async (_sha256SumsContent: string, signatureUrl: string, required: boolean) => {
        console.log(`REGISTRY_GPG_VERIFY_CALLED:${signatureUrl}:required=${required}`);
    }
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
        hash.digest = (_encoding: string) => VERIFIED_SHA256;
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
