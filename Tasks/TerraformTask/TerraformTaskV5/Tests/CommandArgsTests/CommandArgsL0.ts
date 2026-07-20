import tl = require('azure-pipelines-task-lib');
import { parseVarFileTokens, parseTargetTokens, extractOutFlagPath, commandOptionsContainsJsonFlag } from '../../src/base-terraform-command-handler';

let failed = false;

function check(actual: string[], expected: string[], label: string): void {
    const ok = actual.length === expected.length && actual.every((v, i) => v === expected[i]);
    if (!ok) {
        tl.error(`${label}: expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
        failed = true;
    }
}

function checkOut(actual: string | undefined, expected: string | undefined, label: string): void {
    if (actual !== expected) {
        tl.error(`${label}: expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
        failed = true;
    }
}

function checkBool(actual: boolean, expected: boolean, label: string): void {
    if (actual !== expected) {
        tl.error(`${label}: expected ${expected} but got ${actual}`);
        failed = true;
    }
}

// Empty / undefined input yields no tokens.
check(parseVarFileTokens(undefined), [], 'varFile undefined');
check(parseVarFileTokens(''), [], 'varFile empty');
check(parseTargetTokens(undefined), [], 'target undefined');

// A simple path stays a single token.
check(parseVarFileTokens('prod.tfvars'), ['-var-file=prod.tfvars'], 'varFile simple');

// A path containing spaces must remain ONE token (the bug being fixed: it used to
// be concatenated into a string and re-split on whitespace by ToolRunner.line()).
check(
    parseVarFileTokens('C:\\My Folder\\prod.tfvars'),
    ['-var-file=C:\\My Folder\\prod.tfvars'],
    'varFile with spaces',
);

// Multiple lines produce one token each, trimming blanks.
check(
    parseVarFileTokens('a.tfvars\n  b.tfvars  \n\nc d.tfvars'),
    ['-var-file=a.tfvars', '-var-file=b.tfvars', '-var-file=c d.tfvars'],
    'varFile multiline',
);

// Target addresses, including a quoted index key that contains a space, stay whole.
check(
    parseTargetTokens('aws_instance.foo'),
    ['-target=aws_instance.foo'],
    'target simple',
);
check(
    parseTargetTokens('module.x["a b"]'),
    ['-target=module.x["a b"]'],
    'target with quoted space key',
);

// Invalid target addresses are rejected.
try {
    parseTargetTokens('has spaces');
    tl.error('target invalid: expected parseTargetTokens to throw on "has spaces"');
    failed = true;
} catch {
    // expected
}

// extractOutFlagPath (#612): detect a user-supplied plan-file path so plan()/
// destroy() reuse it instead of injecting a shadowing second -out=.
checkOut(extractOutFlagPath(undefined), undefined, 'out undefined');
checkOut(extractOutFlagPath(''), undefined, 'out empty');
// Equals form, single and double dash.
checkOut(extractOutFlagPath('-out=tfplan'), 'tfplan', 'out equals');
checkOut(extractOutFlagPath('--out=tfplan'), 'tfplan', 'out equals double-dash');
// Space form, single and double dash.
checkOut(extractOutFlagPath('-out tfplan'), 'tfplan', 'out space');
checkOut(extractOutFlagPath('--out tfplan'), 'tfplan', 'out space double-dash');
// A quoted path with spaces in the SPACE form is recognized (quotes stripped so
// the returned path matches what ToolRunner.line() passes to terraform).
checkOut(extractOutFlagPath('-out "my plan.tfplan"'), 'my plan.tfplan', 'out quoted space form');
// -out need not be the first token.
checkOut(extractOutFlagPath('-var-file=prod.tfvars -out=out/plan.tfplan'), 'out/plan.tfplan', 'out after other flags');
// No -out present at all.
checkOut(extractOutFlagPath('-refresh-only -no-color'), undefined, 'out absent');
// A lookalike flag (-timeout=) must NOT be treated as -out.
checkOut(extractOutFlagPath('-timeout=5m'), undefined, 'out lookalike not matched');
// A dangling -out with no following token yields undefined (no crash).
checkOut(extractOutFlagPath('-out'), undefined, 'out dangling');

// commandOptionsContainsJsonFlag (#492 follow-up): detect a standalone -json flag
// so plan()'s publishPlanResults path can fail closed rather than echo raw,
// unredacted NDJSON to the console.
checkBool(commandOptionsContainsJsonFlag(undefined), false, 'json undefined');
checkBool(commandOptionsContainsJsonFlag(''), false, 'json empty');
checkBool(commandOptionsContainsJsonFlag('-json'), true, 'json alone');
checkBool(commandOptionsContainsJsonFlag('--json'), true, 'json double-dash');
checkBool(commandOptionsContainsJsonFlag('-refresh-only -json -no-color'), true, 'json among other flags');
checkBool(commandOptionsContainsJsonFlag('-refresh-only -no-color'), false, 'json absent');
// Lookalikes must NOT be treated as the -json flag: a substring match would
// wrongly flag these.
checkBool(commandOptionsContainsJsonFlag('-var=myjsonvalue'), false, 'json lookalike substring in flag value');
checkBool(commandOptionsContainsJsonFlag('-var-file=json.tfvars'), false, 'json lookalike substring in path');
checkBool(commandOptionsContainsJsonFlag('"-json-ish"'), false, 'json lookalike token with suffix');

if (failed) {
    tl.setResult(tl.TaskResult.Failed, 'Command arg token parsing failed');
} else {
    tl.setResult(tl.TaskResult.Succeeded, 'CommandArgsL0 should have succeeded.');
}
