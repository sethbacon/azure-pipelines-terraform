import { describe, it } from 'mocha';
import assert = require('assert');
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildPolicySarif, writeJUnit, writeSarif } from '../src/results';
import { PolicyResult } from '../src/types';

// Direct (parent-process) unit tests for the reporting helpers. The MockTestRunner
// scenarios exercise the OPA-violation SARIF path and JUnit publish; these cover the
// branches they don't: the Sentinel-style fallback (failure with no per-rule
// breakdown), advisory→warning level mapping, JUnit failure rendering, and the
// explicit-output-path branch of writeSarif.

describe('results: SARIF generation', () => {
    it('maps advisory findings to warnings and gates the rest as errors', () => {
        const result: PolicyResult = {
            passed: false,
            violations: ['p1 failed'],
            rawOutput: 'raw',
            cases: [
                { name: 'p1', passed: false, message: 'advisory finding', enforcementLevel: 'advisory' },
                { name: 'p2', passed: false }, // no message → fallback text
                { name: 'p3', passed: true },
            ],
        };
        const sarif = buildPolicySarif(result, 'sentinel');
        const run = sarif.runs[0];
        // Every evaluated case is catalogued as a rule.
        assert.deepStrictEqual(run.tool.driver.rules.map(r => r.id).sort(), ['p1', 'p2', 'p3']);
        const p1 = run.results.find(r => r.ruleId === 'p1');
        const p2 = run.results.find(r => r.ruleId === 'p2');
        assert.strictEqual(p1?.level, 'warning', 'advisory → warning');
        assert.strictEqual(p2?.level, 'error', 'non-advisory → error');
        assert.strictEqual(p2?.message.text, 'Policy p2 failed', 'missing message falls back');
        assert.strictEqual(run.results.length, 2, 'only failed cases produce results');
    });

    it('falls back to engine-level violations when there is no per-rule breakdown', () => {
        const result: PolicyResult = {
            passed: false,
            violations: ['hard policy A denied', 'hard policy B denied'],
            rawOutput: 'raw',
            cases: [{ name: 'only-passing', passed: true }],
        };
        const sarif = buildPolicySarif(result, 'sentinel');
        const run = sarif.runs[0];
        assert.strictEqual(run.results.length, 2, 'one result per raw violation');
        run.results.forEach(r => {
            assert.strictEqual(r.ruleId, 'sentinel-policy-violation');
            assert.strictEqual(r.level, 'error');
        });
        assert.deepStrictEqual(run.results.map(r => r.message.text), result.violations);
    });

    it('produces an empty result set when the policy passed', () => {
        const result: PolicyResult = { passed: true, violations: [], rawOutput: '', cases: [{ name: 'p1', passed: true }] };
        const sarif = buildPolicySarif(result, 'opa');
        assert.strictEqual(sarif.runs[0].results.length, 0);
        assert.strictEqual(sarif.version, '2.1.0');
    });

    it('writeSarif honours an explicit output path and otherwise uses a temp file', () => {
        const result: PolicyResult = { passed: false, violations: ['x'], rawOutput: 'x', cases: [{ name: 'p1', passed: false, message: 'x' }] };

        const explicit = path.join(os.tmpdir(), `tpc-sarif-${Date.now()}`, 'out.sarif');
        fs.rmSync(explicit, { force: true });
        const written = writeSarif(result, 'opa', explicit);
        assert.strictEqual(written, path.resolve(explicit));
        assert.ok(fs.existsSync(written));
        fs.rmSync(path.dirname(explicit), { recursive: true, force: true });

        const defaulted = writeSarif(result, 'opa');
        assert.ok(defaulted.endsWith('.sarif') && fs.existsSync(defaulted));
        fs.rmSync(defaulted, { force: true });
    });
});

describe('results: JUnit generation', () => {
    it('renders failures with <failure> elements and counts them', () => {
        const xmlPath = writeJUnit([
            { name: 'allow_public', passed: false, message: 'bucket is public' },
            { name: 'no_message', passed: false },
            { name: 'ok_rule', passed: true },
        ], 'opa');
        try {
            const xml = fs.readFileSync(xmlPath, 'utf-8');
            assert(/tests="3" failures="2"/.test(xml), 'suite tallies tests and failures');
            assert(/<failure message="bucket is public">/.test(xml), 'failure message rendered');
            assert(/Policy no_message failed/.test(xml), 'missing message falls back');
            assert(/name="ok_rule"><\/testcase>/.test(xml), 'passing case is self-closing');
        } finally {
            fs.rmSync(xmlPath, { force: true });
        }
    });
});
