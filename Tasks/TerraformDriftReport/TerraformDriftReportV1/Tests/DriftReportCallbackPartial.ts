import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const dir = path.join(os.tmpdir(), 'tdr-cb-partial');
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
// Only the URL is set (no token), so the callback must be skipped with a warning.
tr.setInput('callbackUrl', 'https://tsm.example.com/drift');

// Stub the callback transport: it must NOT be invoked on this path.
tr.registerMock('./callback', {
    postJson: async () => ({ status: 200, body: '{}' }),
    postJsonWithRetry: async () => ({ status: 200, body: '{}' }),
    truncateBody: (body: string) => body,
});

tr.run();
