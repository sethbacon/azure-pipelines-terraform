import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import { getSecureVarFileArgs } from './secure-file-loader';
import { TempFileManager } from './temp-file-manager';
import tasks = require('azure-pipelines-task-lib/task');

/** Validates Terraform resource addresses (e.g. `aws_instance.foo`, `module.bar["key"]`). */
export const RESOURCE_ADDRESS_RE = /^[a-zA-Z_][\w\-]*(\[[^\]]+\])?(\.[a-zA-Z_][\w\-]*(\[[^\]]+\])?)*$/;

/**
 * Splits a multi-line task input into trimmed, non-empty lines -- the common
 * core of this task's several multi-line-input parsers (var-file paths, target
 * addresses, -var tokens, -backend-config args). Each line is kept whole (never
 * further split) so a value containing spaces -- a path on a Windows agent, or
 * a quoted index key like `module.x["a b"]` -- survives as one token.
 * `skipComments` additionally drops lines starting with `#`, matching the
 * `-var`/`-backend-config` inputs' existing support for comment lines; the
 * var-file/target-address inputs never supported that and keep it disabled so
 * behavior here is unchanged from before this helper existed.
 */
export function splitNonEmptyLines(input: string | undefined, opts: { skipComments?: boolean } = {}): string[] {
    if (!input) return [];
    return input
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !(opts.skipComments && l.startsWith('#')));
}

/**
 * Splits a multi-line `varFile` input into `-var-file=<path>` tokens, one per
 * non-empty line. Each path is kept whole so it can be passed as a single argv
 * entry — paths containing spaces (common on Windows agents) must not be split.
 */
export function parseVarFileTokens(varFile: string | undefined): string[] {
    return splitNonEmptyLines(varFile).map(f => `-var-file=${f}`);
}

/**
 * Splits a multi-line `targetResources` input into validated `-target=<address>`
 * tokens. Addresses may legitimately contain spaces inside quoted index keys
 * (e.g. `module.x["a b"]`), so each is kept as a single argv entry.
 */
export function parseTargetTokens(targetResources: string | undefined): string[] {
    const lines = splitNonEmptyLines(targetResources);
    for (const address of lines) {
        if (!RESOURCE_ADDRESS_RE.test(address)) {
            throw new Error(`Invalid target address '${address}': must be a valid Terraform resource address`);
        }
    }
    return lines.map(a => `-target=${a}`);
}

/**
 * Splits `commandOptions` into argv the way ToolRunner's `.line()` does, by
 * mirroring task-lib's own `_argStringToArray`: a `"` toggles quoting anywhere
 * in a token (not only at its start) and is stripped, `\` escapes inside
 * quotes, and only unquoted whitespace separates arguments.
 *
 * The helpers below inspect `commandOptions` to make decisions about an argv
 * that ToolRunner -- not they -- ultimately builds, so any disagreement between
 * the two parsers is a bug by construction. The previous regex tokenizer only
 * recognized a token that was quoted in its entirety, so `-out="my plan.tfplan"`
 * split into `-out="my` + `plan.tfplan"` and every helper drew a different
 * conclusion than Terraform did (#875).
 */
export function splitCommandOptions(commandOptions: string): string[] {
    const args: string[] = [];
    let inQuotes = false;
    let escaped = false;
    let lastCharWasSpace = true;
    let arg = '';

    const append = (c: string): void => {
        // task-lib only treats a backslash as an escape for a double quote.
        if (escaped && c !== '"') {
            arg += '\\';
        }
        arg += c;
        escaped = false;
    };

    // Indexed rather than for..of so surrogate pairs are handled as task-lib does.
    for (let i = 0; i < commandOptions.length; i++) {
        const c = commandOptions.charAt(i);

        if (c === ' ' && !inQuotes) {
            if (!lastCharWasSpace) {
                args.push(arg);
                arg = '';
            }
            lastCharWasSpace = true;
            continue;
        }
        lastCharWasSpace = false;

        if (c === '"') {
            if (!escaped) {
                inQuotes = !inQuotes;
            } else {
                append(c);
            }
            continue;
        }
        if (c === '\\' && escaped) {
            append(c);
            continue;
        }
        if (c === '\\' && inQuotes) {
            escaped = true;
            continue;
        }
        append(c);
    }

    if (!lastCharWasSpace) {
        args.push(arg.trim());
    }
    return args;
}

/**
 * Best-effort heuristic (Phase 5 §5.5) for whether a `show` command's
 * `commandOptions` carries a positional plan-file argument (e.g. `tfplan.out`,
 * or `-no-color tfplan.out`) as opposed to flags only. Terraform's `show`
 * reads a saved plan file when given one, or the CURRENT state when given
 * none -- and this task has no other signal to distinguish the two, since a
 * plan-file path is free text embedded in `commandOptions` alongside any
 * flags, not a separate input. Used ONLY to gate the new `publishStateResults`
 * structured-state-summary path (never the pre-existing show-of-planfile
 * sensitive-output/destroy-change detection, which is unconditional and
 * unaffected by this function): a positional token found here means this run
 * is a planfile show, so the state-summary attachment is skipped even if
 * `publishStateResults` is set (documented in the task's helpMarkDown).
 *
 * Tokenized with {@link splitCommandOptions}, so quoting is read exactly as
 * ToolRunner's `.line()` reads it. A value that isn't a flag (doesn't start
 * with `-`) is treated as positional.
 */
export function hasPositionalCommandArg(commandOptions: string | undefined): boolean {
    if (!commandOptions) return false;
    return splitCommandOptions(commandOptions).some(t => !t.startsWith('-'));
}

/**
 * Returns the plan-file path from a user-supplied `-out=<path>` / `-out <path>`
 * (double-dash `--out` accepted too, as Terraform does) token in
 * `commandOptions`, or undefined if none is present. Tokenized with
 * {@link splitCommandOptions}, so the returned path is byte-for-byte the one
 * ToolRunner passes to Terraform -- including quoted paths containing spaces,
 * in both the `-out="a b.tfplan"` and `-out "a b.tfplan"` forms (#875).
 *
 * Used by plan() UNCONDITIONALLY (#675 2nd follow-up) to detect a user-supplied
 * `-out=` so its plan file can be permission-tightened via afterPlanFileWritten()
 * even when publishPlanSummary is unset, and by plan()/destroy()'s
 * publishPlanSummary path (#612): when the user already saves the plan via
 * their own `-out=`, the task must NOT inject a second `-out=` -- Terraform
 * silently honors only the LAST `-out=` on the command line, so the task's
 * tempfile would shadow the user's file and the user's artifact plan would
 * never be written. When a user `-out=` is present the subsequent
 * `terraform show -json` digest is built against the user's own saved plan (which
 * then describes the very plan that gets applied); when absent, the task injects
 * its own tempfile exactly as before.
 */
export function extractOutFlagPath(commandOptions: string | undefined): string | undefined {
    if (!commandOptions) return undefined;
    const tokens = splitCommandOptions(commandOptions);
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const eq = token.match(/^--?out=(.*)$/);
        if (eq) return eq[1];
        if (token === '-out' || token === '--out') {
            const next = tokens[i + 1];
            if (next !== undefined) return next;
        }
    }
    return undefined;
}

/**
 * Detects a standalone `-json` (or `--json`) flag in `commandOptions` as
 * Terraform itself would parse it -- a whole token, not a substring match, so
 * e.g. `-var=myjsonvalue` or a quoted value that merely contains the text
 * "json" is correctly ignored. Used to fail closed on plan()'s
 * publishPlanResults path (#492): with `-json`, terraform plan's stdout is
 * machine-readable NDJSON whose `change.after` carries real values in
 * cleartext (masked only by a parallel `after_sensitive` flag meant for a
 * redacting CONSUMER to apply -- exactly like apply -json), not the
 * human-readable format's own `(sensitive value)` redaction that makes
 * echoing that capture to the console safe.
 */
export function commandOptionsContainsJsonFlag(commandOptions: string | undefined): boolean {
    if (!commandOptions) return false;
    return splitCommandOptions(commandOptions).some((token) => token === '-json' || token === '--json');
}

/**
 * Turns this task's structured inputs into Terraform argv.
 *
 * Split out of BaseTerraformCommandHandler for #878. The god class mixed four
 * unrelated jobs; this is the one that answers "what flags does this run need?"
 * and it is the only one that needs to know that `-target` addresses are
 * validated, that `-parallelism` must be a positive integer, or that a
 * space-containing var-file path must survive as ONE argv entry. Nothing here
 * executes a command or interprets a result.
 *
 * The two methods that read a downloaded secure var file need somewhere to
 * record the temp file for later scrubbing, so a {@link TempFileManager} is
 * injected rather than reached for through a base class -- that dependency is
 * now explicit in the constructor instead of implicit in `this`.
 */
export class ArgumentBuilder {
    constructor(private readonly tempFileManager: TempFileManager) { }

    replaceTokens(): string[] {
        const replaceAddress = tasks.getInput("replaceAddress", false);
        if (!replaceAddress) return [];
        if (!RESOURCE_ADDRESS_RE.test(replaceAddress)) {
            throw new Error(`Invalid replace address '${replaceAddress}': must be a valid Terraform resource address`);
        }
        return [`-replace=${replaceAddress}`];
    }

    /** Returns the `-parallelism=N` token, or [] if not set. Validates the value. */
    parallelismTokens(): string[] {
        const parallelism = tasks.getInput("parallelism", false);
        if (!parallelism) return [];
        const n = parseInt(parallelism, 10);
        if (isNaN(n) || n < 1) {
            throw new Error(`Invalid parallelism value '${parallelism}': must be a positive integer`);
        }
        return [`-parallelism=${n}`];
    }

    /** Downloads the secure var file (if configured) and returns its `-var-file=<path>` token. */
    async secureVarFileTokens(): Promise<string[]> {
        const result = await getSecureVarFileArgs();
        if (!result) return [];
        // The path is retained so the file can be scrubbed before it is unlinked (#662).
        this.tempFileManager.setSecureFile(result.secureFileId, result.filePath);
        return [result.varFileArg];
    }

    /**
     * Builds the structured leading flags that precede the base command. Each flag
     * is returned as a single argv token (applied later via {@link applyTokens})
     * so values containing spaces — a var-file path on a Windows agent, or a
     * target/replace address with a quoted index key — are never split.
     *
     * Token order (left to right): secureVarFile, targetResources, varFiles,
     * refreshOnly, replace. Flag order is irrelevant to Terraform; it is fixed
     * here only for predictability and stable test assertions.
     */
    async buildLeadingArgs(config: {
        replaceFlag?: boolean;
        refreshOnly?: boolean;
        varFiles?: boolean;
        targetResources?: boolean;
        secureVarFile?: boolean;
    }): Promise<string[]> {
        const tokens: string[] = [];
        if (config.secureVarFile) tokens.push(...await this.secureVarFileTokens());
        if (config.targetResources) tokens.push(...parseTargetTokens(tasks.getInput("targetResources", false)));
        if (config.varFiles) tokens.push(...parseVarFileTokens(tasks.getInput("varFile", false)));
        if (config.refreshOnly && tasks.getBoolInput("refreshOnly", false)) tokens.push('-refresh-only');
        if (config.replaceFlag) tokens.push(...this.replaceTokens());
        return tokens;
    }

    /** Applies tokens to a tool runner as individual argv entries (no re-splitting). */
    applyTokens(tool: ToolRunner, tokens: string[]): void {
        for (const token of tokens) {
            tool.arg(token);
        }
    }

    appendTerraformVariables(terraformTool: ToolRunner): void {
        const variables = tasks.getInput("terraformVariables", false);
        if (!variables) return;

        for (const trimmed of splitNonEmptyLines(variables, { skipComments: true })) {
            terraformTool.arg('-var');
            terraformTool.arg(trimmed);
        }
    }
}
