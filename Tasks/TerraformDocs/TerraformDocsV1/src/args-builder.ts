export interface TerraformDocsConfig {
    /** The picklist formatter option (e.g. "markdown-table", "json"). */
    formatter: string;
    /** Directory terraform-docs scans; emitted last as the positional argument. */
    modulePath: string;
    /** Optional path to a .terraform-docs.yml configuration file (--config). */
    configFile?: string;
    /** Optional output file to write the generated documentation to (--output-file). */
    outputFile?: string;
    /** How to write the output file: "inject" or "replace" (--output-mode). */
    outputMode?: string;
    /** Fail if the output file is out of date rather than writing it (--output-check). */
    outputCheck?: boolean;
    /** Sort criteria: "name", "required", or "type" (--sort-by). */
    sortBy?: string;
    /** Recurse into submodules (--recursive). */
    recursive?: boolean;
    /** Submodule directory to recurse into (--recursive-path). */
    recursivePath?: string;
}

/**
 * Maps each picklist formatter option to the terraform-docs subcommand tokens.
 * Keeping this as the single source of truth means an unknown formatter fails
 * fast with a clear error rather than being passed through to the CLI.
 */
const FORMATTER_SUBCOMMANDS: Record<string, string[]> = {
    'markdown-table': ['markdown', 'table'],
    'markdown-document': ['markdown', 'document'],
    'json': ['json'],
    'yaml': ['yaml'],
    'toml': ['toml'],
    'pretty': ['pretty'],
    'asciidoc-table': ['asciidoc', 'table'],
    'asciidoc-document': ['asciidoc', 'document'],
    'tfvars-hcl': ['tfvars', 'hcl'],
    'tfvars-json': ['tfvars', 'json'],
};

/** Resolves a picklist formatter option to its terraform-docs subcommand tokens. */
export function resolveFormatter(formatter: string): string[] {
    const subcommand = FORMATTER_SUBCOMMANDS[formatter];
    if (!subcommand) {
        throw new Error(`Unsupported terraform-docs formatter: ${formatter}`);
    }
    return [...subcommand];
}

/** Minimal `fs.Stats` surface used to classify a candidate config-file path. */
export interface StatLike {
    isFile(): boolean;
    isDirectory(): boolean;
}

/** The `fs.statSync`-shaped dependency `sanitizeConfigFile` needs (injected for testability). */
export type StatSyncFn = (p: string) => StatLike;

/**
 * Validates and sanitizes the optional terraform-docs `--config` path.
 *
 * Azure Pipelines resolves an *unset* optional `filePath` input to the agent
 * working directory (`path.resolve(workingDir, '') === workingDir`), so a caller
 * that omits `configFile` still receives a non-empty value pointing at a
 * directory. Forwarding that verbatim as `terraform-docs --config <dir>` fails
 * with `Unsupported Config Type ""`. This guard fails closed on anything that is
 * not a genuine, existing regular file:
 *
 *  - `undefined` / empty / whitespace-only  -> `undefined` (emit no `--config`).
 *  - an existing **directory**               -> `undefined` (the empty-input
 *    artifact above; a directory is never a valid terraform-docs config).
 *  - an existing **regular file**            -> the trimmed path (a real config).
 *  - anything else — a non-existent path, a device/socket/FIFO, or a path that
 *    cannot be stat'd (e.g. contains a NUL byte) -> throws, so genuinely bad
 *    input is surfaced clearly instead of being silently dropped or passed
 *    through unvalidated.
 *
 * The returned value is only ever used as a single, separate `ToolRunner.arg()`
 * token (never concatenated into a shell command line), so there is no
 * argument/command-injection surface to escape here — the responsibility of this
 * function is strictly to reject non-file inputs.
 */
export function sanitizeConfigFile(raw: string | undefined | null, statSync: StatSyncFn): string | undefined {
    if (raw === undefined || raw === null) {
        return undefined;
    }

    const trimmed = raw.trim();
    if (trimmed.length === 0) {
        return undefined;
    }

    let stat: StatLike;
    try {
        stat = statSync(trimmed);
    } catch {
        // Non-existent / unstat-able path. The agent's empty-filePath -> working
        // directory resolution always yields an existing directory, so a path that
        // cannot be stat'd can only be a genuinely user-supplied (mistyped) value.
        throw new Error(`terraform-docs config file not found: ${trimmed}`);
    }

    if (stat.isDirectory()) {
        return undefined;
    }

    if (!stat.isFile()) {
        throw new Error(`terraform-docs config file is not a regular file: ${trimmed}`);
    }

    return trimmed;
}

/**
 * Builds the ordered terraform-docs argument list (excluding the binary itself and
 * any free-form additional arguments) for the given configuration. The module path
 * is emitted last as the positional argument terraform-docs scans.
 */
export function buildTerraformDocsArgs(config: TerraformDocsConfig): string[] {
    const args = resolveFormatter(config.formatter);

    if (config.configFile) {
        args.push('--config', config.configFile);
    }
    if (config.outputFile) {
        args.push('--output-file', config.outputFile);
        if (config.outputMode) {
            args.push('--output-mode', config.outputMode);
        }
    }
    if (config.outputCheck) {
        args.push('--output-check');
    }
    if (config.sortBy && config.sortBy !== 'default') {
        args.push('--sort-by', config.sortBy);
    }
    if (config.recursive) {
        args.push('--recursive');
        if (config.recursivePath) {
            args.push('--recursive-path', config.recursivePath);
        }
    }

    args.push(config.modulePath && config.modulePath.length > 0 ? config.modulePath : '.');
    return args;
}
