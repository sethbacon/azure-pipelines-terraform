import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');
import { resolveRejectUnauthorized, resolveFailOnCallbackError } from '../src/callback';

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const dir = path.join(os.tmpdir(), 'tdr-cb-fail-nonfatal');
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
tr.setInput('callbackUrl', 'https://tsm.example.com/drift');
tr.setInput('callbackToken', 'super-secret-callback-token');
tr.setInput('rejectUnauthorized', 'true');
// failOnCallbackError disabled -> a non-2xx callback response must only warn.
tr.setInput('failOnCallbackError', 'false');

// Stub the callback transport to return a non-2xx status; the task must still succeed.
tr.registerMock('./callback', {
    postJson: async () => ({ status: 500, body: 'internal error' }),
    postJsonWithRetry: async () => ({ status: 500, body: 'internal error' }),
    truncateBody: (body: string) => body,
    resolveRejectUnauthorized,
    resolveFailOnCallbackError,
});

tr.run();
