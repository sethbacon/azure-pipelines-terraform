import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #359: a malformed checkpoint-API response (the API contract itself broke)
// must now fail fatally instead of being silently swallowed into the same
// fallback path as a transient network error -- proves the try-scope narrowing
// that moved the "!data.current_version" validation outside the catch.
const tp = path.join(__dirname, 'HashiCorpLatestCheckpointInvalidResponseFailL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', 'latest');
tr.setInput('downloadSource', 'hashicorp');

tr.registerMock('os', {
    type: () => 'Windows_NT',
    arch: () => 'x64'
});

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        if (new URL(url).hostname === 'checkpoint-api.hashicorp.com') {
            return {}; // missing current_version
        }
        throw new Error('Unexpected fetchJson URL: ' + url);
    },
    fetchText: async (url: string) => {
        throw new Error('Should not fetch SHA256SUMS: ' + url);
    }
});

tr.registerMock('undici', { ProxyAgent: class { } });

tr.registerMock('./gpg-verifier', {
    verifyGpgSignature: async () => { throw new Error('Should not reach GPG verification'); }
});

tr.registerMock('./cosign-verifier', {
    verifyCosignSignature: async () => { }
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: (_toolName: string, _version: string) => null,
    downloadTool: async () => { throw new Error('Should not download when the checkpoint response is malformed'); },
    extractZip: async () => { throw new Error('Should not extract'); },
    cacheDir: async () => { throw new Error('Should not cache'); },
    cleanVersion: (version: string) => version,
    prependPath: (_toolPath: string) => { }
});

const a: ma.TaskLibAnswers = {};
tr.setAnswers(a);
tr.run();
