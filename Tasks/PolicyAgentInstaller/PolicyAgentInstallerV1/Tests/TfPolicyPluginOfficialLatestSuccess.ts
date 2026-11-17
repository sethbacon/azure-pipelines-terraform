import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// tfpolicy-plugin is the engine Terraform launches for Terraform Policy
// (`-policies`, Terraform 1.17+). HashiCorp publishes it exactly like Sentinel --
// a zip on releases.hashicorp.com beside a GPG-signed SHA256SUMS, with the latest
// version on the checkpoint API -- so it must take that path, under ITS OWN
// product name, and not fall through to the OPA (raw GitHub binary) path that
// every agent other than Sentinel used to take. Each URL is logged for
// Tests/L0.ts to assert, because a mock that merely accepts any URL would pass
// while the task fetched Sentinel's artifacts.
const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('policyAgent', 'tfpolicy-plugin');
tr.setInput('version', 'latest');
tr.setInput('downloadSource', 'official');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

const EXPECTED_SHA256 = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        console.log(`TfPolicyPlugin test: fetchJson(${url})`);
        return { current_version: '0.5.0' };
    },
    fetchText: async (url: string) => {
        console.log(`TfPolicyPlugin test: fetchText(${url})`);
        return `${EXPECTED_SHA256}  tfpolicy-plugin_0.5.0_linux_amd64.zip\n`;
    }
});

tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./gpg-verifier', {
    verifyGpgSignature: async (_content: string, sigUrl: string, required: boolean) => {
        console.log(`TfPolicyPlugin test: verifyGpgSignature(${sigUrl}, required=${required})`);
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
        console.log(`TfPolicyPlugin test: downloadTool(${url})`);
        return '/tmp/tfpolicy-plugin.zip';
    },
    extractZip: async (file: string) => {
        console.log(`TfPolicyPlugin test: extractZip(${file})`);
        return '/tmp/tfpolicy-plugin-extracted';
    },
    cacheDir: async () => '/tmp/tfpolicy-plugin-cached',
    cleanVersion: (v: string) => v,
    prependPath: () => { }
});

const a: ma.TaskLibAnswers = {
    find: { '/tmp/tfpolicy-plugin-cached': ['/tmp/tfpolicy-plugin-cached/tfpolicy-plugin'] }
};
tr.setAnswers(a);
tr.run();
