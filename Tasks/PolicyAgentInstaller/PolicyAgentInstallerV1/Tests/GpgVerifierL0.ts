import { describe, it } from 'mocha';
import assert = require('assert');
import * as openpgp from 'openpgp';
import tasks = require('azure-pipelines-task-lib/task');
import * as httpClient from '../src/http-client';
import { verifyGpgSignature } from '../src/gpg-verifier';

// Direct (parent-process) unit tests for the GPG signature gate. These use the
// REAL openpgp/crypto (the MockTestRunner integration scenarios stub openpgp away,
// so the verification logic itself is only exercised here). fetchBufferAllow404 is
// stubbed so no network is touched. The happy path requires HashiCorp's private key
// and is therefore unreachable; the security-relevant behaviour — rejecting a
// wrong-key signature, honouring the required/optional toggle, and distinguishing a
// genuine 404 (absent) from a transient failure — is what we assert.

describe('gpg-verifier: SHA256SUMS signature gate', function () {
    this.timeout(15000); // key generation can be slow on cold CI runners

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch shared modules
    const t = tasks as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hc = httpClient as any;
    const origWarning = t.warning;
    const origFetchBufferAllow404 = hc.fetchBufferAllow404;
    let warnings: string[] = [];

    beforeEach(() => { warnings = []; t.warning = (m: string) => warnings.push(m); });
    afterEach(() => { t.warning = origWarning; hc.fetchBufferAllow404 = origFetchBufferAllow404; });

    const SUMS = `${'a'.repeat(64)}  opa_linux_amd64\n`;
    const SIG_URL = 'https://releases.example.com/SHA256SUMS.sig';

    it('throws when the signature is genuinely absent (404) and verification is required', async () => {
        hc.fetchBufferAllow404 = async () => null;
        await assert.rejects(verifyGpgSignature(SUMS, SIG_URL, true), /signature verification is required/);
    });

    it('warns and proceeds when the signature is genuinely absent (404) and not required', async () => {
        hc.fetchBufferAllow404 = async () => null;
        await verifyGpgSignature(SUMS, SIG_URL, false);
        assert.ok(warnings.some(w => /without signature verification/i.test(w)), 'should warn about skipping verification');
    });

    it('propagates a transient fetch error fatally even when not required (does not conflate with a genuine 404)', async () => {
        hc.fetchBufferAllow404 = async () => { throw new Error('HTTP 503'); };
        await assert.rejects(verifyGpgSignature(SUMS, SIG_URL, false), /HTTP 503/);
    });

    it('rejects a signature made by a key other than HashiCorp\'s', async () => {
        const { privateKey } = await openpgp.generateKey({
            userIDs: [{ name: 'Imposter', email: 'imposter@example.com' }],
        });
        const signingKey = await openpgp.readPrivateKey({ armoredKey: privateKey });
        const message = await openpgp.createMessage({ text: SUMS });
        const detached = await openpgp.sign({ message, signingKeys: signingKey, detached: true, format: 'binary' });
        const sigBytes = detached as Uint8Array;

        hc.fetchBufferAllow404 = async () => sigBytes;
        await assert.rejects(verifyGpgSignature(SUMS, SIG_URL, true), /GPG signature verification failed/);
    });
});
