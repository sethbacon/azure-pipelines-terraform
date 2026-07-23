import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #352: the registry download_url carries a live storage credential in its
// query string, and tool-lib logs the URL at INFO (fully redacting only
// Azure `sig=`). Assert every sensitive token component is registered as a
// secret (so the agent masks it) while benign params stay visible.
const tp = path.join(__dirname, 'RegistryDownloadTokenMaskedL0.js');
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

// dns: storage.example.com is a fictional test host with no real DNS record;
// mock it to a public (non-private/link-local) address so the #769
// resolvesToPrivateOrLinkLocalAddress check passes without a real network
// lookup, instead of failing with a real ENOTFOUND in this offline test run.
tr.registerMock('dns', {
    promises: {
        lookup: async (_host: string, _opts: any) => [{ address: '203.0.113.10', family: 4 }]
    }
});

const EXPECTED_SHA256 = 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1';

const AWS_SIGNATURE = 'AWSSIGNATUREtoken1111';        // X-Amz-Signature       -> masked
const AWS_CREDENTIAL = 'AWSCREDENTIALtoken2222';      // X-Amz-Credential      -> masked
const AWS_SECURITY_TOKEN = 'AWSSECURITYtoken3333';    // X-Amz-Security-Token  -> masked
const GOOG_SIGNATURE = 'GOOGSIGNATUREtoken4444';      // X-Goog-Signature      -> masked
const GOOG_CREDENTIAL = 'GOOGCREDENTIALtoken5555';    // X-Goog-Credential     -> masked
const AZURE_SIG = 'AZURESIGtoken6666';                // sig (Azure SAS)       -> masked
const BENIGN_DATE = '20260703T000000Z';               // X-Amz-Date            -> NOT masked
const BENIGN_SIGNED_HEADERS = 'host';                 // X-Amz-SignedHeaders   -> NOT masked

const PRESIGNED_URL =
    'https://storage.example.com/signed/terraform_1.9.8_windows_amd64.zip' +
    '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
    `&X-Amz-Credential=${AWS_CREDENTIAL}` +
    `&X-Amz-Date=${BENIGN_DATE}` +
    '&X-Amz-Expires=900' +
    `&X-Amz-SignedHeaders=${BENIGN_SIGNED_HEADERS}` +
    `&X-Amz-Security-Token=${AWS_SECURITY_TOKEN}` +
    `&X-Amz-Signature=${AWS_SIGNATURE}` +
    `&X-Goog-Credential=${GOOG_CREDENTIAL}` +
    `&X-Goog-Signature=${GOOG_SIGNATURE}` +
    `&sig=${AZURE_SIG}`;

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        if (url.includes('/terraform/binaries/terraform/versions/1.9.8/windows/amd64')) {
            return {
                download_url: PRESIGNED_URL,
                sha256: EXPECTED_SHA256
            };
        }
        throw new Error('Unexpected fetchJson URL: ' + url);
    },
    fetchText: async (url: string) => { throw new Error('Registry path should not fetch SHA256SUMS text: ' + url); },
    DOWNLOAD_TIMEOUT_MS: 600000,
    // downloadToFile now replaces tools.downloadTool() on the DEFAULT (no
    // allowlist) path too (#729 follow-up) -- simulate a clean, non-redirected
    // download by invoking isHostAllowed once with the URL's own host (no
    // private/link-local address, so it passes) and not writing anything, the
    // same way downloadTool is stubbed below; fs.createReadStream is mocked to
    // always return fake-zip-content regardless of path.
    downloadToFile: async (url: string, _destPath: string, _timeoutMs: number, isHostAllowed: (hostname: string) => void) => {
        isHostAllowed(new URL(url).hostname);
    }
});

tr.registerMock('undici', { ProxyAgent: class { } });

tr.registerMock('./gpg-verifier', {
    verifyGpgSignature: async () => { throw new Error('Registry path should not GPG-verify'); }
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
