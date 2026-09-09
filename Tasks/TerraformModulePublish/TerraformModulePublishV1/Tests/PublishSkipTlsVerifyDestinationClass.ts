import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import { stubDnsZone, TLS_OPT_OUT_ZONE } from './stub-dns';

// #588 CLASS fixture: one mock run per destination row of the
// skipTlsVerify/rejectUnauthorized class table in L0.ts, parameterized by
// environment so the table lives in one place instead of being restated as N
// near-identical fixture files. The destination is the only thing that varies;
// everything else is the ordinary private-registry publish path.
//
// The publisher and the HTTPS transport are stubbed so no socket is ever
// opened: a row that expects a rejection must be rejected BEFORE the transport
// exists, not by failing to connect.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

stubDnsZone(TLS_OPT_OUT_ZONE);

tr.setInput('registryType', 'private');
tr.setInput('namespace', 'aceo');
tr.setInput('name', 'networking-vpc');
tr.setInput('provider', 'aws');
tr.setInput('version', '1.0.0');
tr.setInput('registryUrl', process.env['TFMP_CLASS_REGISTRY_URL'] || '');
tr.setInput('apiKey', 'super-secret-api-key');
tr.setInput('skipTlsVerify', process.env['TFMP_CLASS_SKIP_TLS'] || 'true');
tr.setInput('waitForPublish', 'false');
tr.setInput('timeoutSeconds', '180');

tr.registerMock('./http', {
    createHttpsClient: () => () => Promise.resolve({ status: 200, body: '{}' }),
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
