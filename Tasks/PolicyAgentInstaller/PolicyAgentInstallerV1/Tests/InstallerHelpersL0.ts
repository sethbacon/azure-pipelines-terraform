import { describe, it } from 'mocha';
import assert = require('assert');
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
    parseSha256,
    parseFirstSha256,
    verifySha256,
    getPlatformString,
    getArchString,
    getOpaAssetName,
} from '../src/policy-agent-installer';

// Direct (parent-process) unit tests for the security-critical checksum-parsing,
// sha256-verification, and platform/architecture mapping helpers. These cover the
// switch arms and error paths that the integration MockTestRunner scenarios cannot
// reach (the CI runner is a single fixed os/arch).

describe('policy-agent-installer: checksum parsing & verification', () => {
    const HASH = 'a'.repeat(64);

    it('parseSha256 finds the digest for a named file', () => {
        const sums = `${HASH}  opa_linux_amd64\n${'b'.repeat(64)}  opa_linux_arm64\n`;
        assert.strictEqual(parseSha256(sums, 'opa_linux_amd64'), HASH);
    });

    it('parseSha256 accepts the binary-mode "*" marker', () => {
        assert.strictEqual(parseSha256(`${HASH} *sentinel_0.40.0_linux_amd64.zip`, 'sentinel_0.40.0_linux_amd64.zip'), HASH);
    });

    it('parseSha256 throws when the file is absent', () => {
        assert.throws(() => parseSha256(`${HASH}  some_other_file`, 'missing'), /SHA256 checksum not found for missing/);
    });

    it('parseFirstSha256 extracts the first 64-hex digest', () => {
        assert.strictEqual(parseFirstSha256(`${HASH}  opa_linux_amd64`), HASH);
    });

    it('parseFirstSha256 throws on a body with no digest', () => {
        assert.throws(() => parseFirstSha256('not a checksum'), /SHA256 checksum not found/);
    });

    it('verifySha256 passes when the file hash matches', async () => {
        const tmp = path.join(os.tmpdir(), `pai-verify-${crypto.randomUUID()}.bin`);
        fs.writeFileSync(tmp, 'the-binary-bytes');
        const expected = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
        try {
            await verifySha256(tmp, expected.toUpperCase()); // also exercises case-insensitive compare
        } finally {
            fs.unlinkSync(tmp);
        }
    });

    it('verifySha256 throws on a hash mismatch', async () => {
        const tmp = path.join(os.tmpdir(), `pai-verify-${crypto.randomUUID()}.bin`);
        fs.writeFileSync(tmp, 'the-binary-bytes');
        try {
            await assert.rejects(verifySha256(tmp, 'd'.repeat(64)), /Sha256VerificationFailed|verification/i);
        } finally {
            fs.unlinkSync(tmp);
        }
    });
});

describe('policy-agent-installer: platform & architecture mapping', () => {
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

    it('getOpaAssetName builds the asset name for amd64 and arm64', () => {
        // The platform/arch portion comes from the monkeypatched os.type/os.arch,
        // but the .exe suffix is driven by the host (the source's isWindows constant),
        // which the test cannot override — so mirror it here.
        const exe = process.platform === 'win32' ? '.exe' : '';
        setType('Linux'); setArch('x64');
        assert.strictEqual(getOpaAssetName(), `opa_linux_amd64${exe}`);
        setArch('arm64');
        assert.strictEqual(getOpaAssetName(), `opa_linux_arm64${exe}`);
    });

    it('getOpaAssetName rejects architectures OPA does not publish', () => {
        setType('Linux'); setArch('arm');
        assert.throws(() => getOpaAssetName(), /ArchitectureNotSupported|amd64 and arm64/);
    });
});
