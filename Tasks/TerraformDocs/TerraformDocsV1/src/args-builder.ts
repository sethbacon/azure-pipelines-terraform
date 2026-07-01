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
