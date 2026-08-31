import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

// #588: rejectUnauthorized=false with a callbackUrl that new URL() cannot
// parse must be REJECTED (fail closed), not silently let through. The
// transport is stubbed so no real network call is made; the rejection must
// happen before it is ever invoked.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const dir = path.join(os.tmpdir(), 'tdr-cb-tlsoff-unparseable');
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
tr.setInput('callbackUrl', 'not-a-valid-url');
tr.setInput('callbackToken', 'super-secret-callback-token');
tr.setInput('rejectUnauthorized', 'false');

tr.registerMock('./https-client', {
    createHttpsClient: () => () => Promise.resolve({ status: 200, body: '{}' }),
    DEFAULT_REQUEST_TIMEOUT_MS: 30000,
});

tr.run();
