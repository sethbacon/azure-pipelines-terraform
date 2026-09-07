import tasks = require('azure-pipelines-task-lib/task');
import fs = require('fs');
import { EnvironmentVariableHelper } from '@4cloudguru/pipeline-task-ado';

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

/** Opens a heredoc: `<<EOT` or the indented form `<<-EOT`, capturing the terminator. */
const HEREDOC_OPEN = /<<(-?)([A-Za-z_][A-Za-z0-9_]*)\s*$/;

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
 *   - `*.pkrvars.hcl` / `*.tfvars` — every double-quoted string literal AND every
 *     heredoc body is returned (in HCL var files, variable NAMES are unquoted, so
 *     a quoted literal is always a value, an element of a list value, or a map
 *     value).
 * Returns an empty array when nothing can be extracted; never throws.
 *
 * The HCL scan is a single left-to-right pass that tracks whether it is inside a
 * quoted literal, rather than a comment-stripping regex pre-pass. A pre-pass has
 * no string awareness, so `password = "abc #def"` was truncated at the `#`; the
 * real secret was then never registered AND the now-unterminated quote paired
 * with the next quote later in the file, registering an unrelated fragment as a
 * secret. Both halves of that failure were silent.
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
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].replace(/\r$/, '');
        const { values, heredoc } = scanHclLine(line);
        out.push(...values);
        if (!heredoc) continue;
        // A heredoc body is the idiomatic way to put a PEM key or any multi-line
        // credential in a var file, and it contains no quoted literal at all —
        // so the quoted-literal scan alone never saw one. Consume through the
        // terminator and emit the body; the caller registers it line-wise.
        const body: string[] = [];
        let closed = false;
        for (i++; i < lines.length; i++) {
            const bodyLine = lines[i].replace(/\r$/, '');
            // `<<-` allows the terminator to be indented; plain `<<` does not.
            if (heredoc.indented ? bodyLine.trim() === heredoc.terminator : bodyLine === heredoc.terminator) {
                closed = true;
                break;
            }
            body.push(bodyLine);
        }
        // An unterminated heredoc runs to EOF. Register what was read anyway:
        // the file is malformed, but the bytes are still a credential the tool
        // may echo, and refusing to mask them is the worse failure.
        if (!closed) tasks.debug('A heredoc in the secure variable file was not terminated; masking its body up to end-of-file.');
        if (body.length > 0) out.push(body.join('\n'));
    }
    return out;
}

/**
 * Scans one HCL line left to right, returning the quoted string literals it
 * declares and, if the line opens a heredoc, that heredoc's terminator.
 *
 * `#` and `//` start a comment ONLY outside a quoted literal, which is the whole
 * point of scanning rather than pre-stripping.
 */
function scanHclLine(line: string): { values: string[]; heredoc?: { terminator: string; indented: boolean } } {
    const values: string[] = [];
    let inString = false;
    let current = '';
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inString) {
            if (ch === '\\' && i + 1 < line.length) {
                current += ch + line[i + 1];
                i++;
                continue;
            }
            if (ch === '"') {
                values.push(unescapeHcl(current));
                current = '';
                inString = false;
                continue;
            }
            current += ch;
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === '#' || (ch === '/' && line[i + 1] === '/')) {
            // Everything from here is a comment; a heredoc cannot open inside it.
            return { values };
        }
    }
    // An unterminated quote is a malformed line, not a licence to keep scanning
    // into the next one — dropping `current` here is what stops a stray quote
    // from pairing across lines and registering an unrelated fragment.
    const opened = HEREDOC_OPEN.exec(line);
    if (opened) {
        return { values, heredoc: { terminator: opened[2], indented: opened[1] === '-' } };
    }
    return { values };
}

function unescapeHcl(raw: string): string {
    // Unescape the HCL/JSON escapes that matter for byte-exact masking.
    return raw
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
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
        // A secure var file that declares no maskable value is the observable
        // signature of an extractor failure as well as of an genuinely
        // value-free file, and this is a control that would otherwise report
        // success while masking nothing. Warn rather than debug: the operator
        // put this file here precisely because they believe it holds secrets.
        tasks.warning('No values could be extracted from the secure variable file, so NOTHING from it has been registered with the build log secret masker. If this file does contain sensitive values, they will appear unmasked in the log if the tool echoes them. Check the file parses as the format its extension implies.');
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
