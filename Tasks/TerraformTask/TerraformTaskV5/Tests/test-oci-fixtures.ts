/**
 * Shared OCI test fixtures.
 *
 * The EC P-256 key below is used ONLY in tests — it has zero access to any
 * real infrastructure.  It is stored in "spaces" format (how Azure DevOps
 * service connections deliver PEM keys) and in proper PEM format.
 */

/** PKCS#8 EC P-256 private key with spaces instead of newlines (ADO format). */
export const TEST_OCI_PRIVATE_KEY_SPACES =
    '-----BEGIN PRIVATE KEY----- MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgIwyERSFzQgCvXZNB OKG4XWPRXkZSEiTXPWIXcnbCciGhRANCAASwmlpLUCI6U52pVpbzAqXCbny9wTFc iKZ0WdIidDIdA3L8AHgObTZlkx28C42vNqt375Sm0ix77WI1ej2YUgwk -----END PRIVATE KEY-----';

/** Same key in proper PEM format (LF line endings, 64-char wrapped). */
export const TEST_OCI_PRIVATE_KEY_PEM =
    '-----BEGIN PRIVATE KEY-----\n' +
    'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgIwyERSFzQgCvXZNB\n' +
    'OKG4XWPRXkZSEiTXPWIXcnbCciGhRANCAASwmlpLUCI6U52pVpbzAqXCbny9wTFc\n' +
    'iKZ0WdIidDIdA3L8AHgObTZlkx28C42vNqt375Sm0ix77WI1ej2YUgwk\n' +
    '-----END PRIVATE KEY-----\n';

/** Same key with CRLF line endings. */
export const TEST_OCI_PRIVATE_KEY_CRLF =
    '-----BEGIN PRIVATE KEY-----\r\n' +
    'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgIwyERSFzQgCvXZNB\r\n' +
    'OKG4XWPRXkZSEiTXPWIXcnbCciGhRANCAASwmlpLUCI6U52pVpbzAqXCbny9wTFc\r\n' +
    'iKZ0WdIidDIdA3L8AHgObTZlkx28C42vNqt375Sm0ix77WI1ej2YUgwk\r\n' +
    '-----END PRIVATE KEY-----\r\n';
