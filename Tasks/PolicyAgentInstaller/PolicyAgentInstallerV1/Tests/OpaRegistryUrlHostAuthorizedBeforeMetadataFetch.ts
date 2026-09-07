import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// CLASS TEST (#1104/20): registryUrl's OWN host must be authorized BEFORE the
// metadata fetch for a SPECIFIC version, not only on the 'latest' resolution
// branch. registryUrl resolves (via the mocked dns module) to the cloud
// metadata address. fetchJson throws if it is ever called, so a regression
// that drops the hoisted check turns this test's failure message from
// "RegistryDownloadHostIsPrivate" into "fetchJson must not be called".
const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('policyAgent', 'opa');
tr.setInput('version', '1.17.1');
tr.setInput('downloadSource', 'registry');
tr.setInput('registryUrl', 'https://registry.example.com');
tr.setInput('registryMirrorName', 'opa');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        throw new Error('fetchJson must not be called: registryUrl host authorization must run first. Called with: ' + url);
    },
    fetchText: async (url: string) => {
        throw new Error('fetchText must not be called: registryUrl host authorization must run first. Called with: ' + url);
    }
});

tr.registerMock('dns', {
    promises: {
        lookup: async (_host: string, _opts: any) => [{ address: '169.254.169.254', family: 4 }]
    }
});

tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./gpg-verifier', { verifyGpgSignature: async () => { } });

// Without this the task dies on an unset Agent.ToolsDirectory before reaching the guard,
// which would let the test pass for the wrong reason under a bare tr.failed assertion.
tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: (_toolName: string, _version: string) => null,
    cleanVersion: (version: string) => version,
    prependPath: (_toolPath: string) => { }
});

tr.run();
