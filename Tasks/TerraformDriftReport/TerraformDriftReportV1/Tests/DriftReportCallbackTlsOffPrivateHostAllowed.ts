import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

// #588 companion: a callback host that resolves to a PRIVATE address is the
// legitimate use case rejectUnauthorized=false exists for, and must still
// succeed (with the existing RejectUnauthorizedDisabled warning), not be
// falsely rejected by the new public-host guard. Uses a private IP literal so
// the check is exercised with no live DNS lookup needed.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const dir = path.join(os.tmpdir(), 'tdr-cb-tlsoff-private');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const planFile = path.join(dir, 'plan.json');
fs.writeFileSync(
    planFile,
    JSON.stringify({
        resource_changes: [
            { address: 'aws_instance.new', change: { actions: ['create'], before: null, after: { ami: 'ami-1' } } },
        ],
    }),
);

tr.setInput('planJsonFile', planFile);
tr.setInput('includeModuleProvenance', 'false');
tr.setInput('failOnDrift', 'false');
tr.setInput('callbackUrl', 'https://10.0.0.5/drift');
tr.setInput('callbackToken', 'super-secret-callback-token');
tr.setInput('rejectUnauthorized', 'false');

tr.registerMock('./https-client', {
    createHttpsClient: () => () => Promise.resolve({ status: 200, body: '{}' }),
    DEFAULT_REQUEST_TIMEOUT_MS: 30000,
});

tr.run();
