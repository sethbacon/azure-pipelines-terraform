import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// Proves timeoutSeconds is NOT forwarded as the per-request socket timeout
// (audit finding: it previously doubled as both the poll deadline and the
// socket timeout via createHttpsClient(..., timeoutSeconds * 1000), so a large
// user-configured wait-for-publish deadline also let any single stuck request
// hang for that same long duration instead of failing fast). Uses a large,
// distinctive timeoutSeconds (999) so a regression back to the old
// `timeoutSeconds * 1000` behavior would be unambiguous in the logged args.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('registryType', 'private');
tr.setInput('namespace', 'aceo');
tr.setInput('name', 'networking-vpc');
tr.setInput('provider', 'aws');
tr.setInput('version', '1.0.0');
tr.setInput('registryUrl', 'https://registry.example.com');
tr.setInput('apiKey', 'super-secret-api-key');
tr.setInput('skipTlsVerify', 'false');
tr.setInput('waitForPublish', 'true');
tr.setInput('timeoutSeconds', '999');

// Stub the HTTPS transport, logging the exact args it was called with so the
// parent test process (which spawns this file as a child) can inspect them.
tr.registerMock('./http', {
    createHttpsClient: (rejectUnauthorized: unknown, timeoutMs: unknown) => {
        console.log(`CREATE_HTTPS_CLIENT_ARGS:${JSON.stringify([rejectUnauthorized, timeoutMs])}`);
        return () => Promise.resolve({ status: 200, body: '{}' });
    },
});

tr.registerMock('./private-publisher', {
    PrivateRegistryPublisher: class {
        publish() {
            return Promise.resolve({ published: true, message: 'Sync triggered for version 1.0.0.' });
        }
    },
});

tr.registerMock('./hcp-publisher', {
    HcpPublisher: class {
        publish() {
            return Promise.resolve({ published: true, message: 'should not be called' });
        }
    },
});

tr.run();
