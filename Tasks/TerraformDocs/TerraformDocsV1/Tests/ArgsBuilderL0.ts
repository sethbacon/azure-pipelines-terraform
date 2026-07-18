import { describe, it } from 'mocha';
import assert = require('assert');
import { resolveFormatter, buildTerraformDocsArgs, buildModulePathArgs, sanitizeConfigFile, StatLike, StatSyncFn, TerraformDocsConfig } from '../src/args-builder';

// Direct (parent-process) unit tests for the pure argument-building logic. These
// cover every formatter mapping and flag branch that the MockTestRunner integration
// scenarios do not exercise individually.

describe('args-builder: resolveFormatter', () => {
  it('maps every supported formatter to its subcommand tokens', () => {
    assert.deepStrictEqual(resolveFormatter('markdown-table'), ['markdown', 'table']);
    assert.deepStrictEqual(resolveFormatter('markdown-document'), ['markdown', 'document']);
    assert.deepStrictEqual(resolveFormatter('json'), ['json']);
    assert.deepStrictEqual(resolveFormatter('yaml'), ['yaml']);
    assert.deepStrictEqual(resolveFormatter('toml'), ['toml']);
    assert.deepStrictEqual(resolveFormatter('pretty'), ['pretty']);
    assert.deepStrictEqual(resolveFormatter('asciidoc-table'), ['asciidoc', 'table']);
    assert.deepStrictEqual(resolveFormatter('asciidoc-document'), ['asciidoc', 'document']);
    assert.deepStrictEqual(resolveFormatter('tfvars-hcl'), ['tfvars', 'hcl']);
    assert.deepStrictEqual(resolveFormatter('tfvars-json'), ['tfvars', 'json']);
  });

  it('returns a fresh array (callers may safely mutate it)', () => {
    const a = resolveFormatter('json');
    a.push('mutated');
    assert.deepStrictEqual(resolveFormatter('json'), ['json']);
  });

  it('throws on an unsupported formatter', () => {
    assert.throws(() => resolveFormatter('bogus'), /Unsupported terraform-docs formatter: bogus/);
  });
});

describe('args-builder: buildTerraformDocsArgs', () => {
  const base: TerraformDocsConfig = { formatter: 'markdown-table', modulePath: '.' };

  it('emits only the formatter tokens (module path is built separately)', () => {
    assert.deepStrictEqual(buildTerraformDocsArgs(base), ['markdown', 'table']);
  });

  it('includes the config file when set', () => {
    assert.deepStrictEqual(
      buildTerraformDocsArgs({ ...base, configFile: '.terraform-docs.yml' }),
      ['markdown', 'table', '--config', '.terraform-docs.yml']
    );
  });

  it('includes output-file and output-mode', () => {
    assert.deepStrictEqual(
      buildTerraformDocsArgs({ ...base, outputFile: 'README.md', outputMode: 'inject' }),
      ['markdown', 'table', '--output-file', 'README.md', '--output-mode', 'inject']
    );
  });

  it('omits output-mode when there is no output file', () => {
    assert.deepStrictEqual(
      buildTerraformDocsArgs({ ...base, outputMode: 'replace' }),
      ['markdown', 'table']
    );
  });

  it('adds --output-check', () => {
    assert.deepStrictEqual(
      buildTerraformDocsArgs({ ...base, outputFile: 'README.md', outputCheck: true }),
      ['markdown', 'table', '--output-file', 'README.md', '--output-check']
    );
  });

  it('adds --sort-by when not the default ordering', () => {
    assert.deepStrictEqual(
      buildTerraformDocsArgs({ ...base, sortBy: 'required' }),
      ['markdown', 'table', '--sort-by', 'required']
    );
  });

  it('omits --sort-by for the default ordering', () => {
    assert.deepStrictEqual(
      buildTerraformDocsArgs({ ...base, sortBy: 'default' }),
      ['markdown', 'table']
    );
  });

  it('adds --recursive and --recursive-path', () => {
    assert.deepStrictEqual(
      buildTerraformDocsArgs({ ...base, recursive: true, recursivePath: 'modules' }),
      ['markdown', 'table', '--recursive', '--recursive-path', 'modules']
    );
  });

  it('adds --recursive without a submodule path', () => {
    assert.deepStrictEqual(
      buildTerraformDocsArgs({ ...base, recursive: true }),
      ['markdown', 'table', '--recursive']
    );
  });

  it('combines all options in a stable order', () => {
    assert.deepStrictEqual(
      buildTerraformDocsArgs({
        formatter: 'asciidoc-document',
        modulePath: './modules/vpc',
        configFile: 'cfg.yml',
        outputFile: 'README.adoc',
        outputMode: 'replace',
        outputCheck: true,
        sortBy: 'type',
        recursive: true,
        recursivePath: 'submodules',
      }),
      ['asciidoc', 'document', '--config', 'cfg.yml', '--output-file', 'README.adoc', '--output-mode', 'replace', '--output-check', '--sort-by', 'type', '--recursive', '--recursive-path', 'submodules']
    );
  });
});

describe('args-builder: buildModulePathArgs', () => {
  it('emits a `--` terminator before the module path', () => {
    assert.deepStrictEqual(buildModulePathArgs('.'), ['--', '.']);
  });

  it('defaults the module path to "." when empty', () => {
    assert.deepStrictEqual(buildModulePathArgs(''), ['--', '.']);
  });

  it('defaults the module path to "." when undefined', () => {
    assert.deepStrictEqual(buildModulePathArgs(undefined), ['--', '.']);
  });

  it('rejects a modulePath being misparsed as a flag by preceding it with -- (regression for #661)', () => {
    // Empirically verified against terraform-docs v0.24.0: `markdown table
    // -weird` fails with "unknown shorthand flag: 'w' in -weird", while
    // `markdown table -- -weird` succeeds.
    assert.deepStrictEqual(buildModulePathArgs('-weird'), ['--', '-weird']);
  });
});

describe('args-builder: sanitizeConfigFile', () => {
  const asFile: StatLike = { isFile: () => true, isDirectory: () => false };
  const asDir: StatLike = { isFile: () => false, isDirectory: () => true };
  const asOther: StatLike = { isFile: () => false, isDirectory: () => false };

  /** A statSync stub that always reports the given kind. */
  const statAs = (s: StatLike): StatSyncFn => () => s;
  /** A statSync stub that fails as if the path does not exist. */
  const statMissing: StatSyncFn = () => {
    const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  };

  it('returns undefined for undefined', () => {
    assert.strictEqual(sanitizeConfigFile(undefined, statAs(asFile)), undefined);
  });

  it('returns undefined for null', () => {
    assert.strictEqual(sanitizeConfigFile(null, statAs(asFile)), undefined);
  });

  it('returns undefined for an empty string (never calls statSync)', () => {
    let called = false;
    const spy: StatSyncFn = () => { called = true; return asFile; };
    assert.strictEqual(sanitizeConfigFile('', spy), undefined);
    assert.strictEqual(called, false, 'statSync must not be called for an empty input');
  });

  it('returns undefined for a whitespace-only string', () => {
    assert.strictEqual(sanitizeConfigFile('   \t  ', statAs(asFile)), undefined);
  });

  // The core regression: Azure Pipelines resolves an unset optional filePath
  // input to the working directory, so an omitted configFile arrives as a
  // directory. It must NOT be forwarded as `--config <dir>`.
  it('returns undefined when the path resolves to an existing directory', () => {
    assert.strictEqual(sanitizeConfigFile('/agent/_work/1/s', statAs(asDir)), undefined);
  });

  it('returns the path when it is an existing regular file', () => {
    assert.strictEqual(sanitizeConfigFile('.terraform-docs.yml', statAs(asFile)), '.terraform-docs.yml');
  });

  it('trims surrounding whitespace on a valid file path', () => {
    assert.strictEqual(sanitizeConfigFile('  cfg.yml  ', statAs(asFile)), 'cfg.yml');
  });

  it('throws a clear error when a genuinely-supplied path does not exist', () => {
    assert.throws(
      () => sanitizeConfigFile('./missing.yml', statMissing),
      /terraform-docs config file not found: \.\/missing\.yml/
    );
  });

  it('throws when the path exists but is not a regular file (e.g. a socket/device)', () => {
    assert.throws(
      () => sanitizeConfigFile('/dev/null', statAs(asOther)),
      /terraform-docs config file is not a regular file: \/dev\/null/
    );
  });

  it('produces no --config arg end-to-end when configFile is the working-directory artifact', () => {
    const configFile = sanitizeConfigFile('/agent/_work/1/s', statAs(asDir));
    const args = buildTerraformDocsArgs({ formatter: 'markdown-table', modulePath: '/agent/_work/1/s', configFile });
    assert.ok(!args.includes('--config'), 'no --config should be emitted for the directory artifact');
    assert.deepStrictEqual(args, ['markdown', 'table']);
  });
});
