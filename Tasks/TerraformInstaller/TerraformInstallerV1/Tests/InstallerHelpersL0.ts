import { describe, it } from 'mocha';
import assert = require('assert');
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
    parseSha256,
    verifySha256,
    getPlatformString,
    getArchString,
} from '../src/terraform-installer';

// Direct (parent-process) unit tests for the security-critical checksum-parsing,
// sha256-verification, and platform/architecture mapping helpers. These cover the
// switch arms and error paths that the integration MockTestRunner scenarios cannot
// reach (the CI runner is a single fixed os/arch).
//
// #636: every MockTestRunner integration scenario in L0.ts registers a `crypto`
// mock that returns a fixed digest, so the REAL cryptographic digest computation in
// verifySha256 was never exercised anywhere in this task's own suite — the sibling
// PolicyAgentInstallerV1/TerraformDocsInstallerV1 tasks already have this direct
// test, this task did not. The verifySha256 cases below write a real temp file,
// compute its real sha256 with real crypto, and assert both the pass and mismatch
// paths WITHOUT mocking crypto, porting the sibling pattern into this task.

describe('terraform-installer: checksum parsing & verification', () => {
    const HASH = 'a'.repeat(64);

    it('parseSha256 finds the digest for a named asset', () => {
        const sums = `${HASH}  terraform_1.9.8_linux_amd64.zip\n${'b'.repeat(64)}  terraform_1.9.8_linux_arm64.zip\n`;
        assert.strictEqual(parseSha256(sums, 'terraform_1.9.8_linux_amd64.zip'), HASH);
    });

    it('parseSha256 accepts the binary-mode "*" marker', () => {
        assert.strictEqual(parseSha256(`${HASH} *terraform_1.9.8_windows_amd64.zip`, 'terraform_1.9.8_windows_amd64.zip'), HASH);
    });

    it('parseSha256 throws when the asset is absent', () => {
        assert.throws(() => parseSha256(`${HASH}  some_other_file`, 'missing'), /SHA256 checksum not found for missing/);
    });

    it('verifySha256 passes when the file hash matches (real file, real crypto)', async () => {
        const tmp = path.join(os.tmpdir(), `tfi-verify-${crypto.randomUUID()}.bin`);
        fs.writeFileSync(tmp, 'the-archive-bytes');
        const expected = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
        try {
            await verifySha256(tmp, expected.toUpperCase()); // also exercises case-insensitive compare
        } finally {
            fs.unlinkSync(tmp);
        }
    });

    it('verifySha256 throws on a hash mismatch (real file, real crypto)', async () => {
        const tmp = path.join(os.tmpdir(), `tfi-verify-${crypto.randomUUID()}.bin`);
        fs.writeFileSync(tmp, 'the-archive-bytes');
        try {
            await assert.rejects(verifySha256(tmp, 'd'.repeat(64)), /Sha256VerificationFailed|verification/i);
        } finally {
            fs.unlinkSync(tmp);
        }
    });
});

describe('terraform-installer: platform & architecture mapping', () => {
    const origType = os.type;
    const origArch = os.arch;
    afterEach(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (os as any).type = origType;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (os as any).arch = origArch;
    });
    const setType = (v: string) => { (os as unknown as { type: () => string }).type = () => v; };
    const setArch = (v: string) => { (os as unknown as { arch: () => string }).arch = () => v; };

    it('getPlatformString maps the supported operating systems', () => {
        setType('Darwin'); assert.strictEqual(getPlatformString(), 'darwin');
        setType('Linux'); assert.strictEqual(getPlatformString(), 'linux');
        setType('Windows_NT'); assert.strictEqual(getPlatformString(), 'windows');
    });

    it('getPlatformString throws on an unsupported OS', () => {
        setType('SunOS');
        assert.throws(() => getPlatformString(), /OperatingSystemNotSupported|SunOS/);
    });

    it('getArchString maps the supported architectures', () => {
        setArch('x64'); assert.strictEqual(getArchString(), 'amd64');
        setArch('ia32'); assert.strictEqual(getArchString(), '386');
        setArch('arm64'); assert.strictEqual(getArchString(), 'arm64');
        setArch('arm'); assert.strictEqual(getArchString(), 'arm');
    });

    it('getArchString throws on an unsupported architecture', () => {
        setArch('mips');
        assert.throws(() => getArchString(), /ArchitectureNotSupported|mips/);
    });
});
