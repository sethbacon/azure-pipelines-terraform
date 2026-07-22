import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #589: terraform-docs cache hit with NO integrity marker; the job requires checksum
// verification. The reverify re-download reaches a REACHABLE registry that returns an
// EMPTY sha256 (required material WITHHELD, not a transport outage). The real reverify
// classification must FAIL CLOSED via the typed VerificationFailure, not degrade to
// trust-the-cache. The subject module (terraform-docs-installer) is not mocked.
const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('version', '0.24.0');
tr.setInput('downloadSource', 'registry');
tr.setInput('registryUrl', 'https://registry.example.com');
tr.setInput('registryMirrorName', 'terraform-docs');
tr.setInput('requireChecksum', 'true');

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

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        if (url.includes('/versions/0.24.0/linux/amd64')) {
            return {
                os: 'linux',
                arch: 'amd64',
                version: '0.24.0',
                sha256: '',
                download_url: 'https://storage.example.com/signed/terraform-docs-v0.24.0-linux-amd64.tar.gz'
            };
        }
        throw new Error('Unexpected fetchJson URL: ' + url);
    },
    fetchTextAllow404: async (url: string) => { throw new Error('fetchTextAllow404 should not be called for registry: ' + url); }
});

tr.registerMock('undici', { ProxyAgent: class { } });

tr.registerMock('fs', {
    existsSync: (_p: string) => false, // no stored integrity marker
    readFileSync: (_p: string, _enc?: string) => Buffer.from('cached-archive-content'),
    writeFileSync: () => {
        throw new Error('writeFileSync must not be called when re-verification fails closed');
    },
    chmodSync: () => { }
});

tr.registerMock('crypto', {
    randomUUID: () => 'test-uuid',
    createHash: () => ({ update: () => ({ digest: () => 'unused' }) })
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: () => '/tmp/terraform-docs-cached',
    downloadTool: async () => '/tmp/terraform-docs-reverify.tar.gz',
    extractTar: async () => { throw new Error('extractTar must not be reached when required material is withheld'); },
    extractZip: async () => { throw new Error('extractZip should not be called on Linux'); },
    cacheDir: async () => { throw new Error('cacheDir should not be called on a cache hit'); },
    cleanVersion: (v: string) => v,
    prependPath: () => { }
});

const a: ma.TaskLibAnswers = {
    find: { '/tmp/terraform-docs-cached': ['/tmp/terraform-docs-cached/terraform-docs'] }
};
tr.setAnswers(a);
tr.run();
