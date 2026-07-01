import { describe, it } from 'mocha';
import assert = require('assert');
import { resolveFormatter, buildTerraformDocsArgs, TerraformDocsConfig } from '../src/args-builder';

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

  it('emits the formatter tokens and the positional module path', () => {
    assert.deepStrictEqual(buildTerraformDocsArgs(base), ['markdown', 'table', '.']);
  });

  it('defaults the module path to "." when empty', () => {
    assert.deepStrictEqual(buildTerraformDocsArgs({ formatter: 'json', modulePath: '' }), ['json', '.']);
  });

  it('includes the config file when set', () => {
    assert.deepStrictEqual(
      buildTerraformDocsArgs({ ...base, configFile: '.terraform-docs.yml' }),
      ['markdown', 'table', '--config', '.terraform-docs.yml', '.']
    );
  });

  it('includes output-file and output-mode', () => {
    assert.deepStrictEqual(
      buildTerraformDocsArgs({ ...base, outputFile: 'README.md', outputMode: 'inject' }),
      ['markdown', 'table', '--output-file', 'README.md', '--output-mode', 'inject', '.']
    );
  });

  it('omits output-mode when there is no output file', () => {
    assert.deepStrictEqual(
      buildTerraformDocsArgs({ ...base, outputMode: 'replace' }),
      ['markdown', 'table', '.']
    );
  });

  it('adds --output-check', () => {
    assert.deepStrictEqual(
      buildTerraformDocsArgs({ ...base, outputFile: 'README.md', outputCheck: true }),
      ['markdown', 'table', '--output-file', 'README.md', '--output-check', '.']
    );
  });

  it('adds --sort-by when not the default ordering', () => {
    assert.deepStrictEqual(
      buildTerraformDocsArgs({ ...base, sortBy: 'required' }),
      ['markdown', 'table', '--sort-by', 'required', '.']
    );
  });

  it('omits --sort-by for the default ordering', () => {
    assert.deepStrictEqual(
      buildTerraformDocsArgs({ ...base, sortBy: 'default' }),
      ['markdown', 'table', '.']
    );
  });

  it('adds --recursive and --recursive-path', () => {
    assert.deepStrictEqual(
      buildTerraformDocsArgs({ ...base, recursive: true, recursivePath: 'modules' }),
      ['markdown', 'table', '--recursive', '--recursive-path', 'modules', '.']
    );
  });

  it('adds --recursive without a submodule path', () => {
    assert.deepStrictEqual(
      buildTerraformDocsArgs({ ...base, recursive: true }),
      ['markdown', 'table', '--recursive', '.']
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
      ['asciidoc', 'document', '--config', 'cfg.yml', '--output-file', 'README.adoc', '--output-mode', 'replace', '--output-check', '--sort-by', 'type', '--recursive', '--recursive-path', 'submodules', './modules/vpc']
    );
  });
});
