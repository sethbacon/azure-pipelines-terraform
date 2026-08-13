import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

// Drives the real src/index.js -- and therefore the real, resolved
// @4cloudguru/terraform-drift-contract -- over a plan whose sensitivity marks
// are ASYMMETRIC, the shape terraform actually produces: a config-derived mark
// (a `sensitive = true` variable, sensitive(), a sensitive module output) is
// applied to the PLANNED value only and is never persisted to state, so a
// credential routinely arrives marked on exactly one side.
//
// Under the contract's pre-1.1.0 per-side masking each side was masked against
// its own mirror, so the unmarked side was emitted verbatim into the summary
// file, the callback body and the SARIF report. The module_calls subtree was
// likewise forwarded raw, carrying `expressions.*.constant_value` and a
// credential-bearing module `source` URL that no sensitivity metadata exists to
// mask. L0 asserts neither literal survives anywhere in what the task writes.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const dir = path.join(os.tmpdir(), 'tdr-sensitive');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const planFile = path.join(dir, 'plan.json');
fs.writeFileSync(
    planFile,
    JSON.stringify({
        resource_changes: [
            {
                // Marked on `after` only.
                address: 'aws_instance.web',
                change: {
                    actions: ['update'],
                    before: { user_data: 'BEFORE-ONLY-PLAINTEXT-SECRET' },
                    after: { user_data: 'AFTER-VALUE-MARKED-SENSITIVE' },
                    before_sensitive: {},
                    after_sensitive: { user_data: true },
                },
            },
            {
                // The mirror image: marked on `before` only.
                address: 'aws_db_instance.legacy',
                change: {
                    actions: ['update'],
                    before: { password: 'BEFORE-VALUE-MARKED-SENSITIVE' },
                    after: { password: 'AFTER-ONLY-PLAINTEXT-SECRET' },
                    before_sensitive: { password: true },
                    after_sensitive: {},
                },
            },
        ],
        configuration: {
            root_module: {
                module_calls: {
                    vpc: {
                        source: 'git::https://x-access-token:ghp_MODULESOURCETOKEN@github.com/org/mod.git',
                        version_constraint: '~> 5.0',
                        expressions: { db_password: { constant_value: 'CONFIG-EMBEDDED-PASSWORD' } },
                        module: { resources: [{ address: 'aws_db_instance.inner' }] },
                    },
                },
            },
        },
    }),
);

tr.setInput('planJsonFile', planFile);
// Exercises moduleCallsPlan() -- the second half of the contract fix.
tr.setInput('includeModuleProvenance', 'true');
tr.setInput('moduleManifest', path.join(dir, 'no-such-modules.json'));
tr.setInput('failOnDrift', 'false');
// The SARIF report is the other plan-derived artifact this task writes, so it
// gets the same no-leak assertion.
tr.setInput('sarifOutput', 'true');
tr.setInput('sarifPath', path.join(dir, 'drift.sarif'));

tr.run();
