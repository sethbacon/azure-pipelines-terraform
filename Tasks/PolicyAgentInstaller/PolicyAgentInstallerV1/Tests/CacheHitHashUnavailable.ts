import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('policyAgent', 'opa');
tr.setInput('version', '1.17.1');
tr.setInput('downloadSource', 'official');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => { throw new Error('fetchJson should not be called for a specific version: ' + url); },
    fetchTextAllow404: async (url: string) => { throw new Error(`getaddrinfo ENOTFOUND while fetching ${url}`); }
});

tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./gpg-verifier', { verifyGpgSignature: async () => { } });

// No stored integrity marker exists (e.g. cached by an installer version that
// predates this check, or cached with checksum verification disabled), so the
// installer attempts a remote re-verification — but the source is unreachable
// (offline/air-gapped agent, simulated by downloadTool throwing a network
// error). The install must degrade gracefully to the pre-existing
// trust-the-cache behavior with a warning, never fail: offline cache reuse is
// an explicitly supported scenario.
tr.registerMock('fs', {
    existsSync: (_p: string) => false,
    readFileSync: (_p: string, _enc?: string) => {
        throw new Error('readFileSync should not be called when the re-verification download failed');
    },
    writeFileSync: () => { throw new Error('writeFileSync should not be called when re-verification was degraded'); },
    chmodSync: () => { },
    mkdirSync: () => undefined,
    copyFileSync: () => { }
});

tr.registerMock('crypto', { randomUUID: () => 'test-uuid' });

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: () => '/tmp/opa-cached',
    downloadTool: async (url: string) => { throw new Error(`getaddrinfo ENOTFOUND while downloading ${url}`); },
    extractZip: async () => { throw new Error('extractZip should not be called when the re-verification download failed'); },
    cacheDir: async () => { throw new Error('cacheDir should not be called on a cache hit'); },
    cleanVersion: (v: string) => v,
    prependPath: () => { }
});

const a: ma.TaskLibAnswers = {
    find: { '/tmp/opa-cached': ['/tmp/opa-cached/opa'] }
};
tr.setAnswers(a);
tr.run();
