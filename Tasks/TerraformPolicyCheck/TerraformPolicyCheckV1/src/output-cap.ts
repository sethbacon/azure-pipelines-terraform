import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';

/**
 * Upper bound on the policy-engine stdout(+stderr) buffered in memory by
 * {@link attachBoundedCapture}. Mirrors the HTTP clients' MAX_RESPONSE_BYTES
 * body cap and TerraformTaskV5's MAX_CAPTURED_STDOUT_BYTES: an unbounded
 * `stdout += chunk` in the OPA/Sentinel engines lets a huge or misbehaving
 * engine output grow one JS string until the task OOMs (#632, CWE-400).
 * Generous, but bounded so a runaway can't exhaust a shared self-hosted agent.
 */
export const MAX_CAPTURED_OUTPUT_BYTES = 100 * 1024 * 1024; // 100 MB

/** Handle returned by {@link attachBoundedCapture}; call after execAsync resolves. */
export interface BoundedCapture {
    /** Throws if the stdout stream exceeded the cap while executing. */
    assertWithinCap(): void;
}

/**
 * Attaches byte-bounded stdout/stderr accumulation to a ToolRunner. Each chunk
 * is handed to `sink(stream, text)` for the caller to append to its own buffers
 * (opa-engine keeps stdout/stderr separate; sentinel-engine folds both into one
 * buffer). A running byte total is kept per stream (not the whole buffer
 * re-measured per chunk, which would be O(n^2)). Once the *stdout* total
 * exceeds `maxBytes` the child is killed and no further stdout is delivered; the
 * subsequent {@link BoundedCapture.assertWithinCap} then throws, so an oversized
 * engine output fails the task with a clear error instead of OOMing the agent or
 * being silently truncated into a parsed policy result. stderr is bounded the
 * same way (ceases appending past the cap) but never fails the call — it is
 * diagnostic only.
 */
export function attachBoundedCapture(
    tool: ToolRunner,
    sink: (stream: 'stdout' | 'stderr', text: string) => void,
    maxBytes: number = MAX_CAPTURED_OUTPUT_BYTES,
): BoundedCapture {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;

    tool.on('stdout', (data: string | Buffer) => {
        if (overflow) return;
        const text = data.toString();
        stdoutBytes += Buffer.byteLength(text);
        if (stdoutBytes > maxBytes) {
            overflow = true;
            try { tool.killChildProcess('SIGKILL'); } catch { /* best-effort: child may already be gone */ }
            return;
        }
        sink('stdout', text);
    });
    tool.on('stderr', (data: string | Buffer) => {
        if (stderrBytes > maxBytes) return;
        const text = data.toString();
        stderrBytes += Buffer.byteLength(text);
        sink('stderr', text);
    });

    return {
        assertWithinCap(): void {
            if (overflow) {
                throw new Error(
                    `Policy engine emitted more than ${maxBytes} bytes on stdout; refusing to buffer an unbounded amount into memory (#632).`,
                );
            }
        },
    };
}
