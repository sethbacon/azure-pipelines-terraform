import { IExecOptions, ToolRunner } from 'azure-pipelines-task-lib/toolrunner';

// Wall-clock ceiling for a local subprocess (policy engine / terraform-docs).
// azure-pipelines-task-lib's execAsync only bounds output byte-size (the #632
// capture caps), not wall-clock time, so a pathological policy bundle, a
// misbehaving engine binary, or a doc-generation invocation that hangs (e.g. on
// a huge/cyclic module graph) would otherwise block until the ADO job-level
// timeout with no task-level diagnostic distinguishing a hang from ordinary
// slowness. A few minutes is generous for these normally-fast tools while still
// failing fast and distinctly. Mirrors policy-source.ts's git-clone GIT_TIMEOUT_MS
// (#782).
export const TOOL_EXEC_TIMEOUT_MS = 300_000;

/**
 * Runs a ToolRunner's execAsync under a hard wall-clock deadline. On timeout the
 * child process is killed and the returned promise rejects with `timeoutMessage`;
 * otherwise it resolves with the tool's exit code exactly as execAsync would.
 *
 * The same Promise.race-with-deadline-and-killChildProcess pattern already used
 * for the git clone in policy-source.ts (execGit), generalized so the local
 * policy-engine and terraform-docs subprocesses share one bounded-execution seam.
 */
export async function execWithTimeout(
  tool: ToolRunner,
  options: IExecOptions,
  timeoutMessage: string,
  timeoutMs: number = TOOL_EXEC_TIMEOUT_MS,
): Promise<number> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      tool.killChildProcess();
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });
  // If the deadline wins the race, killChildProcess() makes this promise reject
  // later; attach a no-op catch so that late rejection is swallowed intentionally
  // rather than surfacing as an unhandled promise rejection (these tasks have no
  // process-level unhandledRejection handler).
  const exec = tool.execAsync(options);
  exec.catch(() => { /* swallowed: the timeout is reported via the deadline branch */ });
  try {
    return await Promise.race([exec, deadline]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
