import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectBackendCloud, MAX_BACKEND_STATE_BYTES } from '../../src/backend-detection';

/**
 * Direct unit tests for cross-cloud backend detection. `detectBackendCloud`
 * reads the real `.terraform/terraform.tfstate` file Terraform writes at
 * `init` time — this is the ground truth for which backend a state-accessing
 * command (plan/apply/...) will actually use, independent of the task's
 * `provider`/`backendType` inputs.
 */
describe('detectBackendCloud', function () {
  const tmpDirs: string[] = [];

  function makeWorkingDirectory(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-detect-'));
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, '.terraform'));
    return dir;
  }

  function writeTfstate(dir: string, content: string): void {
    fs.writeFileSync(path.join(dir, '.terraform', 'terraform.tfstate'), content);
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const cloudMappings: Array<[string, 'azurerm' | 'aws' | 'gcp' | 'hcp']> = [
    ['azurerm', 'azurerm'],
    ['s3', 'aws'],
    ['gcs', 'gcp'],
    ['cloud', 'hcp'],
    ['remote', 'hcp'],
  ];

  for (const [backendType, expectedCloud] of cloudMappings) {
    it(`maps backend type '${backendType}' to cloud '${expectedCloud}'`, () => {
      const dir = makeWorkingDirectory();
      writeTfstate(dir, JSON.stringify({ backend: { type: backendType } }));
      assert.strictEqual(detectBackendCloud(dir), expectedCloud);
    });
  }

  const noCredentialBackends = ['local', 'http', 'oci', 'pg', 'consul', 'kubernetes', 'oss'];
  for (const backendType of noCredentialBackends) {
    it(`returns null for backend type '${backendType}' (no cloud credentials to inject)`, () => {
      const dir = makeWorkingDirectory();
      writeTfstate(dir, JSON.stringify({ backend: { type: backendType } }));
      assert.strictEqual(detectBackendCloud(dir), null);
    });
  }

  it('returns null when .terraform/terraform.tfstate has no backend.type', () => {
    const dir = makeWorkingDirectory();
    writeTfstate(dir, JSON.stringify({}));
    assert.strictEqual(detectBackendCloud(dir), null);
  });

  it('returns null when .terraform/terraform.tfstate does not exist (not yet initialized)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-detect-'));
    tmpDirs.push(dir);
    assert.strictEqual(detectBackendCloud(dir), null);
  });

  it('returns null when the .terraform directory itself does not exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-detect-'));
    tmpDirs.push(dir);
    assert.strictEqual(detectBackendCloud(dir), null);
  });

  it('returns null when terraform.tfstate is malformed JSON', () => {
    const dir = makeWorkingDirectory();
    writeTfstate(dir, '{ this is not valid json');
    assert.strictEqual(detectBackendCloud(dir), null);
  });

  it('returns null and does not attempt to parse a terraform.tfstate larger than the size guard', () => {
    const dir = makeWorkingDirectory();
    const huge = Buffer.alloc(MAX_BACKEND_STATE_BYTES + 1, 'a');
    fs.writeFileSync(path.join(dir, '.terraform', 'terraform.tfstate'), huge);
    assert.strictEqual(detectBackendCloud(dir), null);
  });

  it('defaults to the current directory when workingDirectory is empty', () => {
    // Should not throw even if '.'/.terraform doesn't contain a tfstate.
    assert.doesNotThrow(() => detectBackendCloud(''));
  });
});
