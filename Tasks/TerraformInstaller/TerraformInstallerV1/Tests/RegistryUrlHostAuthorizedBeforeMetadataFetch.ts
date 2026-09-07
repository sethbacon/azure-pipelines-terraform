import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// CLASS TEST (#1104/20): assertEgressHostAllowed on registryUrl's OWN host must
// run BEFORE the metadata fetch, for a SPECIFIC (non-'latest') version -- not
// only on the 'latest' resolution branch. registryUrl is an ordinary-looking
// DNS name (not a literal private IP), so it only fails via the DNS-resolution
// arm below, exactly the case #1104/20 describes as unreachable when the check
// sits below the resolution branch. fetchJson throws if it is ever called, so
// a regression that moves/removes the hoisted check turns this test's failure
// message from "RegistryDownloadHostIsPrivate" into "fetchJson must not be
// called" -- distinct fragments, not a bare tr.failed check.
const tp = path.join(__dirname, 'RegistryUrlHostAuthorizedBeforeMetadataFetchL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', '1.9.8');
tr.setInput('downloadSource', 'registry');
tr.setInput('registryUrl', 'https://registry.example.com');
tr.setInput('registryMirrorName', 'terraform');

tr.registerMock('os', {
    type: () => 'Windows_NT',
    arch: () => 'x64'
});

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        throw new Error('fetchJson must not be called: registryUrl host authorization must run first. Called with: ' + url);
    },
    fetchText: async (url: string) => {
        throw new Error('fetchText must not be called: registryUrl host authorization must run first. Called with: ' + url);
    }
});

// registry.example.com resolves (per this mock) to the cloud metadata address --
// an ordinary-looking name, not a literal private IP.
tr.registerMock('dns', {
    promises: {
        lookup: async (_host: string, _opts: any) => [{ address: '169.254.169.254', family: 4 }]
    }
});

tr.registerMock('undici', { ProxyAgent: class { } });

tr.registerMock('./gpg-verifier', {
    verifyGpgSignature: async () => { }
});

tr.registerMock('./cosign-verifier', {
    verifyCosignSignature: async () => { }
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: (_toolName: string, _version: string) => null,
    cleanVersion: (version: string) => version,
    prependPath: (_toolPath: string) => { }
});

const a: ma.TaskLibAnswers = {};
tr.setAnswers(a);

tr.run();
