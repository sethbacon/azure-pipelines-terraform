/**
 * Shared GCP test fixtures.
 *
 * The EC P-256 key below is used ONLY in tests — it has zero access to any
 * real infrastructure. It is stored in "spaces" format (how Azure DevOps
 * service connections deliver PEM keys) so tests exercise normalizePem's
 * real parsing/re-wrapping path, matching test-oci-fixtures.ts's pattern.
 */

/** PKCS#8 EC P-256 private key with spaces instead of newlines (ADO format). */
export const TEST_GCP_PRIVATE_KEY_SPACES =
    '-----BEGIN PRIVATE KEY----- MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgAsTcK0hjp14AQ2R/ ydQ/xaW4sw7LUoZf9aH18iqkwOuhRANCAAThCrUbXtVpePEkWziaFVt3zrxq+esh iOkuCq5fQ/DCaunhtz7/EMOdUNInRWRl5Qq+cjbu1yeM6IjkrifPTKLS -----END PRIVATE KEY-----';

/** Same key in proper PEM format (LF line endings, 64-char wrapped). */
export const TEST_GCP_PRIVATE_KEY_PEM =
    '-----BEGIN PRIVATE KEY-----\n' +
    'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgAsTcK0hjp14AQ2R/\n' +
    'ydQ/xaW4sw7LUoZf9aH18iqkwOuhRANCAAThCrUbXtVpePEkWziaFVt3zrxq+esh\n' +
    'iOkuCq5fQ/DCaunhtz7/EMOdUNInRWRl5Qq+cjbu1yeM6IjkrifPTKLS\n' +
    '-----END PRIVATE KEY-----\n';
