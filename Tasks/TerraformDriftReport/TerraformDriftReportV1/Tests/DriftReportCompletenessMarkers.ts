import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');
import { resolveRejectUnauthorized, resolveFailOnCallbackError, truncateBody } from '../src/callback';

// Drives the real src/index.js -- and therefore the real, resolved
// @4cloudguru/terraform-drift-contract -- over one of several plan documents,
// and CAPTURES THE BYTES THE TASK WOULD POST.
//
// #950: the callback body was assembled by naming the contract's fields one at a
// time into a `Record<string, unknown>`, so the five completeness markers the
// contract computes (`unparseable`, `unmasked`, `truncated`, `omitted_entries`,
// `omitted_attrs`) were dropped with nothing red -- `tsc` cannot report a field
// that a pick list never mentions, and the destination type accepted anything.
//
// The case is chosen by TDR_MARKER_CASE, and the captured body is written to
// TDR_MARKER_POSTED. mock-test's runner spawns this file with the parent's
// environment and only strips INPUT_/SECRET_/VSTS_TASKVARIABLE_, so both survive
// the hop. One fixture over a table of documents rather than six near-identical
// files: the defect is a CLASS, and every case has to be asserted in BOTH
// directions -- a body that hardcoded `unparseable: false` passes any test that
// only ever feeds it a readable plan.

const CASES: Record<string, unknown> = {
    // Parses as JSON but is not a plan: no `resource_changes` at all. A
    // truncated `terraform show -json`, a wrong file, an empty document. This
    // summarizes to 0/0/0 + drifted:false -- byte-identical to `clean` below on
    // every other field, which is the whole reason the marker exists.
    unreadable: {},
    clean: { resource_changes: [] },
    unmasked: {
        resource_changes: [
            { address: 'aws_instance.x', change: { actions: ['update'], before: { size: 1 }, after: { size: 2 } } },
        ],
    },
    masked: {
        resource_changes: [
            {
                address: 'aws_instance.x',
                change: {
                    actions: ['update'],
                    before: { size: 1 },
                    after: { size: 2 },
                    before_sensitive: {},
                    after_sensitive: {},
                },
            },
        ],
    },
    // Three past the contract's 500-entry cap: 503 creates, 500 summary rows.
    // The COUNTS are not capped, so the discrepancy is only legible because
    // omitted_entries travels alongside them.
    cappedEntries: {
        resource_changes: Array.from({ length: 503 }, (_unused, i) => ({
            address: `aws_s3_bucket.b${i}`,
            change: { actions: ['create'], before: null, after: {} },
        })),
    },
    // Four past the contract's 50-attrs-per-entry cap.
    cappedAttrs: {
        resource_changes: [
            {
                address: 'aws_instance.w',
                change: {
                    actions: ['update'],
                    before: Object.fromEntries(Array.from({ length: 54 }, (_unused, i) => [`k${i}`, i])),
                    after: Object.fromEntries(Array.from({ length: 54 }, (_unused, i) => [`k${i}`, 1000 + i])),
                    before_sensitive: {},
                    after_sensitive: {},
                },
            },
        ],
    },
};

const caseName = process.env['TDR_MARKER_CASE'] ?? 'unreadable';
const plan = CASES[caseName];
if (plan === undefined) {
    throw new Error(`unknown TDR_MARKER_CASE: ${caseName}`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdr-markers-'));
const planFile = path.join(dir, 'plan.json');
fs.writeFileSync(planFile, JSON.stringify(plan));

const postedFile = process.env['TDR_MARKER_POSTED'] ?? path.join(dir, 'posted.json');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('planJsonFile', planFile);
tr.setInput('includeModuleProvenance', 'false');
tr.setInput('failOnDrift', 'false');
tr.setInput('callbackUrl', 'https://tsm.example.com/drift');
tr.setInput('callbackToken', 'super-secret-callback-token');
tr.setInput('rejectUnauthorized', 'true');

// Stubs the transport only. The body handed to it is the real one the task
// assembled, written out verbatim so L0 asserts against the bytes that would
// leave the agent rather than against the summary artifact alone -- a refactor
// that assembled the POST separately would keep one right and send the other.
tr.registerMock('./callback', {
    postJson: async () => ({ status: 200, body: '{}' }),
    postJsonWithRetry: async (_url: string, _headers: unknown, body: string) => {
        fs.writeFileSync(postedFile, body);
        return { status: 200, body: '{}' };
    },
    truncateBody,
    resolveRejectUnauthorized,
    resolveFailOnCallbackError,
});

tr.run();
