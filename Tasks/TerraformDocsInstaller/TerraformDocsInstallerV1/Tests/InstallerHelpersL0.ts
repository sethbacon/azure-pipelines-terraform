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
  getArchiveExtension,
  getAssetName,
} from '../src/terraform-docs-installer';

// Direct (parent-process) unit tests for the security-critical checksum-parsing,
// sha256-verification, and platform/architecture mapping helpers. These cover the
// switch arms and error paths that the integration MockTestRunner scenarios cannot
// reach (the CI runner is a single fixed os/arch).

describe('terraform-docs-installer: checksum parsing & verification', () => {
  const HASH = 'a'.repeat(64);

  it('parseSha256 finds the digest for a named asset', () => {
    const sums = `${HASH}  terraform-docs-v0.24.0-linux-amd64.tar.gz\n${'b'.repeat(64)}  terraform-docs-v0.24.0-linux-arm64.tar.gz\n`;
    assert.strictEqual(parseSha256(sums, 'terraform-docs-v0.24.0-linux-amd64.tar.gz'), HASH);
  });

  it('parseSha256 accepts the binary-mode "*" marker', () => {
    assert.strictEqual(parseSha256(`${HASH} *terraform-docs-v0.24.0-windows-amd64.zip`, 'terraform-docs-v0.24.0-windows-amd64.zip'), HASH);
  });

  it('parseSha256 throws when the asset is absent', () => {
    assert.throws(() => parseSha256(`${HASH}  some_other_file`, 'missing'), /SHA256 checksum not found for missing/);
  });

  it('verifySha256 passes when the file hash matches', async () => {
    const tmp = path.join(os.tmpdir(), `tdi-verify-${crypto.randomUUID()}.bin`);
    fs.writeFileSync(tmp, 'the-archive-bytes');
    const expected = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
    try {
      await verifySha256(tmp, expected.toUpperCase()); // also exercises case-insensitive compare
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('verifySha256 throws on a hash mismatch', async () => {
    const tmp = path.join(os.tmpdir(), `tdi-verify-${crypto.randomUUID()}.bin`);
    fs.writeFileSync(tmp, 'the-archive-bytes');
    try {
      await assert.rejects(verifySha256(tmp, 'd'.repeat(64)), /Sha256VerificationFailed|verification/i);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

describe('terraform-docs-installer: platform & architecture mapping', () => {
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
    setArch('arm64'); assert.strictEqual(getArchString(), 'arm64');
    setArch('arm'); assert.strictEqual(getArchString(), 'arm');
  });

  it('getArchString throws on an unsupported architecture (terraform-docs ships no 386)', () => {
    setArch('ia32');
    assert.throws(() => getArchString(), /ArchitectureNotSupported|ia32/);
  });

  it('getAssetName builds the release asset file name for the current platform/architecture', () => {
    // The platform/arch portion comes from the monkeypatched os.type/os.arch,
    // but the archive extension is driven by the host (the source's isWindows
    // constant), which the test cannot override — so mirror it here.
    const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
    setType('Linux'); setArch('x64');
    assert.strictEqual(getAssetName('0.24.0'), `terraform-docs-v0.24.0-linux-amd64.${ext}`);
    setArch('arm64');
    assert.strictEqual(getAssetName('0.24.0'), `terraform-docs-v0.24.0-linux-arm64.${ext}`);
  });

  it('getArchiveExtension reflects the host operating system', () => {
    const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
    assert.strictEqual(getArchiveExtension(), ext);
  });
});
