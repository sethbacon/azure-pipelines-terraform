import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// tfpolicy, Terraform Policy's CLI (policy tests), is published like
// tfpolicy-plugin: a GPG-signed zip on releases.hashicorp.com under its own
// product name. Each URL is logged for Tests/L0.ts to assert.
const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('policyAgent', 'tfpolicy');
tr.setInput('version', 'latest');
tr.setInput('downloadSource', 'official');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

const EXPECTED_SHA256 = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        console.log(`TfPolicyCli test: fetchJson(${url})`);
        return { current_version: '0.5.0' };
    },
    fetchText: async (url: string) => {
        console.log(`TfPolicyCli test: fetchText(${url})`);
        return `${EXPECTED_SHA256}  tfpolicy_0.5.0_linux_amd64.zip\n`;
    }
});

tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./gpg-verifier', {
    verifyGpgSignature: async (_content: string, sigUrl: string, required: boolean) => {
        console.log(`TfPolicyCli test: verifyGpgSignature(${sigUrl}, required=${required})`);
        return true;
    }
});

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
    downloadTool: async (url: string) => {
        console.log(`TfPolicyCli test: downloadTool(${url})`);
        return '/tmp/tfpolicy.zip';
    },
    extractZip: async (file: string) => {
        console.log(`TfPolicyCli test: extractZip(${file})`);
        return '/tmp/tfpolicy-extracted';
    },
    cacheDir: async () => '/tmp/tfpolicy-cached',
    cleanVersion: (v: string) => v,
    prependPath: () => { }
});

const a: ma.TaskLibAnswers = {
    find: { '/tmp/tfpolicy-cached': ['/tmp/tfpolicy-cached/tfpolicy'] }
};
tr.setAnswers(a);
tr.run();
