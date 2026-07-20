import fs = require('fs');
import path = require('path');
import tasks = require('azure-pipelines-task-lib/task');

/** Cloud whose credentials a managed Terraform state backend needs. */
export type BackendCloud = 'azurerm' | 'aws' | 'gcp' | 'hcp';

/**
 * Upper bound on the `.terraform/terraform.tfstate` file we'll read for
 * backend detection. A real Terraform/OpenTofu-written backend record is a
 * few KB; this guards against an unbounded read (and JSON.parse) of a
 * pathological or corrupted file causing excessive memory use or a hang.
 */
export const MAX_BACKEND_STATE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Maps a Terraform `backend.type` (as recorded in `.terraform/terraform.tfstate`
 * by `terraform init`) to the cloud whose credentials that backend needs.
 * Backends with no cloud identity to inject (local, generic http/pg/consul/
 * kubernetes, oci's PAR-based http backend, ...) are intentionally absent —
 * `detectBackendCloud` returns null for them.
 */
const BACKEND_TYPE_TO_CLOUD: Readonly<Record<string, BackendCloud>> = {
  azurerm: 'azurerm',
  s3: 'aws',
  gcs: 'gcp',
  cloud: 'hcp',
  remote: 'hcp',
};

/**
 * Detects which cloud's credentials the *state backend* needs, by reading the
 * backend type Terraform recorded at `terraform init` time from
 * `<workingDirectory>/.terraform/terraform.tfstate`. This is the ground truth
 * for the backend actually in use — independent of this task's `provider` or
 * `backendType` inputs (the latter's `azurerm` default would otherwise be
 * indistinguishable from an explicit value on a step that omits it) — and is
 * what lets a state-accessing command (plan/apply/...) decide whether it must
 * inject a *different* cloud's backend credentials than the ones the
 * `provider` input already supplies.
 *
 * Returns `null` (no managed-cloud credentials to inject) when:
 *  - `.terraform/terraform.tfstate` does not exist, is not a regular file, is
 *    larger than {@link MAX_BACKEND_STATE_BYTES}, or fails to parse as JSON
 *    (e.g. the working directory has not been initialized yet).
 *  - the recorded `backend.type` is missing, or is not one of the backends
 *    that require injected cloud credentials.
 *
 * Only the `backend.type` string is ever read; `backend.config` — which may
 * hold cached, non-secret backend settings — is intentionally never inspected
 * or logged. Never throws: callers should let Terraform surface its own error
 * (e.g. "not initialized") when something is genuinely wrong.
 */
export function detectBackendCloud(workingDirectory: string): BackendCloud | null {
  const tfstatePath = path.join(workingDirectory || '.', '.terraform', 'terraform.tfstate');

  // Opened once and stat/read via that same descriptor (not a statSync/
  // readFileSync pair on the path) so there is no window between the
  // is-a-file/size check and the read where the path could be repointed at a
  // different, larger file (TOCTOU / CWE-367).
  let fd: number;
  try {
    fd = fs.openSync(tfstatePath, 'r');
  } catch {
    tasks.debug(`Backend detection: no ${tfstatePath} found (not yet initialized?); skipping cross-cloud backend credential injection.`);
    return null;
  }

  let raw: string;
  try {
    const stats = fs.fstatSync(fd);

    if (!stats.isFile()) {
      tasks.debug(`Backend detection: ${tfstatePath} is not a regular file; skipping.`);
      return null;
    }

    if (stats.size > MAX_BACKEND_STATE_BYTES) {
      tasks.debug(`Backend detection: ${tfstatePath} is ${stats.size} bytes, exceeding the ${MAX_BACKEND_STATE_BYTES}-byte guard; skipping rather than risk an unbounded read.`);
      return null;
    }

    try {
      raw = fs.readFileSync(fd, 'utf-8');
    } catch (err) {
      tasks.debug(`Backend detection: failed to read ${tfstatePath}: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  } finally {
    fs.closeSync(fd);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    tasks.debug(`Backend detection: failed to parse ${tfstatePath} as JSON: ${err instanceof Error ? err.message : err}`);
    return null;
  }

  const backendType = (parsed as { backend?: { type?: unknown } } | null)?.backend?.type;
  if (typeof backendType !== 'string') {
    tasks.debug(`Backend detection: ${tfstatePath} has no backend.type; skipping.`);
    return null;
  }

  const cloud = BACKEND_TYPE_TO_CLOUD[backendType];
  if (!cloud) {
    tasks.debug(`Backend detection: backend type '${backendType}' has no managed cloud credentials to inject; skipping.`);
    return null;
  }

  return cloud;
}
