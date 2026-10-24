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

// For `nestedDrift`: 13 unchanged tags, together past the contract's
// 300-code-point value cap, so the whole map cannot show which key changed.
const LONG_TAGS: Record<string, string> = {
    ACCESSIBILITY: 'Not Internet Accessible',
    AGN: '',
    APPID: 'APP0000',
    AUDIT: 'None',
    CONFIDENTIALITY: 'Internal',
    CRITICALITY: 'Supporting',
    DIVISION: 'XYZ',
    DYNAMIC_FIREWALL: 'SN-XYZ-APP0000-P-CUS01',
    EXPIRATION_DATE: 'none',
    PROJECT_COST_CENTER: '',
    REQUESTOR: 'Requestor Name',
    SUPPORT_GROUP: 'Cloud Engineering',
    TIER: 'Production',
};

// azurerm 4.81.0's `blob_properties` mirror: a container for every nested
// block, and no `true` anywhere in it.
const BLOB_PROPERTIES_MIRROR = [
    { container_delete_retention_policy: [{}], cors_rule: [], delete_retention_policy: [{}], restore_policy: [] },
];

function blobProperties(days: number): unknown[] {
    return [
        {
            change_feed_enabled: false,
            container_delete_retention_policy: [{ days }],
            cors_rule: [],
            delete_retention_policy: [{ days, permanent_delete_enabled: false }],
            restore_policy: [],
            versioning_enabled: false,
        },
    ];
}

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
    // Contract 1.4.0: `resource_drift` (infra drift) alongside an EMPTY
    // `resource_changes` (no unapplied config changes). Proves drift_added/
    // drift_changed/drift_destroyed/drift_summary are forwarded and that they
    // do not leak into added/changed/destroyed/drifted, which stay 0/0/0/false.
    driftOnly: {
        resource_changes: [],
        resource_drift: [
            { address: 'aws_instance.drifted', change: { actions: ['update'], before: { size: 1 }, after: { size: 2 } } },
        ],
    },
    // resource_drift entries go through the identical skip rules as
    // resource_changes (exactly `["no-op"]` or `["read"]` is skipped).
    driftSkipped: {
        resource_changes: [],
        resource_drift: [
            { address: 'aws_instance.noop', change: { actions: ['no-op'], before: {}, after: {} } },
            { address: 'aws_instance.read', change: { actions: ['read'], before: null, after: {} } },
        ],
    },
    // Both axes populated at once, with different action kinds, to prove
    // resource_changes and resource_drift are counted independently rather
    // than merged or one shadowing the other.
    driftBoth: {
        resource_changes: [
            { address: 'aws_instance.new', change: { actions: ['create'], before: null, after: {} } },
        ],
        resource_drift: [
            { address: 'aws_instance.gone', change: { actions: ['delete'], before: {}, after: null } },
        ],
    },
    // Contract 1.4.2: a state carrying the SDK's unconfigured `timeouts` block
    // as an object of nulls against a plan whose `after` has null (the
    // Brunswick fleet shape, 2026-10-21). The real change still has to travel;
    // the value-free `timeouts` difference must not. `withValue` is the
    // control: a configured timeout is a change and keeps being reported.
    timeoutsNullLeaved: {
        resource_changes: [
            {
                address: 'azurerm_subnet.app',
                change: {
                    actions: ['update'],
                    before: {
                        private_link_service_network_policies_enabled: true,
                        timeouts: { create: null, delete: null, read: null, update: null },
                    },
                    after: { private_link_service_network_policies_enabled: false, timeouts: null },
                    before_sensitive: {},
                    after_sensitive: {},
                },
            },
            {
                address: 'azurerm_subnet.withValue',
                change: {
                    actions: ['update'],
                    before: { timeouts: { create: '30m', delete: null, read: null, update: null } },
                    after: { timeouts: null },
                    before_sensitive: {},
                    after_sensitive: {},
                },
            },
        ],
    },
    // Contract 1.5.0: the Brunswick fleet shapes of 2026-10-22, values
    // replaced. A re-tag changed one key of a map past the 300-code-point
    // value cap (TBD3216/APP2934, build 378948), and a storage account's only
    // real change was inside `blob_properties`, whose mirror holds no `true`
    // (TBD4545/APP6233, builds 378968 and 379017). The account key is marked
    // and must stay masked.
    nestedDrift: {
        resource_changes: [
            {
                address: 'module.app_pattern.azurerm_resource_group.application',
                change: {
                    actions: ['update'],
                    before: { tags: { ...LONG_TAGS, COST_CENTER: '100.000.1111.0000001' } },
                    after: { tags: { ...LONG_TAGS, COST_CENTER: '100.000.2222.0000002' } },
                    before_sensitive: { tags: {} },
                    after_sensitive: { tags: {} },
                },
            },
            {
                address: 'module.app_pattern.azurerm_storage_account.application[0]',
                change: {
                    actions: ['update'],
                    before: { blob_properties: blobProperties(7), primary_access_key: 'FAKE-PRIMARY-KEY-1' },
                    after: { blob_properties: blobProperties(30), primary_access_key: 'FAKE-PRIMARY-KEY-2' },
                    before_sensitive: { blob_properties: BLOB_PROPERTIES_MIRROR, primary_access_key: true },
                    after_sensitive: { blob_properties: BLOB_PROPERTIES_MIRROR, primary_access_key: true },
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
