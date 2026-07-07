// SHARED MODULE — intentionally duplicated across TerraformInstallerV1/src,
// PolicyAgentInstallerV1/src and TerraformDocsInstallerV1/src. CI
// (scripts/check-shared-modules.js) enforces that the copies stay byte-identical,
// so a change to the fail-closed default semantics can never be applied to one
// installer and silently missed in the others. This duplication is deliberate
// (each task bundles independently) — not drift to be flagged.
import tasks = require('azure-pipelines-task-lib/task');

/**
 * Reads a boolean input whose intended default is TRUE (fail-closed). It reads the
 * raw input rather than getBoolInput(name, false) so the default still holds on an
 * agent that does not materialize task.json defaultValues into the input env var
 * (where getBoolInput would silently return false): unset/empty -> true; any value
 * other than "false" (case-insensitive) -> true.
 */
export function getBoolInputDefaultTrue(name: string): boolean {
  const raw = tasks.getInput(name, false);
  return raw === undefined || raw.trim() === '' ? true : raw.trim().toLowerCase() !== 'false';
}
