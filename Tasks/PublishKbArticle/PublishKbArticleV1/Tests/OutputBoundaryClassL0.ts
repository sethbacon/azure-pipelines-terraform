/**
 * Output-boundary defect class — the PublishKbArticleV1 rows.
 *
 * The class: "a value that originates in template-, tool- or remote-service-
 * controlled output crosses a trust boundary (a pipeline output variable, a
 * file path, a parsed file) without content validation or containment."
 *
 * These are the BEHAVIOURAL rows for this task's sinks in the cross-task class
 * table maintained at Tasks/TerraformTask/TerraformTaskV5/Tests/
 * OutputBoundaryClassL0.ts. They live HERE rather than there because every task
 * directory is an independent npm package with its own node_modules, and
 * src/manifest.ts imports `azure-pipelines-task-lib/task` — which does not
 * resolve from TerraformTaskV5's package, so importing this module across the
 * task boundary only ever compiled on a machine where both trees happened to be
 * installed. V5 keeps the STRUCTURAL rows for these same three sinks (it reads
 * this task's sources as text, which needs no import); the executable
 * assertions are the ones below.
 *
 * Every row is mutation-provable: inverting that row's own guard predicate in
 * src/manifest.ts turns that row RED and leaves the others green.
 *
 * Registered via Tests/L0.ts, which mocha actually runs.
 */

import { describe, it } from 'mocha';
import assert = require('assert');
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import { appendToManifest, outputArticleInfoToJson, sanitizeOutputVariableValue } from '../src/manifest';

function classTmpDir(prefix: string): string {
    return fs.mkdtempSync(nodePath.join(os.tmpdir(), prefix));
}

describe('Output-boundary defect class (PublishKbArticleV1 sinks: S1 output variables / S2 path writes / S4 unbounded parse)', () => {

    // --- S1: pipeline output variables ------------------------------------

    it('S1 setVariable(kbArticleId/kbArticleNumber/kbWorkflowState) — a ServiceNow-response field carrying CR/LF or a ##vso[ payload is rejected', () => {
        // The console echoes of these same three fields were newline-neutralized
        // (#693) while the sibling setVariable calls had no validation at all --
        // "the guard exists and one sink is missing from it".
        assert.strictEqual(
            sanitizeOutputVariableValue('a1b2c3\n##vso[task.setvariable variable=pwned]1'),
            null,
            'a control-char-bearing ServiceNow value must not become an output variable',
        );
        assert.strictEqual(sanitizeOutputVariableValue('\r\n'), null);
        // A cast (`article['sys_id'] as string`) is erased at runtime, so a
        // non-string response field used to reach setVariable unchanged.
        assert.strictEqual(sanitizeOutputVariableValue({ nested: true }), null);
        assert.strictEqual(sanitizeOutputVariableValue('x'.repeat(1025)), null);
        // Real values still pass.
        assert.strictEqual(sanitizeOutputVariableValue('a1b2c3d4e5f6'), 'a1b2c3d4e5f6');
        assert.strictEqual(sanitizeOutputVariableValue('KB0010023'), 'KB0010023');
    });

    // --- S2: path write sinks ---------------------------------------------

    it('S2 outputArticleInfoToJson — a ServiceNow-supplied article number cannot steer the write out of the working directory', () => {
        const dir = classTmpDir('kb-class-kbjson-');
        const outside = nodePath.join(dir, 'outside');
        const cwd = nodePath.join(dir, 'cwd');
        fs.mkdirSync(outside);
        fs.mkdirSync(cwd);
        const previous = process.cwd();
        try {
            process.chdir(cwd);
            outputArticleInfoToJson({ number: '../outside/pwned', sys_id: 'a1b2c3' });
            assert.ok(!fs.existsSync(nodePath.join(outside, 'pwned.json')), 'the write must not escape the working directory');
            assert.ok(fs.existsSync(nodePath.join(cwd, 'article_info.json')), 'it must fall back to the in-directory default name');
        } finally {
            process.chdir(previous);
        }
    });

    // --- S4: unbounded parse of tool-written content ----------------------

    it('S4 kb-manifest read — an over-cap manifest is never buffered or parsed', () => {
        const dir = classTmpDir('kb-class-kbmanifest-');
        const manifestPath = nodePath.join(dir, 'kb-manifest.json');
        // VALID JSON, deliberately over the 5 MiB cap: an invalid blob would be
        // rejected by JSON.parse itself and could not distinguish "the cap ran"
        // from "the parse failed", so the mutation would survive.
        const oversized = JSON.stringify(new Array(700_000).fill('xxxxxx'));
        assert.ok(oversized.length > 5 * 1024 * 1024, 'fixture must exceed the cap');
        fs.writeFileSync(manifestPath, oversized);

        appendToManifest(manifestPath, { sys_id: 'new' });

        // The cap rejects the read before JSON.parse, so the oversized file is
        // preserved as a .bak and the manifest restarts with only the new entry.
        // Without the cap it would parse cleanly and keep all 700k entries.
        const entries = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        assert.strictEqual(entries.length, 1, 'an over-cap manifest must not be parsed and re-serialized');
        assert.ok(
            fs.readdirSync(dir).some((f) => f.includes('.corrupt-') && f.endsWith('.bak')),
            'the unread oversized manifest must be preserved as a .bak, never silently discarded',
        );
    });
});
