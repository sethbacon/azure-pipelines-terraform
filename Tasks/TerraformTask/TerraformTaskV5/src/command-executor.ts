import { ToolRunner, IExecOptions } from 'azure-pipelines-task-lib/toolrunner';
import tasks = require('azure-pipelines-task-lib/task');

/**
 * Upper bound on the terraform stdout buffered in memory by a single
 * {@link CommandExecutor.execWithStdoutCapture} call — the choke
 * point every `-json` digest/output pipeline (plan/apply/destroy/show/output/
 * refresh) runs through. An unbounded `stdout += chunk` lets a huge plan/state
 * (many resources, large embedded blobs) or a misbehaving provider grow one JS
 * string until the process OOMs and crashes the task (#632, CWE-400), mirroring
 * the HTTP clients' MAX_RESPONSE_BYTES body cap. The ceiling is deliberately
 * generous relative to the digest pipeline's own 12 MB hard / 16 MB tab-parse
 * ceilings — a real large-estate `show -json` legitimately exceeds those before
 * redaction — but bounded so a runaway can't exhaust a shared agent. On breach
 * the child is killed and the call throws; the raw output is never silently
 * truncated into a parsed digest.
 */
export const MAX_CAPTURED_STDOUT_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * Upper bound on the stdout/stderr captured by fmt()/test() purely to build a
 * clearer failure message (#826) -- deliberately much smaller than
 * {@link MAX_CAPTURED_STDOUT_BYTES}, which bounds a `-json` plan/state/apply
 * digest capture that can legitimately be very large. `fmt -check`'s file
 * list and terraform's own CLI diagnostics are always small; this just keeps
 * a misbehaving/verbose run from growing the buffer unreasonably before the
 * message is built.
 */
export const MAX_CAPTURED_MESSAGE_BYTES = 64 * 1024; // 64 KiB

/**
 * Runs a ToolRunner and turns the result into either output or an error.
 *
 * Split out of BaseTerraformCommandHandler for #878. Every terraform
 * sub-command in the handler funnels through {@link execWithTimeout} or
 * {@link execWithStdoutCapture}, so this is the single place that decides how
 * long a command may run, how much of its output may be held in memory, and
 * what a failure message looks like. None of that depends on which cloud
 * provider is configured, which is why it does not belong on the provider
 * class hierarchy.
 *
 * Holds no state and takes no dependencies: each method is a function of its
 * arguments plus the task inputs. It is a class rather than loose functions so
 * the four members stay addressable as one unit -- including by the tests that
 * spy on {@link execWithTimeout} through the prototype.
 */
export class CommandExecutor {
    /**
     * Reads the optional `commandTimeoutMinutes` input and returns the
     * configured minutes, or `undefined` when unset/0/invalid -- the default,
     * fully backward-compatible "unbounded" behavior every existing call site
     * and test relies on (#822).
     */
    getCommandTimeoutMinutes(): number | undefined {
        const raw = tasks.getInput("commandTimeoutMinutes", false);
        const minutes = parseInt(raw || '0', 10);
        return Number.isFinite(minutes) && minutes > 0 ? minutes : undefined;
    }

    /**
     * Wraps a ToolRunner's execAsync with a wall-clock deadline (#822,
     * CWE-1088). azure-pipelines-task-lib's execAsync only bounds output
     * byte-size (this file's own MAX_CAPTURED_STDOUT_BYTES cap) -- never
     * wall-clock time -- so a stalled provider plugin or a network partition
     * to a remote state backend/lock service blocks the job indefinitely with
     * no task-level diagnostic, relying solely on the ADO job-level timeout
     * (unbounded by default on a self-hosted agent). Mirrors the Promise.race +
     * killChildProcess pattern already shipped in
     * TerraformPolicyCheckV1/TerraformDocsV1's exec-timeout.ts, kept as a
     * TaskV5-local method (not a shared-module copy) -- every TaskV5 call site
     * funnels through this ONE method or {@link execWithStdoutCapture} (which
     * itself delegates here), so there is no second implementation to keep
     * byte-identical across a shared-module family the way the
     * single-call-site docs/policy tasks need.
     *
     * Two ways to get a deadline:
     *  - `explicitTimeoutMs` + `explicitTimeoutMessage`: an ALWAYS-ON bound the
     *    caller controls directly, independent of the opt-in
     *    `commandTimeoutMinutes` input -- used by azure-terraform-command-
     *    handler.ts's `az login`/`az account set` calls (a hung `az login
     *    --identity` against an unreachable instance-metadata endpoint used to
     *    block the job indefinitely with NO bound at all, opt-in or
     *    otherwise). Caller must supply both or neither -- there is no
     *    sensible default message for an arbitrary caller-chosen duration.
     *  - Omitted (every pre-existing call site, the main terraform command
     *    path): falls back to the `commandTimeoutMinutes` input. When that is
     *    unset/0/invalid (the default), this is a pure passthrough to
     *    `tool.execAsync(options)` -- no timer, no Promise.race -- so every
     *    pre-existing call site's behavior is byte-for-byte unchanged.
     */
    async execWithTimeout(
        tool: ToolRunner,
        options: IExecOptions,
        explicitTimeoutMs?: number,
        explicitTimeoutMessage?: string,
    ): Promise<number> {
        let timeoutMs: number;
        let timeoutMessage: string;
        if (explicitTimeoutMs !== undefined) {
            timeoutMs = explicitTimeoutMs;
            timeoutMessage = explicitTimeoutMessage!;
        } else {
            const minutes = this.getCommandTimeoutMinutes();
            if (!minutes) {
                return tool.execAsync(options);
            }
            timeoutMs = minutes * 60_000;
            timeoutMessage = tasks.loc('TerraformCommandTimedOut', minutes);
        }
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                try { tool.killChildProcess('SIGKILL'); } catch { /* best-effort: child may already be gone */ }
                reject(new Error(timeoutMessage));
            }, timeoutMs);
        });
        const exec = tool.execAsync(options);
        // Swallow a late rejection from the killed child once the deadline has
        // already won the race below -- otherwise it surfaces as an unhandled
        // promise rejection.
        exec.catch(() => { /* intentionally ignored */ });
        try {
            return await Promise.race([exec, deadline]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /**
     * Throws a command-specific loc-keyed failure, folding any captured
     * stderr/diagnostic detail lines underneath it (#821). plan()/apply()/
     * destroy()/fmt()/test() each independently hand-wrote this exact "does
     * the loc message need a detail block or not" formatting -- and the two
     * historical fixes #821 cites as evidence of the resulting cost (#749,
     * #750) were both really about WHICH detail to fold in, not this
     * formatting step, which is now the one place a future fix to fold in a
     * new/different detail source needs to change. `details` may be empty
     * (destroy()'s real -auto-approve exec has no captured output to fold in
     * today) -- an empty/all-blank array reduces to the bare loc message,
     * byte-identical to a plain `throw new Error(tasks.loc(...))`.
     */
    throwCommandFailure(locKey: string, code: number, details: string[] = []): never {
        const detail = details.filter(line => line).join('\n');
        throw new Error(detail
            ? `${tasks.loc(locKey, code)}\n${detail}`
            : tasks.loc(locKey, code));
    }

    /**
     * Attaches ADDITIVE stdout/stderr listeners to `tool`, accumulating each
     * stream into its OWN buffer under one shared byte budget, for fmt()/
     * test()'s failure-message building (#826). Deliberately separate from
     * {@link execWithStdoutCapture}, which forces `silent: true` (suppressing
     * the live console echo fmt/test have always had) and is sized for a
     * `-json` digest, not a small diagnostic message. Keeping the two streams
     * separate (rather than one merged buffer) lets a caller tell "the tool
     * reported X on stdout" apart from "it reported Y on stderr" -- fmt() uses
     * this to avoid misclassifying a stderr-only crash as `-check`'s
     * stdout-only unformatted-file listing. Must be called BEFORE
     * execWithTimeout/execAsync -- the mock and real ToolRunner both emit
     * these events synchronously during exec, before it resolves.
     */
    captureMessageStreams(tool: ToolRunner): { stdout(): string; stderr(): string } {
        let capturedStdout = '';
        let capturedStderr = '';
        let capturedBytes = 0;
        const makeCapture = (append: (text: string) => void) => (data: string | Buffer): void => {
            if (capturedBytes >= MAX_CAPTURED_MESSAGE_BYTES) return;
            const text = data.toString();
            capturedBytes += Buffer.byteLength(text);
            append(text);
        };
        tool.on('stdout', makeCapture(text => { capturedStdout += text; }));
        tool.on('stderr', makeCapture(text => { capturedStderr += text; }));
        return {
            stdout: () => capturedStdout,
            stderr: () => capturedStderr,
        };
    }

    async execWithStdoutCapture(
        terraformTool: ToolRunner,
        options: IExecOptions,
        // Overridable ONLY so tests can exercise the overflow guard without
        // allocating 100 MB; production callers always take the module default.
        maxStdoutBytes: number = MAX_CAPTURED_STDOUT_BYTES,
    ): Promise<{ code: number; stdout: string; stderr: string }> {
        let stdout = '';
        let stderr = '';
        // Running byte totals (not stdout.length re-measured per chunk, which would
        // be O(n^2)) so an unbounded plan/state or a runaway provider can't grow
        // the buffer until the task OOMs (#632). On stdout breach we stop
        // appending, drop the partial buffer, kill the child, and throw *after*
        // exec resolves -- never returning a silently-truncated string that a
        // caller would parse into a digest.
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let stdoutOverflow = false;
        terraformTool.on('stdout', (data: string | Buffer) => {
            if (stdoutOverflow) return;
            const chunk = data.toString();
            stdoutBytes += Buffer.byteLength(chunk);
            if (stdoutBytes > maxStdoutBytes) {
                stdoutOverflow = true;
                stdout = '';
                try { terraformTool.killChildProcess('SIGKILL'); } catch { /* best-effort: child may already be gone */ }
                return;
            }
            stdout += chunk;
        });
        // #613: capture stderr too. When a caller runs with `silent: true` (the
        // structured apply path) the ToolRunner suppresses its own echo of the
        // child's output, and Terraform writes CLI usage errors / provider
        // crashes to STDERR rather than the stdout stream the caller consumes --
        // so without capturing stderr those failures are completely invisible
        // (the production incident behind #613). Callers that don't need it
        // simply ignore the field. stderr is bounded by the same ceiling (cease
        // appending past it) so a provider spewing to stderr can't OOM the agent
        // either; unlike stdout it is diagnostic only, so a capped-but-present
        // buffer is kept rather than failing the call.
        terraformTool.on('stderr', (data: string | Buffer) => {
            if (stderrBytes > maxStdoutBytes) return;
            const chunk = data.toString();
            stderrBytes += Buffer.byteLength(chunk);
            stderr += chunk;
        });

        const overflowError = () => new Error(
            `terraform emitted more than ${maxStdoutBytes} bytes on stdout; refusing to buffer an unbounded amount into memory ` +
            `(an extremely large plan/state, or a misbehaving provider). Narrow the operation (e.g. with -target) if the size is legitimate.`,
        );

        // #492 (reopen): `silent` is FORCED here, not left to callers -- a capture
        // primitive must never let the ToolRunner mirror the child's stdout into
        // the build log. Most captures are `terraform output -json` / `show
        // -json`, whose cleartext includes values declared `sensitive = true`
        // (only the human console format is redacted), and setSecret registration
        // happens only after this call resolves, so the agent's forward-only
        // masker cannot redact lines that were already echoed. A caller that
        // wants console output must echo the captured string itself after
        // redaction (see echoApplyMessages() and plan()'s post-capture echo).
        let code: number;
        try {
            code = await this.execWithTimeout(terraformTool, { ...options, silent: true });
        } catch (err) {
            // A caller without ignoreReturnCode reaches here on a non-zero exit
            // (or spawn failure). If the overflow guard killed the child, report
            // the overflow -- the generic rejection would mask the real cause.
            if (stdoutOverflow) {
                throw overflowError();
            }
            // With the echo suppressed above, terraform's diagnostics (it writes
            // CLI/config errors to STDERR) would otherwise be swallowed into a
            // bare "failed with exit code N" (#613) -- fold the captured stderr
            // into the rethrow.
            const message = err instanceof Error ? err.message : String(err);
            const trimmedStderr = stderr.trim();
            throw new Error(trimmedStderr ? `${message}\n${trimmedStderr}` : message);
        }

        if (stdoutOverflow) {
            throw overflowError();
        }

        return { code, stdout, stderr };
    }
}
