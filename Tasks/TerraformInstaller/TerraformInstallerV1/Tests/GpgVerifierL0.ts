import { describe, it } from 'mocha';
import assert = require('assert');
import * as fs from 'fs';
import * as path from 'path';
import * as openpgp from 'openpgp';
import tasks = require('azure-pipelines-task-lib/task');
import * as httpClient from '../src/http-client';
import { verifyGpgSignature } from '../src/gpg-verifier';
import { HASHICORP_GPG_PUBLIC_KEY } from '../src/hashicorp-gpg-key';
import { OPENTOFU_GPG_PUBLIC_KEY } from '../src/opentofu-gpg-key';
import { isVerificationFailure } from '@4cloudguru/pipeline-task-core';

// Direct (parent-process) unit tests for the GPG signature gate. These use the
// REAL openpgp/crypto (the MockTestRunner integration scenarios stub openpgp away,
// so the verification logic itself is only exercised here). fetchBufferAllow404 is
// stubbed so no network is touched. The happy path requires HashiCorp's private key
// and is therefore unreachable; the security-relevant behaviour — rejecting a
// wrong-key signature, honouring the required/optional toggle, and distinguishing a
// genuine 404 (absent) from a transient failure — is what we assert.
//
// Ported from the byte-identical sibling PolicyAgentInstallerV1/Tests/GpgVerifierL0.ts
// (#497): because gpg-verifier.ts is byte-identical family code (parity enforced by
// scripts/check-shared-modules.js), this task's OWN CI job must independently prove
// its copy of the crypto path still verifies real signatures, rather than depending
// on a sibling task's suite for that guarantee.

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

    const SUMS = `${'a'.repeat(64)}  terraform_1.9.8_linux_amd64.zip\n`;
    const SIG_URL = 'https://releases.example.com/SHA256SUMS.sig';

    it('throws a typed VerificationFailure when the signature is genuinely absent (404) and required (#589)', async () => {
        hc.fetchBufferAllow404 = async () => null;
        // A reachable source withholding a required signature is a policy failure, so
        // the cache-hit re-verification path re-throws it (fail closed) rather than
        // degrading to the cached tool the way a transport outage does.
        await assert.rejects(verifyGpgSignature(SUMS, SIG_URL, true), (err: unknown) => {
            assert.ok(isVerificationFailure(err), 'a required-but-withheld signature must be a VerificationFailure');
            assert.match((err as Error).message, /signature verification is required/);
            return true;
        });
    });

    it('warns and proceeds when the signature is genuinely absent (404) and not required', async () => {
        hc.fetchBufferAllow404 = async () => null;
        await verifyGpgSignature(SUMS, SIG_URL, false);
        assert.ok(warnings.some(w => /without signature verification/i.test(w)), 'should warn about skipping verification');
    });

    it('propagates a transient fetch error fatally even when not required (does not conflate with a genuine 404)', async () => {
        hc.fetchBufferAllow404 = async () => { throw new Error('HTTP 503'); };
        await assert.rejects(verifyGpgSignature(SUMS, SIG_URL, false), (err: unknown) => {
            // A transport outage is NOT a VerificationFailure — the reverify path must
            // still be able to degrade gracefully on it.
            assert.ok(!isVerificationFailure(err), 'a transient fetch error must not be a VerificationFailure');
            assert.match((err as Error).message, /HTTP 503/);
            return true;
        });
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
        await assert.rejects(verifyGpgSignature(SUMS, SIG_URL, true), (err: unknown) => {
            assert.ok(isVerificationFailure(err), 'a wrong-key signature must be a VerificationFailure');
            assert.match((err as Error).message, /GPG signature verification failed/);
            return true;
        });
    });
});

// Trust-root currency canary (#497). The tests above only prove verifyGpgSignature
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
// this canary needs no skip/guard for agents without a system gpg install. The
// fixtures are byte-identical to the sibling PolicyAgentInstallerV1 copy (the two
// tasks share gpg-verifier.ts and hashicorp-gpg-key.ts as byte-identical family
// code), so the same .sig verifies against the same embedded key.
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

// Self-signature generations: the class behind the canary above staying green
// while every older release failed. OpenPGP asks whether a key was valid when a
// signature was MADE, and the answer comes from the self-signature the key carried
// at that time. HashiCorp re-certified this key on 2026-02-18 and now publishes it
// with the new self-signature only. Embedding that publication on its own rejected
// every release signed earlier ("Could not find valid self-signature in key
// 34365d9472d7468f: Signature creation time is in the future"), so a pipeline
// pinned to an older release -- terraform 1.5.7, say -- could not install it.
//
// One row per generation. Each replays a real SHA256SUMS and its real detached
// signature, as served by releases.hashicorp.com, through the production
// verifyGpgSignature() and the real embedded key. A row that starts failing after
// the key is updated means its generation was dropped: a new publication is ADDED
// to hashicorp-gpg-key.ts, never pasted over it (its header says how, and why the
// obvious tools lose a generation).
describe('gpg-verifier: embedded key verifies releases from every self-signature generation', function () {
    this.timeout(15000);

    const RECERTIFIED = Date.parse('2026-02-18T00:00:00Z');
    const GENERATIONS: { release: string; selfSignature: string; signedBeforeRecertification: boolean }[] = [
        { release: '1.5.7', selfSignature: '2021-04-19', signedBeforeRecertification: true },
        { release: '1.15.8', selfSignature: '2026-02-18', signedBeforeRecertification: false },
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch shared module
    const hc = httpClient as any;
    const origFetchBufferAllow404 = hc.fetchBufferAllow404;
    afterEach(() => { hc.fetchBufferAllow404 = origFetchBufferAllow404; });

    for (const row of GENERATIONS) {
        const name = `terraform_${row.release}_SHA256SUMS`;
        const sigUrl = `https://releases.hashicorp.com/terraform/${row.release}/${name}.sig`;
        const read = () => ({
            sumsContent: fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'),
            sigBytes: new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.sig`))),
        });

        it(`terraform ${row.release} is signed under the ${row.selfSignature} self-signature`, async () => {
            // Without this the row could name a generation its fixture does not
            // belong to, and keep passing while that generation went untested.
            const { packets } = await openpgp.readSignature({ binarySignature: read().sigBytes });
            const created = packets[0].created as Date;
            assert.strictEqual(created.getTime() < RECERTIFIED, row.signedBeforeRecertification, `signed ${created.toISOString()}`);
        });

        it(`verifies the real terraform ${row.release} SHA256SUMS`, async () => {
            const { sumsContent, sigBytes } = read();
            hc.fetchBufferAllow404 = async () => sigBytes;
            await verifyGpgSignature(sumsContent, sigUrl, true);
        });

        it(`still rejects terraform ${row.release} SHA256SUMS with one checksum altered`, async () => {
            const { sumsContent, sigBytes } = read();
            hc.fetchBufferAllow404 = async () => sigBytes;
            const altered = (sumsContent[0] === '0' ? '1' : '0') + sumsContent.slice(1);
            await assert.rejects(verifyGpgSignature(altered, sigUrl, true), /GPG signature verification failed/);
        });
    }
});

// Fingerprint pin (#652). The trust-root canary above proves the embedded key can
// still verify a genuine HashiCorp signature; the CI byte-identity check
// (scripts/check-shared-modules.js) proves the three bundled copies match EACH
// OTHER — but neither proves the embedded key is the specific, documented HashiCorp
// identity rather than some other well-formed OpenPGP key a coordinated edit to all
// copies could substitute. This computes the primary key's fingerprint/key-ID from
// the embedded armored block with openpgp and pins them to the documented values
// (hashicorp-gpg-key.ts's header: Key ID 34365D9472D7468F), so any key swap fails
// CI independently of the copy-equality check.
describe('hashicorp-gpg-key: embedded key is pinned to the documented HashiCorp fingerprint (#652)', function () {
    this.timeout(15000);

    it('the embedded key primary fingerprint / key-ID equal HashiCorp Security\'s known identity', async () => {
        const key = await openpgp.readKey({ armoredKey: HASHICORP_GPG_PUBLIC_KEY });
        // Full 40-hex primary fingerprint of HashiCorp Security (security@hashicorp.com);
        // its low 16 hex are the documented Key ID 34365D9472D7468F.
        assert.strictEqual(key.getFingerprint(), 'c874011f0ab405110d02105534365d9472d7468f');
        assert.strictEqual(key.getKeyID().toHex(), '34365d9472d7468f');
    });
});

// OpenTofu trust root. downloadSource=registry installs OpenTofu from a registry that
// advertises the detached `.gpgsig` OpenTofu publishes beside every
// tofu_<version>_SHA256SUMS, and the installer verifies it under OpenTofu's own release key
// (src/opentofu-gpg-key.ts). The registry's own ingest-time check is NOT the trust anchor --
// a compromised registry could serve anything -- so this is the verification that matters.
// Same shape as the HashiCorp canary above: replay REAL signed releases through the production
// verifyGpgSignature() with the real embedded key, so a rotation of the OpenTofu release key,
// or a change in how its SHA256SUMS is signed, fails here instead of at install time.
//
// Two releases bracket the signed history: 1.6.0 (the first stable release) and 1.13.1
// (current when the fixtures were fetched, 2026-10-06). Both come straight from the
// opentofu/opentofu GitHub releases.
describe('gpg-verifier: OpenTofu trust-root canary (real embedded key)', function () {
    this.timeout(15000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch shared module
    const hc = httpClient as any;
    const origFetchBufferAllow404 = hc.fetchBufferAllow404;
    afterEach(() => { hc.fetchBufferAllow404 = origFetchBufferAllow404; });

    const RELEASES = ['1.6.0', '1.13.1'];
    const readTofu = (release: string) => {
        const name = `tofu_${release}_SHA256SUMS`;
        return {
            sumsContent: fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'),
            sigBytes: new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.gpgsig`))),
            sigUrl: `https://github.com/opentofu/opentofu/releases/download/v${release}/${name}.gpgsig`,
        };
    };
    const readTerraform = () => {
        const name = 'terraform_1.15.8_SHA256SUMS';
        return {
            sumsContent: fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'),
            sigBytes: new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.sig`))),
            sigUrl: `https://releases.hashicorp.com/terraform/1.15.8/${name}.sig`,
        };
    };

    for (const release of RELEASES) {
        it(`verifies the real tofu ${release} SHA256SUMS against the embedded OpenTofu key`, async () => {
            const { sumsContent, sigBytes, sigUrl } = readTofu(release);
            hc.fetchBufferAllow404 = async () => sigBytes;
            assert.strictEqual(await verifyGpgSignature(sumsContent, sigUrl, true, OPENTOFU_GPG_PUBLIC_KEY), true);
        });

        it(`rejects tofu ${release} SHA256SUMS with one checksum altered`, async () => {
            const { sumsContent, sigBytes, sigUrl } = readTofu(release);
            hc.fetchBufferAllow404 = async () => sigBytes;
            const altered = (sumsContent[0] === '0' ? '1' : '0') + sumsContent.slice(1);
            await assert.rejects(
                verifyGpgSignature(altered, sigUrl, true, OPENTOFU_GPG_PUBLIC_KEY),
                (err: unknown) => {
                    assert.ok(isVerificationFailure(err), 'a tampered SHA256SUMS must be a VerificationFailure');
                    assert.match((err as Error).message, /GPG signature verification failed/);
                    return true;
                },
            );
        });

        // The cross-key guard. Without the explicit key argument verifyGpgSignature falls
        // back to HashiCorp's key, so an OpenTofu install that forgot to pass its own key
        // would fail every verification -- and, worse, a Terraform install could be handed
        // OpenTofu's signed material and have it accepted if the keys were ever merged
        // into one trust set.
        it(`rejects the real tofu ${release} signature under HashiCorp's key (the default)`, async () => {
            const { sumsContent, sigBytes, sigUrl } = readTofu(release);
            hc.fetchBufferAllow404 = async () => sigBytes;
            await assert.rejects(verifyGpgSignature(sumsContent, sigUrl, true), /GPG signature verification failed/);
            await assert.rejects(verifyGpgSignature(sumsContent, sigUrl, true, HASHICORP_GPG_PUBLIC_KEY), /GPG signature verification failed/);
        });
    }

    it('rejects the real HashiCorp terraform 1.15.8 signature under the OpenTofu key', async () => {
        const { sumsContent, sigBytes, sigUrl } = readTerraform();
        hc.fetchBufferAllow404 = async () => sigBytes;
        await assert.rejects(
            verifyGpgSignature(sumsContent, sigUrl, true, OPENTOFU_GPG_PUBLIC_KEY),
            (err: unknown) => {
                assert.ok(isVerificationFailure(err), 'a signature by a different trusted publisher must be a VerificationFailure');
                assert.match((err as Error).message, /GPG signature verification failed/);
                return true;
            },
        );
        // ...while the same pair still verifies under the key it belongs to, so the
        // rejection above is about the key and not a broken fixture.
        assert.strictEqual(await verifyGpgSignature(sumsContent, sigUrl, true, HASHICORP_GPG_PUBLIC_KEY), true);
    });

    it('verifies against the key it is given, and only that key', async () => {
        const { privateKey, publicKey } = await openpgp.generateKey({
            userIDs: [{ name: 'Other Publisher', email: 'publisher@example.com' }],
        });
        const sums = `${'b'.repeat(64)}  tofu_9.9.9_linux_amd64.zip\n`;
        const message = await openpgp.createMessage({ text: sums });
        const detached = await openpgp.sign({
            message,
            signingKeys: await openpgp.readPrivateKey({ armoredKey: privateKey }),
            detached: true,
            format: 'binary',
        });
        hc.fetchBufferAllow404 = async () => detached as Uint8Array;
        const url = 'https://registry.example.com/storage/9.9.9/SHA256SUMS.opentofu.sig';

        assert.strictEqual(await verifyGpgSignature(sums, url, true, publicKey), true);
        await assert.rejects(verifyGpgSignature(sums, url, true, OPENTOFU_GPG_PUBLIC_KEY), /GPG signature verification failed/);
        await assert.rejects(verifyGpgSignature(sums, url, true), /GPG signature verification failed/);
    });
});

// Fingerprint pin, as for HashiCorp above (#652): the canary proves the embedded key still
// verifies genuine OpenTofu releases, but not that it is the documented OpenTofu identity
// rather than some other well-formed key a coordinated edit could substitute. The key is the
// one OpenTofu publishes at https://get.opentofu.org/opentofu.asc (src/opentofu-gpg-key.ts
// says how it was checked), so any key swap fails CI independently of the canary.
describe('opentofu-gpg-key: embedded key is pinned to the documented OpenTofu fingerprint', function () {
    this.timeout(15000);

    it('the embedded key primary fingerprint / key-ID equal OpenTofu\'s release-signing identity', async () => {
        const key = await openpgp.readKey({ armoredKey: OPENTOFU_GPG_PUBLIC_KEY });
        // Full 40-hex primary fingerprint; its low 16 hex are the Key ID 0C0AF313E5FD9F80.
        assert.strictEqual(key.getFingerprint(), 'e3e6e43d84cb852eadb0051d0c0af313e5fd9f80');
        assert.strictEqual(key.getKeyID().toHex(), '0c0af313e5fd9f80');
        assert.ok(
            key.getUserIDs().some(id => id.includes('core@opentofu.org')),
            `unexpected identity: ${key.getUserIDs().join(' | ')}`,
        );
    });

    it('is a different key from HashiCorp\'s, so neither publisher can vouch for the other', async () => {
        const tofu = await openpgp.readKey({ armoredKey: OPENTOFU_GPG_PUBLIC_KEY });
        const hashicorp = await openpgp.readKey({ armoredKey: HASHICORP_GPG_PUBLIC_KEY });
        assert.notStrictEqual(tofu.getFingerprint(), hashicorp.getFingerprint());
    });
});
