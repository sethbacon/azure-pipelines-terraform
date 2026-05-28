import tl = require('azure-pipelines-task-lib');
import { parseVarFileTokens, parseTargetTokens } from '../../src/base-terraform-command-handler';

let failed = false;

function check(actual: string[], expected: string[], label: string): void {
    const ok = actual.length === expected.length && actual.every((v, i) => v === expected[i]);
    if (!ok) {
        tl.error(`${label}: expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
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

if (failed) {
    tl.setResult(tl.TaskResult.Failed, 'Command arg token parsing failed');
} else {
    tl.setResult(tl.TaskResult.Succeeded, 'CommandArgsL0 should have succeeded.');
}
