import tasks = require('azure-pipelines-task-lib/task');
import os = require('os');

/**
 * Resolves the directory for ephemeral WIF credential/token files (private
 * keys, security tokens, JWTs, synthetic config files) shared by the AWS/GCP/
 * OCI handlers. Prefers Agent.TempDirectory — which the agent auto-purges at
 * job end — over os.tmpdir() so the residual-on-disk window for these
 * short-lived secrets is bounded to the job, even if both the finally cleanup
 * and the signal handlers are bypassed (SIGKILL/host crash). Falls back to
 * os.tmpdir() when running off a pipeline agent (no Agent.TempDirectory set).
 */
export function resolveWifTempDir(): string {
  return tasks.getVariable("Agent.TempDirectory") || os.tmpdir();
}
