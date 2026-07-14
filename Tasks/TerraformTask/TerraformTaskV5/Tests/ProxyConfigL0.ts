import { describe, it, beforeEach, afterEach } from 'mocha';
import assert = require('assert');
import tasks = require('azure-pipelines-task-lib/task');
import { buildProxyFetchOptions } from '../src/proxy-config';

/**
 * Direct unit tests for buildProxyFetchOptions(), mirroring the equivalent
 * buildFetchOptions() tests in the installer tasks' shared http-client.ts
 * (Tasks/TerraformInstaller/TerraformInstallerV1/Tests/HttpClientL0.ts).
 * Self-hosted agents that require an HTTP proxy for outbound internet access
 * typically require it for ANY external HTTPS call, so the OIDC token
 * exchange and OCI Identity Domains calls need the same proxy awareness the
 * installer tasks already have.
 */
describe('buildProxyFetchOptions', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
  const t = tasks as any;
  const origProxy = t.getHttpProxyConfiguration;
  const origSetSecret = t.setSecret;

  beforeEach(() => {
    t.getHttpProxyConfiguration = origProxy;
    t.setSecret = origSetSecret;
  });
  afterEach(() => {
    t.getHttpProxyConfiguration = origProxy;
    t.setSecret = origSetSecret;
  });

  it('returns an empty object when no proxy is configured', () => {
    t.getHttpProxyConfiguration = () => undefined;
    assert.deepStrictEqual(buildProxyFetchOptions(), {});
  });

  it('attaches an undici ProxyAgent dispatcher when a proxy is configured', () => {
    t.getHttpProxyConfiguration = () => ({
      proxyUrl: 'http://proxy.example.com:8080',
      proxyUsername: '',
      proxyPassword: '',
    });
    const options = buildProxyFetchOptions();
    assert.ok('dispatcher' in options, 'proxy dispatcher should be set');
  });

  it('embeds credentials in the proxy URL and masks the password as a secret', () => {
    const setSecretCalls: string[] = [];
    t.setSecret = (v: string) => setSecretCalls.push(v);
    t.getHttpProxyConfiguration = () => ({
      proxyUrl: 'http://proxy.example.com:8080',
      proxyUsername: 'user',
      proxyPassword: 'p@ss',
    });
    const options = buildProxyFetchOptions();
    assert.ok('dispatcher' in options, 'proxy dispatcher should be set');
    assert.ok(setSecretCalls.includes('p@ss'), 'proxy password should be registered as a secret');
  });

  it('throws a clear error on a malformed proxy URL instead of an unhandled TypeError', () => {
    t.getHttpProxyConfiguration = () => ({
      proxyUrl: 'not a url',
      proxyUsername: 'user',
      proxyPassword: 'p@ss',
    });
    assert.throws(() => buildProxyFetchOptions(), /Invalid proxy URL/);
  });
});
