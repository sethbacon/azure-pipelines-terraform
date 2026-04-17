import tl = require('azure-pipelines-task-lib');
import { normalizePem } from '../../src/pem-normalizer';
import {
    TEST_OCI_PRIVATE_KEY_SPACES,
    TEST_OCI_PRIVATE_KEY_PEM,
    TEST_OCI_PRIVATE_KEY_CRLF,
} from '../test-oci-fixtures';

let passed = true;

function assertEqual(actual: string, expected: string, label: string): void {
    if (actual !== expected) {
        console.error(`FAIL [${label}]: expected\n${JSON.stringify(expected)}\nbut got\n${JSON.stringify(actual)}`);
        passed = false;
    } else {
        console.log(`PASS [${label}]`);
    }
}

function assertThrows(fn: () => void, expectedSubstring: string, label: string): void {
    try {
        fn();
        console.error(`FAIL [${label}]: expected error containing "${expectedSubstring}" but no error was thrown`);
        passed = false;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes(expectedSubstring)) {
            console.error(`FAIL [${label}]: expected error containing "${expectedSubstring}" but got: ${message}`);
            passed = false;
        } else {
            console.log(`PASS [${label}]`);
        }
    }
}

// --- Test: key with proper LF newlines (standard PEM) ---
const normalizedFromPem = normalizePem(TEST_OCI_PRIVATE_KEY_PEM);
assertEqual(normalizedFromPem, TEST_OCI_PRIVATE_KEY_PEM, 'PEM with LF newlines normalizes correctly');

// --- Test: key with spaces (ADO service connection format) ---
const normalizedFromSpaces = normalizePem(TEST_OCI_PRIVATE_KEY_SPACES);
assertEqual(normalizedFromSpaces, TEST_OCI_PRIVATE_KEY_PEM, 'PEM with spaces normalizes to standard PEM');

// --- Test: key with CRLF line endings ---
const normalizedFromCrlf = normalizePem(TEST_OCI_PRIVATE_KEY_CRLF);
assertEqual(normalizedFromCrlf, TEST_OCI_PRIVATE_KEY_PEM, 'PEM with CRLF normalizes to standard PEM');

// --- Test: missing header ---
assertThrows(
    () => normalizePem('MIGHAgEAMBMGByqG...'),
    'missing header or footer',
    'missing header/footer rejects'
);

// --- Test: empty body ---
assertThrows(
    () => normalizePem('-----BEGIN PRIVATE KEY----------END PRIVATE KEY-----'),
    'empty key body',
    'empty body rejects'
);

// --- Test: non-base64 characters ---
assertThrows(
    () => normalizePem('-----BEGIN PRIVATE KEY----- !!!invalid!!! -----END PRIVATE KEY-----'),
    'non-base64 characters',
    'non-base64 body rejects'
);

// --- Test: mismatched labels ---
assertThrows(
    () => normalizePem('-----BEGIN RSA PRIVATE KEY----- abc -----END PRIVATE KEY-----'),
    'does not match footer label',
    'mismatched labels rejects'
);

// --- Test: valid base64 but not a real key (crypto validation fails) ---
assertThrows(
    () => normalizePem('-----BEGIN PRIVATE KEY----- dGhpcyBpcyBub3QgYSBrZXk= -----END PRIVATE KEY-----'),
    'crypto validation failed',
    'invalid DER content rejects'
);

if (passed) {
    tl.setResult(tl.TaskResult.Succeeded, 'All PEM normalizer tests passed.');
} else {
    tl.setResult(tl.TaskResult.Failed, 'One or more PEM normalizer tests failed.');
}
