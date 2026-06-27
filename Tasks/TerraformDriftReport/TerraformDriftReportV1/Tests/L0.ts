import * as assert from 'assert';
import * as ttm from 'azure-pipelines-task-lib/mock-test';
import * as path from 'path';
import { postJson, truncateBody } from '../src/callback';

describe('TerraformDriftReport callback transport', function () {
    it('refuses to POST the callback token over a non-HTTPS URL', async () => {
        await assert.rejects(
            postJson('http://insecure.example.com/drift', { 'X-TSM-Callback-Token': 't' }, '{}'),
            /non-HTTPS/,
        );
    });

    it('truncates a long response body and passes a short one through', () => {
        assert.strictEqual(truncateBody(''), '');
        assert.strictEqual(truncateBody('short body'), 'short body');
        const long = 'x'.repeat(600);
        const out = truncateBody(long);
        assert.ok(out.length < long.length, 'long body should be truncated');
        assert.ok(out.endsWith('… (truncated)'), 'should mark truncation');
    });
});

describe('TerraformDriftReport Test Suite', function () {

    before(() => {
        delete process.env.NODE_OPTIONS;
        (ttm.MockTestRunner.prototype as unknown as { getNodePath: () => string }).getNodePath = function () {
            return process.execPath;
        };
    });

    after(() => { });

    function runValidations(validator: () => void, tr: ttm.MockTestRunner) {
        try {
            validator();
        } catch (error) {
            console.log("STDERR", tr.stderr);
            console.log("STDOUT", tr.stdout);
            throw error;
        }
    }

    it('DriftReportBasic — drift reported, succeeds (failOnDrift=false), outputs set', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'DriftReportBasic.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            // create counts; the read entry is skipped (contract semantics).
            assert(tr.stdout.includes('drifted=true added=1 changed=0 destroyed=0'), 'drift line incorrect');
            assert(tr.stdout.includes('1 changed resources'), 'read entry should be skipped from the summary');
        }, tr);
    });

    it('DriftReportFailOnDrift — drift + failOnDrift=true fails the task', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'DriftReportFailOnDrift.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.errorIssues.length > 0, 'should have an error issue');
        }, tr);
    });

    it('DriftReportClean — no-op only is clean and succeeds even with failOnDrift=true', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'DriftReportClean.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.succeeded, 'clean plan should succeed');
            assert(tr.stdout.includes('drifted=false'), 'should report no drift');
        }, tr);
    });

    it('DriftReportMissingFile — missing planJsonFile fails', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'DriftReportMissingFile.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.errorIssues.length > 0, 'should have an error issue');
        }, tr);
    });
});
