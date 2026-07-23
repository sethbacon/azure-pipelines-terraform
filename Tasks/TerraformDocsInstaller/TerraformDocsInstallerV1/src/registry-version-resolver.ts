import tasks = require('azure-pipelines-task-lib/task');
import { fetchJson } from './http-client';
import { extractUrlUserInfoSecrets, redactUrlUserInfo } from './url-secret-redaction';

/**
 * setSecret() any basic-auth userinfo embedded in an operator-supplied
 * registry/mirror URL so the agent masks it everywhere the URL (or a URL derived
 * from it) might be echoed — pipeline variables, console output, error messages
 * (#586). Idempotent; call at the earliest use of each operator URL. Pair with
 * redactUrlUserInfo() to structurally strip the credential from any value stored
 * or displayed (setSecret only masks logs, not a persisted variable's value).
 *
 * Shared byte-identical copy across the 3 installer tasks (TerraformInstallerV1,
 * PolicyAgentInstallerV1, TerraformDocsInstallerV1) enforced by
 * scripts/check-shared-modules.js — previously hand-duplicated in each (#681).
 */
export function maskOperatorUrlCredentials(url: string): void {
  for (const secret of extractUrlUserInfoSecrets(url)) {
    tasks.setSecret(secret);
  }
}

/**
 * Resolves the 'latest' version of a tool from the private registry's
 * terraform/binaries/<mirrorName>/versions/latest endpoint. Callers must
 * already have confirmed the requested version is actually 'latest' before
 * calling this — each installer resolves that upfront so the check itself
 * isn't duplicated here.
 *
 * Shared byte-identical copy across the 3 installer tasks (TerraformInstallerV1,
 * PolicyAgentInstallerV1, TerraformDocsInstallerV1) enforced by
 * scripts/check-shared-modules.js — previously hand-duplicated with a matching
 * body in each, so a fix to the registry-latest error message or masking order
 * could land in one copy and be silently missed in the others (#681).
 */
export async function resolveVersionFromRegistry(registryUrl: string, mirrorName: string): Promise<string> {
  maskOperatorUrlCredentials(registryUrl);
  console.log(tasks.loc("ResolvingLatestFromRegistry", redactUrlUserInfo(registryUrl)));
  const latestUrl = `${registryUrl}/terraform/binaries/${mirrorName}/versions/latest`;
  const data = await fetchJson<{ version: string }>(latestUrl);
  // fetchJson() guards against a non-JSON body, but casts a successfully-parsed
  // value straight to T with no shape check -- a syntactically valid but
  // unexpected 2xx body (a bare null, number, or string) would otherwise make
  // the data.version dereference below throw a raw, undiagnosed TypeError
  // instead of this clear, actionable message (#790).
  if (typeof data !== 'object' || data === null) {
    throw new Error(`Registry API returned an unexpected (non-object) response from ${latestUrl}`);
  }
  if (!data.version) {
    throw new Error(`Registry API returned invalid response: missing version field from ${latestUrl}`);
  }
  console.log(tasks.loc("ResolvedVersionFromRegistry", data.version));
  return data.version;
}
