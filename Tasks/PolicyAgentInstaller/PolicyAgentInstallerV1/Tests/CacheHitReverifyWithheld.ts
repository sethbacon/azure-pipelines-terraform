import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #589: OPA cache hit with NO integrity marker; the job requires checksum
// verification. The reverify re-download reaches a REACHABLE GitHub release that
// genuinely 404s the required .sha256 (material WITHHELD, not a transport outage —
// fetchTextAllow404 returns null only on a real 404). The real reverify
// classification must FAIL CLOSED via the typed VerificationFailure, not degrade to
// trust-the-cache. The subject module (policy-agent-installer) is not mocked.
const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('policyAgent', 'opa');
tr.setInput('version', '1.17.1');
tr.setInput('downloadSource', 'official');
tr.setInput('requireChecksum', 'true');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => { throw new Error('fetchJson should not be called for a specific version: ' + url); },
    fetchTextAllow404: async (_url: string) => null // required .sha256 withheld (genuine 404)
});

tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./gpg-verifier', { verifyGpgSignature: async () => { } });

tr.registerMock('fs', {
    existsSync: (_p: string) => false, // no stored integrity marker
    readFileSync: (_p: string, _enc?: string) => Buffer.from('cached-binary-content'),
    writeFileSync: () => {
        throw new Error('writeFileSync must not be called when re-verification fails closed');
    },
    chmodSync: () => { },
    mkdirSync: () => undefined,
    copyFileSync: () => { }
});

tr.registerMock('crypto', {
    randomUUID: () => 'test-uuid',
    createHash: () => ({ update: () => ({ digest: () => 'unused' }) })
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: () => '/tmp/opa-cached',
    downloadTool: async () => '/tmp/opa-fresh-binary',
    extractZip: async () => { throw new Error('extractZip should not be called for a raw OPA binary'); },
    cacheDir: async () => { throw new Error('cacheDir should not be called on a cache hit'); },
    cleanVersion: (v: string) => v,
    prependPath: () => { }
});

const a: ma.TaskLibAnswers = { find: { '/tmp/opa-cached': ['/tmp/opa-cached/opa'] } };
tr.setAnswers(a);
tr.run();
