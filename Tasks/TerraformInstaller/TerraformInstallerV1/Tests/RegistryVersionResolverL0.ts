import { describe, it } from 'mocha';
import assert = require('assert');
import tasks = require('azure-pipelines-task-lib/task');
import { maskOperatorUrlCredentials, resolveVersionFromRegistry } from '../src/registry-version-resolver';

// Direct (non-MockTestRunner) unit tests for the shared registry-version-resolver
// module (#681) -- previously hand-duplicated with a matching body across all
// three installer tasks, now a single leaf module enforced by
// scripts/check-shared-modules.js. These run in the mocha parent process and
// stub the shared task-lib / fetch singletons in place.
describe('registry-version-resolver: maskOperatorUrlCredentials + resolveVersionFromRegistry (#681)', () => {
  let originalFetch: typeof globalThis.fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
  const t = tasks as any;
  const orig = {
    loc: t.loc,
    setSecret: t.setSecret,
  };
  let setSecretCalls: string[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    setSecretCalls = [];
    t.loc = (k: string, ...args: unknown[]) => `${k} ${args.join(' ')}`.trim();
    t.setSecret = (s: string) => { setSecretCalls.push(s); };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    t.loc = orig.loc;
    t.setSecret = orig.setSecret;
  });

  describe('maskOperatorUrlCredentials', () => {
    it('setSecret()s userinfo embedded in a registry URL', () => {
      maskOperatorUrlCredentials('https://user:p@ss@registry.example.com/path');
      assert.ok(setSecretCalls.length > 0, 'expected at least one setSecret call for the embedded credential');
      assert.ok(setSecretCalls.some((s) => s.includes('p@ss') || s.includes('p%40ss')), 'expected the password to be masked');
    });

    it('is a no-op for a URL with no embedded credentials', () => {
      maskOperatorUrlCredentials('https://registry.example.com/path');
      assert.deepStrictEqual(setSecretCalls, []);
    });
  });

  describe('resolveVersionFromRegistry', () => {
    it('resolves the version from the registry latest endpoint and masks any embedded credential', async () => {
      const requestedUrls: string[] = [];
      globalThis.fetch = (async (url: string) => {
        requestedUrls.push(url);
        return new Response(JSON.stringify({ version: '1.9.2' }), { status: 200 });
      }) as unknown as typeof globalThis.fetch;

      const version = await resolveVersionFromRegistry('https://user:s3cr3t@registry.example.com', 'terraform');

      assert.strictEqual(version, '1.9.2');
      assert.strictEqual(requestedUrls.length, 1);
      assert.strictEqual(requestedUrls[0], 'https://user:s3cr3t@registry.example.com/terraform/binaries/terraform/versions/latest');
      assert.ok(setSecretCalls.some((s) => s.includes('s3cr3t')), 'the embedded registry credential must be masked');
    });

    it('throws a clear error when the registry response omits the version field', async () => {
      globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof globalThis.fetch;

      await assert.rejects(
        resolveVersionFromRegistry('https://registry.example.com', 'terraform'),
        /missing version field/,
      );
    });

    it('throws a clear diagnostic on a syntactically-valid but non-object 2xx body instead of a raw TypeError (#790)', async () => {
      // fetchJson parses any valid JSON value (a bare null/number/string) and
      // casts it straight to T; without the shape guard, dereferencing
      // data.version on a null body would throw "Cannot read properties of
      // null" rather than this actionable message.
      globalThis.fetch = (async () => new Response('null', { status: 200 })) as unknown as typeof globalThis.fetch;

      await assert.rejects(
        resolveVersionFromRegistry('https://registry.example.com', 'terraform'),
        /non-object/,
      );
    });

    it('propagates a fetch failure (network error / non-2xx) rather than silently resolving', async () => {
      globalThis.fetch = (async () => new Response('server error', { status: 500 })) as unknown as typeof globalThis.fetch;

      await assert.rejects(resolveVersionFromRegistry('https://registry.example.com', 'terraform'));
    });
  });
});
