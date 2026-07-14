import tasks = require('azure-pipelines-task-lib/task');
import { ProxyAgent } from 'undici';

/**
 * Builds fetch() RequestInit options that route the request through the
 * agent's configured HTTP proxy (Agent.ProxyUrl / Agent.ProxyUsername /
 * Agent.ProxyPassword), if one is set. Mirrors the equivalent
 * buildFetchOptions() helper in the installer tasks' shared http-client.ts —
 * self-hosted agents that require a proxy for outbound internet access
 * typically require it for ANY external HTTPS call, including the OIDC
 * token-exchange and OCI Identity Domains calls this task makes via fetch().
 * Returns an empty object when no proxy is configured, so callers can always
 * spread the result into their own RequestInit unconditionally.
 */
export function buildProxyFetchOptions(): RequestInit {
  const proxy = tasks.getHttpProxyConfiguration();
  if (!proxy) return {};

  let proxyUrl = proxy.proxyUrl;
  if (proxy.proxyUsername) {
    if (proxy.proxyPassword) {
      tasks.setSecret(proxy.proxyPassword);
    }
    let url: URL;
    try {
      url = new URL(proxy.proxyUrl);
    } catch (err) {
      throw new Error(`Invalid proxy URL configured on the agent: ${err instanceof Error ? err.message : err}`);
    }
    url.username = proxy.proxyUsername;
    url.password = proxy.proxyPassword ?? "";
    proxyUrl = url.toString();
  }

  return {
    // @ts-expect-error Node.js fetch accepts undici dispatcher
    dispatcher: new ProxyAgent(proxyUrl),
  };
}
