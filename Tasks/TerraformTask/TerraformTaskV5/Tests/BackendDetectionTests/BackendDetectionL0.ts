import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectBackend, detectBackendCloud, MAX_BACKEND_STATE_BYTES } from '../../src/backend-detection';

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

  const cloudMappings: Array<[string, 'azurerm' | 'aws' | 'gcp' | 'oci' | 'hcp']> = [
    ['azurerm', 'azurerm'],
    ['s3', 'aws'],
    ['gcs', 'gcp'],
    // Terraform's native OCI Object Storage backend (#1304). The OCI PAR mode's
    // backend is `http`, which stays undetected below.
    ['oci', 'oci'],
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

  // Class test (issues #884/#897): BACKEND_TYPE_TO_CLOUD is a Map, so a
  // backend.type equal to an Object.prototype member name must fall through
  // to the not-found (null) branch exactly like any other unrecognized
  // backend type, never resolving to an inherited member.
  const prototypePollutionKeys = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'];
  for (const backendType of prototypePollutionKeys) {
    it(`returns null for backend type '${backendType}' (an Object.prototype member, not a real backend)`, () => {
      const dir = makeWorkingDirectory();
      writeTfstate(dir, JSON.stringify({ backend: { type: backendType } }));
      assert.strictEqual(detectBackendCloud(dir), null);
    });
  }

  const noCredentialBackends = ['local', 'http', 'pg', 'consul', 'kubernetes', 'oss'];
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

/**
 * #1309: Terraform caches EVERY attribute of the backend's schema in
 * `.terraform/terraform.tfstate`, null when the configuration left it unset.
 * `s3-backend-cache.json` is the cache terraform 1.17.2 wrote for an s3 backend
 * initialized with only bucket/key/region and endpoint settings: 45 keys, 36
 * of them null, including every credential key. `configKeys` must name only
 * the settings init actually set, or every backend reads as bound to a
 * credential of its own.
 */
describe('detectBackend configKeys (#1309)', function () {
  const tmpDirs: string[] = [];

  function workingDirectoryWith(tfstate: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-config-keys-'));
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, '.terraform'));
    fs.writeFileSync(path.join(dir, '.terraform', 'terraform.tfstate'), JSON.stringify(tfstate));
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names only the settings a real terraform-written cache sets', () => {
    const cache = JSON.parse(fs.readFileSync(path.join(__dirname, 's3-backend-cache.json'), 'utf8'));
    const record = detectBackend(workingDirectoryWith(cache));
    assert.ok(record);
    assert.deepStrictEqual([...record!.configKeys].sort(), [
      'bucket', 'endpoints', 'key', 'region', 'skip_credentials_validation', 'skip_metadata_api_check',
      'skip_region_validation', 'skip_requesting_account_id', 'use_path_style',
    ]);
    for (const credential of ['access_key', 'secret_key', 'profile', 'assume_role', 'shared_credentials_files']) {
      assert.ok(credential in cache.backend.config, `fixture must carry ${credential}, as terraform writes it`);
      assert.ok(!record!.configKeys.has(credential), `${credential} is null in the cache and was not set at init`);
    }
  });

  it('treats false and an empty string as unset, since neither binds a credential', () => {
    const record = detectBackend(workingDirectoryWith({
      backend: { type: 'azurerm', config: { use_msi: false, client_id: '', use_oidc: true, key: 'k' } },
    }));
    assert.deepStrictEqual([...record!.configKeys].sort(), ['key', 'use_oidc']);
  });
});
