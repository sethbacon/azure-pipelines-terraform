import { describe, it } from 'mocha';
import assert = require('assert');
import * as fs from 'fs';
import * as path from 'path';
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

// Trust-root currency canary (#497a). The tests above only prove verifyGpgSignature
// correctly REJECTS a wrong-key signature -- none of them prove the embedded
// HashiCorp key can still verify a genuine, current release signature. This test
// replays a real terraform_1.15.8_SHA256SUMS + its real HashiCorp-issued .sig
// (fetched from releases.hashicorp.com on 2026-07-15) through the exact same
// verifyGpgSignature() used in production. If HashiCorp ever rotates or revokes the
// signing key embedded in hashicorp-gpg-key.ts, or the SHA256SUMS format changes in
// a way openpgp can no longer parse, this test starts failing -- that failure IS the
// signal to rotate/update hashicorp-gpg-key.ts, caught here instead of as a runtime
// break of every default HashiCorp-sourced install.
//
// No OS-level `gpg` binary is involved or required: verifyGpgSignature() verifies
// purely in-process via the `openpgp` npm package (no native/shell dependency), so
// this canary needs no skip/guard for agents without a system gpg install -- verified
// to pass unmodified on both ubuntu-latest and windows-2025 (the two CI runners in
// unit-test.yml's Build and Test Policy Agent Installer V1 matrix).
describe('gpg-verifier: HashiCorp trust-root canary (real embedded key)', function () {
    this.timeout(15000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch shared module
    const hc = httpClient as any;
    const origFetchBufferAllow404 = hc.fetchBufferAllow404;
    afterEach(() => { hc.fetchBufferAllow404 = origFetchBufferAllow404; });

    const FIXTURES_DIR = path.join(__dirname, 'fixtures');
    const SUMS_PATH = path.join(FIXTURES_DIR, 'terraform_1.15.8_SHA256SUMS');
    const SIG_PATH = path.join(FIXTURES_DIR, 'terraform_1.15.8_SHA256SUMS.sig');

    it('verifies a real, current HashiCorp-signed SHA256SUMS against the embedded public key', async () => {
        const sumsContent = fs.readFileSync(SUMS_PATH, 'utf8');
        const sigBytes = new Uint8Array(fs.readFileSync(SIG_PATH));

        hc.fetchBufferAllow404 = async () => sigBytes;

        // Must not throw. Confirmed independently with `gpg --verify` against this
        // exact fixture pair before committing (see PR description).
        await verifyGpgSignature(sumsContent, 'https://releases.hashicorp.com/terraform/1.15.8/terraform_1.15.8_SHA256SUMS.sig', true);
    });
});
