import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// The registry download_url carries a live storage credential in its query
// string, and tool-lib logs the URL at INFO (fully redacting only Azure
// `sig=`). Assert every sensitive token component is registered as a secret
// (so the agent masks it) while benign params stay visible. Mirrors
// TerraformInstaller's RegistryDownloadTokenMasked.ts regression test.
const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('policyAgent', 'sentinel');
tr.setInput('version', '0.40.0');
tr.setInput('downloadSource', 'registry');
tr.setInput('registryUrl', 'https://registry.example.com');
tr.setInput('registryMirrorName', 'sentinel');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

// dns: storage.example.com is a fictional test host with no real DNS record;
// mock it to a public (non-private/link-local) address so the #769
// resolvesToPrivateOrLinkLocalAddress check passes without a real network
// lookup, instead of failing with a real ENOTFOUND in this offline test run.
tr.registerMock('dns', {
  promises: {
    lookup: async (_host: string, _opts: any) => [{ address: '203.0.113.10', family: 4 }]
  }
});

const EXPECTED_SHA256 = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';

const AWS_SIGNATURE = 'AWSSIGNATUREtoken1111';        // X-Amz-Signature       -> masked
const AWS_CREDENTIAL = 'AWSCREDENTIALtoken2222';      // X-Amz-Credential      -> masked
const AWS_SECURITY_TOKEN = 'AWSSECURITYtoken3333';    // X-Amz-Security-Token  -> masked
const GOOG_SIGNATURE = 'GOOGSIGNATUREtoken4444';      // X-Goog-Signature      -> masked
const GOOG_CREDENTIAL = 'GOOGCREDENTIALtoken5555';    // X-Goog-Credential     -> masked
const AZURE_SIG = 'AZURESIGtoken6666';                // sig (Azure SAS)       -> masked
const BENIGN_DATE = '20260703T000000Z';               // X-Amz-Date            -> NOT masked
const BENIGN_SIGNED_HEADERS = 'host';                 // X-Amz-SignedHeaders   -> NOT masked

const PRESIGNED_URL =
  'https://storage.example.com/signed/sentinel_0.40.0_linux_amd64.zip' +
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
    if (url === 'https://registry.example.com/terraform/binaries/sentinel/versions/0.40.0/linux/amd64') {
      return { download_url: PRESIGNED_URL, sha256: EXPECTED_SHA256 };
    }
    throw new Error('Unexpected fetchJson URL: ' + url);
  },
  fetchText: async (url: string) => { throw new Error('Registry path should not fetch text: ' + url); },
  DOWNLOAD_TIMEOUT_MS: 600000,
  // downloadToFile now replaces tools.downloadTool() on the DEFAULT (no
  // allowlist) path too (#729 follow-up); simulate a clean, non-redirected
  // download the same way downloadTool is stubbed elsewhere.
  downloadToFile: async (url: string, _destPath: string, _timeoutMs: number, isHostAllowed: (hostname: string) => void) => {
    isHostAllowed(new URL(url).hostname);
  }
});

tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./gpg-verifier', { verifyGpgSignature: async () => { throw new Error('registry must not use GPG'); } });

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
  find: { '/tmp/sentinel-cached': ['/tmp/sentinel-cached/sentinel'] }
};
tr.setAnswers(a);
tr.run();
