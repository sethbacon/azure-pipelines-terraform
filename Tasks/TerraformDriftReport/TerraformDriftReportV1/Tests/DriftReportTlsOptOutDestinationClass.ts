import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');
import { stubDnsZone, TLS_OPT_OUT_ZONE } from './stub-dns';

// #588 CLASS fixture: one mock run per destination row of the
// skipTlsVerify/rejectUnauthorized class table in L0.ts, parameterized by
// environment so the same table can be stated once and applied to both
// credential-bearing TLS-opt-out inputs in this repository. The destination is
// the only thing that varies.
//
// The HTTPS transport is stubbed so no socket is ever opened: a row that
// expects a rejection must be rejected BEFORE the transport exists, not by
// failing to connect.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

stubDnsZone(TLS_OPT_OUT_ZONE);

// Unique per-run temp dir via fs.mkdtempSync instead of a predictable os.tmpdir()
// path, to avoid the insecure-temp-file symlink-race class (CodeQL js/insecure-temporary-file).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdr-cb-tlsclass-'));
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
tr.setInput('callbackUrl', process.env['TFDR_CLASS_CALLBACK_URL'] || '');
tr.setInput('callbackToken', 'super-secret-callback-token');
tr.setInput('rejectUnauthorized', process.env['TFDR_CLASS_REJECT_UNAUTHORIZED'] || 'false');

tr.registerMock('./https-client', {
    createHttpsClient: () => () => Promise.resolve({ status: 200, body: '{}' }),
    DEFAULT_REQUEST_TIMEOUT_MS: 30000,
});

tr.run();
