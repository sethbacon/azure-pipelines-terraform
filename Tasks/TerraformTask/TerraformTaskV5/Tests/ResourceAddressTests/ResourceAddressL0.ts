import tl = require('azure-pipelines-task-lib');
import { RESOURCE_ADDRESS_RE } from '../../src/base-terraform-command-handler';

// Valid addresses
const validCases = [
    'aws_instance.foo',
    'module.bar',
    'module.bar.aws_instance.baz',
    'aws_instance.foo[0]',
    'aws_instance.foo["key"]',
    'module.bar[0].aws_instance.baz',
    'null_resource.test-name',
    'data.aws_ami.latest',
    '_private.resource',
];

// Invalid addresses
const invalidCases = [
    '',
    '0starts_with_digit',
    'has spaces',
    '../path/traversal',
    'has;semicolon',
];

let failed = false;

for (const addr of validCases) {
    if (!RESOURCE_ADDRESS_RE.test(addr)) {
        tl.error(`Expected '${addr}' to be valid but was rejected`);
        failed = true;
    }
}

for (const addr of invalidCases) {
    if (RESOURCE_ADDRESS_RE.test(addr)) {
        tl.error(`Expected '${addr}' to be invalid but was accepted`);
        failed = true;
    }
}

if (failed) {
    tl.setResult(tl.TaskResult.Failed, 'Resource address regex validation failed');
} else {
    tl.setResult(tl.TaskResult.Succeeded, 'ResourceAddressL0 should have succeeded.');
}
