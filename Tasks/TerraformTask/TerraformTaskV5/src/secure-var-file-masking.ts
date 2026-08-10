import tasks = require('azure-pipelines-task-lib/task');
import fs = require('fs');
import { EnvironmentVariableHelper } from './environment-variables';

/**
 * The task manifest documents `secureVarsFile` as THE place to put sensitive
 * variables, but the file's contents were never registered with the agent's
 * secret masker — only the file's on-disk permissions were tightened. The tool
 * echoes variable values in several ordinary situations (HCL validation
 * diagnostics that quote the offending value, `console` evaluation output,
 * TF_LOG/PACKER_LOG debug output — all reachable through this task's own
 * inputs), and any such value printed verbatim would appear unmasked in the
 * build log because nothing ever registered it.
 *
 * This module closes that gap: after the secure file is downloaded, every scalar
 * string value it declares is registered with `tasks.setSecret()` BEFORE the
 * file path is handed to the tool. Parsing is best-effort by design — an
 * unreadable or unparseable file warns and leaves the existing behaviour
 * untouched rather than failing the task.
 */

/**
 * Values shorter than this are not registered. `setSecret` masks every
 * occurrence of a literal substring anywhere in the log, so registering a short
 * token (`"dev"`, `"true"`, `"1.0"`) would blank out unrelated, non-secret log
 * text across the whole run. Real credentials are comfortably longer.
 */
export const MIN_MASKABLE_VALUE_LENGTH = 4;

/** Strips `#` and `//` line comments so a quoted word inside a comment is not mistaken for a value. */
function stripLineComments(content: string): string {
    return content
        .split('\n')
        .map((line) => line.replace(/(^|\s)(#|\/\/).*$/, ''))
        .join('\n');
}

function collectJsonStrings(node: unknown, out: string[]): void {
    if (typeof node === 'string') {
        out.push(node);
        return;
    }
    if (Array.isArray(node)) {
        for (const item of node) collectJsonStrings(item, out);
        return;
    }
    if (node && typeof node === 'object') {
        // Only VALUES are collected — a variable NAME is not a secret, and
        // masking it would blank out ordinary log text.
        for (const value of Object.values(node as Record<string, unknown>)) collectJsonStrings(value, out);
    }
}

/**
 * Extracts the scalar string values declared by a var file. Handles both
 * supported shapes:
 *   - `*.pkrvars.json` / `*.tfvars.json` — parsed as JSON, every string value at
 *     any nesting depth (including inside lists and maps) is returned;
 *   - `*.pkrvars.hcl` / `*.tfvars` — every double-quoted string literal is
 *     returned (in HCL var files, variable NAMES are unquoted, so a quoted
 *     literal is always a value, an element of a list value, or a map value).
 * Returns an empty array when nothing can be extracted; never throws.
 */
export function extractVarFileScalarStrings(content: string): string[] {
    const out: string[] = [];
    const trimmed = content.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            collectJsonStrings(JSON.parse(trimmed), out);
            return out;
        } catch {
            // Not valid JSON after all — fall through to the HCL scan rather
            // than failing: a `.hcl` file may legitimately start with a block.
        }
    }
    const withoutComments = stripLineComments(content);
    const quoted = /"((?:[^"\\]|\\.)*)"/g;
    let match: RegExpExecArray | null;
    while ((match = quoted.exec(withoutComments)) !== null) {
        // Unescape the HCL/JSON escapes that matter for byte-exact masking.
        out.push(match[1]
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\'));
    }
    return out;
}

/**
 * Registers every scalar string value declared in the downloaded secure var file
 * with the agent's secret masker.
 *
 * Registration is LINE-WISE: `tasks.setSecret()` throws `LIB_MultilineSecret` on
 * a CR/LF-bearing argument (which would leave the value unregistered entirely),
 * and ADO's masker matches within a single log line anyway, so a heredoc/
 * multi-line value has to be registered a line at a time to actually be masked.
 *
 * Best-effort: an unreadable or unparseable file warns and returns, preserving
 * the previous behaviour of simply passing the file through to the tool.
 */
export function maskSecureVarFileValues(filePath: string): void {
    let content: string;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        tasks.warning(`Could not read the secure variable file to mask its values; values it contains will NOT be masked in the build log: ${error instanceof Error ? error.message : error}`);
        return;
    }
    const values = extractVarFileScalarStrings(content);
    if (values.length === 0) {
        tasks.debug('No scalar string values were extracted from the secure variable file; nothing to mask.');
        return;
    }
    for (const value of values) {
        for (const line of value.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed.length >= MIN_MASKABLE_VALUE_LENGTH) {
                EnvironmentVariableHelper.registerSecret(trimmed);
            }
        }
    }
    tasks.debug(`Registered ${values.length} secure variable file value(s) with the secret masker.`);
}
