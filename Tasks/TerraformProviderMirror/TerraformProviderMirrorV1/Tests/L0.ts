import { before, describe, it } from 'mocha';
import assert = require('assert');
import * as ttm from 'azure-pipelines-task-lib/mock-test';
import path = require('path');
import os = require('os');
import fs = require('fs');
// Direct unit tests for the shared url-secret-redaction module (#776).
import './UrlSecretRedactionL0';
// Direct unit tests for the shared secure-temp writer (#628).
import './SecureTempL0';
// End-to-end coverage for index.ts's SIGTERM/SIGINT/uncaughtException/
// unhandledRejection registration (#1113).
import './SignalHandlerL0';
import { generateProviderInstallationConfig, validateMirrorUrl, ProviderMirrorConfig } from '../src/config-generator';

describe('config-generator', () => {
    describe('validateMirrorUrl', () => {
        it('should accept valid HTTPS URLs', () => {
            assert.doesNotThrow(() => validateMirrorUrl('https://registry.example.com'));
            assert.doesNotThrow(() => validateMirrorUrl('https://registry.example.com/terraform/providers'));
            assert.doesNotThrow(() => validateMirrorUrl('https://registry.example.com:8443/path'));
        });

        it('should reject HTTP URLs', () => {
            assert.throws(
                () => validateMirrorUrl('http://registry.example.com'),
                /mirrorUrl must use https/
            );
        });

        it('should reject empty URLs', () => {
            assert.throws(
                () => validateMirrorUrl(''),
                /Mirror URL is required/
            );
        });

        it('should reject invalid URLs', () => {
            assert.throws(
                () => validateMirrorUrl('not-a-url'),
                /mirrorUrl is not a valid absolute URL/
            );
        });

        // #1110 finding 2 (class fix): Terraform appends the provider path to
        // this base, so a '?' or '#' in it retargets every lookup silently.
        it('should reject a URL carrying a query string or fragment', () => {
            for (const bad of ['https://registry.example.com/?x=', 'https://registry.example.com/mirror?token=1', 'https://registry.example.com/#frag']) {
                assert.throws(
                    () => validateMirrorUrl(bad),
                    /mirrorUrl must not carry a query string or fragment/,
                    `expected ${bad} to be rejected`
                );
            }
        });

        it('should keep accepting basic-auth userinfo, a documented internal-mirror pattern', () => {
            assert.doesNotThrow(() => validateMirrorUrl('https://user:pass@registry.example.com/mirror/'));
        });
    });

    describe('generateProviderInstallationConfig', () => {
        it('should generate config with mirror only (no direct fallback)', () => {
            const config: ProviderMirrorConfig = {
                mirrorUrl: 'https://registry.example.com/terraform/providers',
                allowDirectFallback: false,
                directExcludePatterns: [],
                directIncludePatterns: [],
            };

            const result = generateProviderInstallationConfig(config);

            assert.strictEqual(result,
                'provider_installation {\n' +
                '  network_mirror {\n' +
                '    url = "https://registry.example.com/terraform/providers/"\n' +
                '  }\n' +
                '}\n'
            );
        });

        // Previously asserted an empty `direct { }` beside the mirror, pinning the
        // defect of #1231 as if it were intended: both blocks matched every provider.
        it('should write no direct block when the mirror serves every provider', () => {
            const config: ProviderMirrorConfig = {
                mirrorUrl: 'https://registry.example.com',
                allowDirectFallback: true,
                directExcludePatterns: [],
                directIncludePatterns: [],
            };

            const result = generateProviderInstallationConfig(config);

            assert.strictEqual(result,
                'provider_installation {\n' +
                '  network_mirror {\n' +
                '    url = "https://registry.example.com/"\n' +
                '  }\n' +
                '}\n'
            );
        });

        // #1231: directExcludePatterns only narrows direct; it never moves a provider
        // out of the mirror, so with nothing outside the mirror there is nothing left
        // for direct to serve.
        it('should write no direct block for directExcludePatterns alone', () => {
            const config: ProviderMirrorConfig = {
                mirrorUrl: 'https://registry.example.com',
                allowDirectFallback: true,
                directExcludePatterns: ['registry.terraform.io/company-internal/*'],
                directIncludePatterns: [],
            };

            const result = generateProviderInstallationConfig(config);

            assert.strictEqual(result,
                'provider_installation {\n' +
                '  network_mirror {\n' +
                '    url = "https://registry.example.com/"\n' +
                '  }\n' +
                '}\n'
            );
        });

        it('should generate config with multiple exclude patterns', () => {
            const config: ProviderMirrorConfig = {
                mirrorUrl: 'https://registry.example.com',
                allowDirectFallback: true,
                directExcludePatterns: [
                    'registry.terraform.io/company-internal/*',
                    'registry.terraform.io/partner-org/*',
                ],
                directIncludePatterns: [],
            };

            const result = generateProviderInstallationConfig(config);

            assert.ok(result.includes('exclude = ["registry.terraform.io/company-internal/*", "registry.terraform.io/partner-org/*"]'));
        });

        // #1231 (and #960 before it): directIncludePatterns alone does not take a
        // provider away from the mirror, so the mirror stays its only source.
        it('should write no direct block for directIncludePatterns the mirror still serves', () => {
            const config: ProviderMirrorConfig = {
                mirrorUrl: 'https://registry.example.com',
                allowDirectFallback: true,
                directExcludePatterns: [],
                directIncludePatterns: ['registry.terraform.io/hashicorp/*'],
            };

            const result = generateProviderInstallationConfig(config);

            assert.strictEqual(result,
                'provider_installation {\n' +
                '  network_mirror {\n' +
                '    url = "https://registry.example.com/"\n' +
                '  }\n' +
                '}\n'
            );
        });

        // Previously asserted the opposite ("should prefer include over exclude"),
        // pinning the else-if defect of #872 as if it were intended behaviour.
        it('should emit both include and exclude when both are provided', () => {
            const config: ProviderMirrorConfig = {
                mirrorUrl: 'https://registry.example.com',
                allowDirectFallback: true,
                directExcludePatterns: ['registry.terraform.io/company-internal/*'],
                directIncludePatterns: ['registry.terraform.io/*/*'],
            };

            const result = generateProviderInstallationConfig(config);

            assert.strictEqual(result,
                'provider_installation {\n' +
                '  network_mirror {\n' +
                '    url = "https://registry.example.com/"\n' +
                '  }\n' +
                '  direct {\n' +
                '    include = ["registry.terraform.io/*/*"]\n' +
                '    exclude = ["registry.terraform.io/company-internal/*"]\n' +
                '  }\n' +
                '}\n'
            );
        });

        // #960: network_mirror was hard-coded to carry only `url`, so a provider
        // could never actually be excluded from the mirror -- directIncludePatterns
        // alone was ineffective because Terraform still consulted the mirror.
        it('should generate config with a mirror exclude pattern on the network_mirror block', () => {
            const config: ProviderMirrorConfig = {
                mirrorUrl: 'https://registry.example.com',
                allowDirectFallback: true,
                directExcludePatterns: [],
                directIncludePatterns: ['registry.terraform.io/hashicorp/aws'],
                mirrorExcludePatterns: ['registry.terraform.io/hashicorp/aws'],
                mirrorIncludePatterns: [],
            };

            const result = generateProviderInstallationConfig(config);

            assert.strictEqual(result,
                'provider_installation {\n' +
                '  network_mirror {\n' +
                '    url = "https://registry.example.com/"\n' +
                '    exclude = ["registry.terraform.io/hashicorp/aws"]\n' +
                '  }\n' +
                '  direct {\n' +
                '    include = ["registry.terraform.io/hashicorp/aws"]\n' +
                '  }\n' +
                '}\n'
            );
        });

        it('should generate config with a mirror include pattern on the network_mirror block', () => {
            const config: ProviderMirrorConfig = {
                mirrorUrl: 'https://registry.example.com',
                allowDirectFallback: false,
                directExcludePatterns: [],
                directIncludePatterns: [],
                mirrorExcludePatterns: [],
                mirrorIncludePatterns: ['registry.terraform.io/hashicorp/*'],
            };

            const result = generateProviderInstallationConfig(config);

            assert.strictEqual(result,
                'provider_installation {\n' +
                '  network_mirror {\n' +
                '    url = "https://registry.example.com/"\n' +
                '    include = ["registry.terraform.io/hashicorp/*"]\n' +
                '  }\n' +
                '}\n'
            );
        });

        it('should emit both mirror include and mirror exclude when both are provided', () => {
            const config: ProviderMirrorConfig = {
                mirrorUrl: 'https://registry.example.com',
                allowDirectFallback: false,
                directExcludePatterns: [],
                directIncludePatterns: [],
                mirrorExcludePatterns: ['registry.terraform.io/foo/*'],
                mirrorIncludePatterns: ['registry.terraform.io/hashicorp/*'],
            };

            const result = generateProviderInstallationConfig(config);

            assert.strictEqual(result,
                'provider_installation {\n' +
                '  network_mirror {\n' +
                '    url = "https://registry.example.com/"\n' +
                '    include = ["registry.terraform.io/hashicorp/*"]\n' +
                '    exclude = ["registry.terraform.io/foo/*"]\n' +
                '  }\n' +
                '}\n'
            );
        });

        it('should omit mirror include/exclude entirely when neither is set (back-compat with pre-#960 config)', () => {
            const config: ProviderMirrorConfig = {
                mirrorUrl: 'https://registry.example.com',
                allowDirectFallback: false,
                directExcludePatterns: [],
                directIncludePatterns: [],
            };

            const result = generateProviderInstallationConfig(config);

            assert.strictEqual(result,
                'provider_installation {\n' +
                '  network_mirror {\n' +
                '    url = "https://registry.example.com/"\n' +
                '  }\n' +
                '}\n'
            );
        });

        it('should strip trailing slashes from mirror URL before appending one', () => {
            const config: ProviderMirrorConfig = {
                mirrorUrl: 'https://registry.example.com/path/',
                allowDirectFallback: false,
                directExcludePatterns: [],
                directIncludePatterns: [],
            };

            const result = generateProviderInstallationConfig(config);

            assert.ok(result.includes('url = "https://registry.example.com/path/"'));
            assert.ok(!result.includes('url = "https://registry.example.com/path//"'));
        });

        it('should handle URL with multiple trailing slashes', () => {
            const config: ProviderMirrorConfig = {
                mirrorUrl: 'https://registry.example.com///',
                allowDirectFallback: false,
                directExcludePatterns: [],
                directIncludePatterns: [],
            };

            const result = generateProviderInstallationConfig(config);

            assert.ok(result.includes('url = "https://registry.example.com/"'));
        });

        it('should escape double quotes and newlines in include/exclude patterns to prevent HCL injection', () => {
            const malicious = 'registry.terraform.io/evil"]\n}\nprovider_installation "injected" {\n  x = "*';
            const config: ProviderMirrorConfig = {
                mirrorUrl: 'https://registry.example.com',
                allowDirectFallback: true,
                directExcludePatterns: [],
                directIncludePatterns: [malicious],
            };

            const result = generateProviderInstallationConfig(config);

            // The raw pattern must never be interpolated unescaped.
            assert.ok(!result.includes(`"${malicious}"`), 'pattern must not be interpolated unescaped');
            assert.ok(result.includes('\\"'), 'embedded quote must be escaped');
            assert.ok(result.includes('\\n'), 'embedded newline must be escaped');

            // The include assignment must remain a single well-formed HCL line —
            // no stray unescaped quote/newline breaking out of the array literal.
            const includeLineMatch = result.match(/^\s*include = \[.*\]$/m);
            assert.ok(includeLineMatch, 'include assignment must remain a single well-formed line');
        });

        it('should escape backslashes in include/exclude patterns', () => {
            const config: ProviderMirrorConfig = {
                mirrorUrl: 'https://registry.example.com',
                allowDirectFallback: true,
                directExcludePatterns: ['registry.terraform.io\\weird\\path\\*'],
                directIncludePatterns: [],
            };

            const result = generateProviderInstallationConfig(config);

            assert.ok(
                result.includes('exclude = ["registry.terraform.io\\\\weird\\\\path\\\\*"]'),
                `expected escaped backslashes, got: ${result}`
            );
        });

        it('should escape double quotes and newlines in mirrorUrl to prevent HCL injection', () => {
            // validateMirrorUrl() checks the parsed URL, but generateProviderInstallationConfig
            // interpolates the raw string -- a crafted value could still carry a literal quote
            // through to this point (e.g. from a different validation path, or future callers
            // that skip validateMirrorUrl). It must never be interpolated unescaped.
            const malicious = 'https://registry.example.com/evil"\n}\nprovider_installation "injected" {\n  x = "*';
            const config: ProviderMirrorConfig = {
                mirrorUrl: malicious,
                allowDirectFallback: false,
                directExcludePatterns: [],
                directIncludePatterns: [],
            };

            const result = generateProviderInstallationConfig(config);

            assert.ok(!result.includes(`"${malicious}/"`), 'mirrorUrl must not be interpolated unescaped');
            assert.ok(result.includes('\\"'), 'embedded quote in mirrorUrl must be escaped');
            assert.ok(result.includes('\\n'), 'embedded newline in mirrorUrl must be escaped');

            // The url assignment must remain a single well-formed HCL line.
            const urlLineMatch = result.match(/^\s*url = ".*"$/m);
            assert.ok(urlLineMatch, 'url assignment must remain a single well-formed line');
        });

        it('should escape ${ template interpolation syntax in include patterns', () => {
            const config: ProviderMirrorConfig = {
                mirrorUrl: 'https://registry.example.com',
                allowDirectFallback: true,
                directExcludePatterns: [],
                directIncludePatterns: ['registry.terraform.io/${evil}/*'],
            };

            const result = generateProviderInstallationConfig(config);

            // The raw single-$ form must not appear as the interpolated pattern --
            // only the doubled-$ escaped form (checked below) is acceptable.
            assert.ok(
                !result.includes('"registry.terraform.io/${evil}/*"'),
                'raw ${ must not reach the generated HCL as an unescaped interpolation'
            );
            assert.ok(
                result.includes('include = ["registry.terraform.io/$${evil}/*"]'),
                `expected $\{-escaped interpolation, got: ${result}`
            );
        });

        it('should escape %{ template directive syntax in exclude patterns', () => {
            const config: ProviderMirrorConfig = {
                mirrorUrl: 'https://registry.example.com',
                allowDirectFallback: true,
                directExcludePatterns: ['registry.terraform.io/%{if true}evil%{endif}/*'],
                directIncludePatterns: [],
            };

            const result = generateProviderInstallationConfig(config);

            // The raw single-% form must not appear as the interpolated pattern --
            // only the doubled-% escaped form (checked below) is acceptable.
            assert.ok(
                !result.includes('"registry.terraform.io/%{if true}evil%{endif}/*"'),
                'raw %{ must not reach the generated HCL as an unescaped directive'
            );
            assert.ok(
                result.includes('exclude = ["registry.terraform.io/%%{if true}evil%%{endif}/*"]'),
                `expected %%{-escaped directive, got: ${result}`
            );
        });

        it('should escape ${ and %{ in mirrorUrl mixed with quotes and backslashes', () => {
            const malicious = 'https://registry.example.com/${a}\\%{b}"c';
            const config: ProviderMirrorConfig = {
                mirrorUrl: malicious,
                allowDirectFallback: false,
                directExcludePatterns: [],
                directIncludePatterns: [],
            };

            const result = generateProviderInstallationConfig(config);

            // The raw single-$/% forms must not appear as the interpolated URL --
            // only the fully-escaped form (checked below) is acceptable.
            assert.ok(
                !result.includes('"https://registry.example.com/${a}'),
                'raw ${ must not reach the generated HCL as an unescaped interpolation'
            );
            assert.ok(
                result.includes('url = "https://registry.example.com/$${a}\\\\%%{b}\\"c/"'),
                `expected combined escaping of backslash/quote/\${/%{, got: ${result}`
            );

            // The url assignment must remain a single well-formed HCL line.
            const urlLineMatch = result.match(/^\s*url = ".*"$/m);
            assert.ok(urlLineMatch, 'url assignment must remain a single well-formed line');
        });

        it('should correctly escape a backslash immediately followed by ${ (order-sensitive case)', () => {
            // A literal backslash directly followed by "${" is the case where a naive
            // implementation could apply the two escaping passes in a way that
            // double-processes or drops characters. The backslash must double to "\\\\"
            // and the "${" must independently become "$${", regardless of pass order.
            const malicious = 'registry.terraform.io/\\${evil}/*';
            const config: ProviderMirrorConfig = {
                mirrorUrl: 'https://registry.example.com',
                allowDirectFallback: true,
                directExcludePatterns: [],
                directIncludePatterns: [malicious],
            };

            const result = generateProviderInstallationConfig(config);

            assert.ok(
                result.includes('include = ["registry.terraform.io/\\\\$${evil}/*"]'),
                `expected "\\${'${'}" to escape to "\\\\$${'$'}{", got: ${result}`
            );
        });

        it('should leave a benign mirror URL unchanged in the generated HCL', () => {
            const config: ProviderMirrorConfig = {
                mirrorUrl: 'https://registry.example.com/terraform/providers',
                allowDirectFallback: false,
                directExcludePatterns: [],
                directIncludePatterns: [],
            };

            const result = generateProviderInstallationConfig(config);

            assert.strictEqual(result,
                'provider_installation {\n' +
                '  network_mirror {\n' +
                '    url = "https://registry.example.com/terraform/providers/"\n' +
                '  }\n' +
                '}\n'
            );
        });

        // #1231: Terraform takes the union of the versions reported by every
        // installation method that matches a provider, selects the newest, and then
        // requires the first matching method -- the mirror -- to serve it. The
        // mirror's 404 for a version only the origin registry has is a query error,
        // not "not found", so init stops instead of moving on to direct. A direct
        // block must therefore never match a provider the mirror block also matches.
        describe('direct never matches a provider the mirror serves (#1231)', () => {
            const generate = (patterns: Partial<ProviderMirrorConfig>): string =>
                generateProviderInstallationConfig({
                    mirrorUrl: 'https://registry.example.com',
                    allowDirectFallback: true,
                    directExcludePatterns: [],
                    directIncludePatterns: [],
                    ...patterns,
                });
            const mirrorBlock = (lines: string[]): string =>
                'provider_installation {\n' +
                '  network_mirror {\n' +
                '    url = "https://registry.example.com/"\n' +
                lines.map(line => `    ${line}\n`).join('') +
                '  }\n';
            const directBlock = (lines: string[]): string =>
                '  direct {\n' + lines.map(line => `    ${line}\n`).join('') + '  }\n';

            it('sends only the providers left out of mirrorIncludePatterns to direct', () => {
                const result = generate({ mirrorIncludePatterns: ['registry.terraform.io/hashicorp/*'] });

                assert.strictEqual(result,
                    mirrorBlock(['include = ["registry.terraform.io/hashicorp/*"]']) +
                    directBlock(['exclude = ["registry.terraform.io/hashicorp/*"]']) +
                    '}\n'
                );
            });

            it('sends only the providers in mirrorExcludePatterns to direct', () => {
                const result = generate({ mirrorExcludePatterns: ['registry.terraform.io/hashicorp/aws'] });

                assert.strictEqual(result,
                    mirrorBlock(['exclude = ["registry.terraform.io/hashicorp/aws"]']) +
                    directBlock(['include = ["registry.terraform.io/hashicorp/aws"]']) +
                    '}\n'
                );
            });

            // One direct block cannot say "outside the include list, or on the exclude
            // list": exclude wins over include within a block. Terraform accepts any
            // number of blocks of a method, so each way out of the mirror gets its own.
            it('writes one direct block for each way a provider can be outside the mirror', () => {
                const result = generate({
                    mirrorIncludePatterns: ['registry.terraform.io/hashicorp/*'],
                    mirrorExcludePatterns: ['registry.terraform.io/hashicorp/aws'],
                });

                assert.strictEqual(result,
                    mirrorBlock([
                        'include = ["registry.terraform.io/hashicorp/*"]',
                        'exclude = ["registry.terraform.io/hashicorp/aws"]',
                    ]) +
                    directBlock(['exclude = ["registry.terraform.io/hashicorp/*"]']) +
                    directBlock(['include = ["registry.terraform.io/hashicorp/aws"]']) +
                    '}\n'
                );
            });

            it('keeps directExcludePatterns on every direct block', () => {
                const result = generate({
                    mirrorIncludePatterns: ['registry.terraform.io/hashicorp/*'],
                    mirrorExcludePatterns: ['registry.terraform.io/hashicorp/aws'],
                    directExcludePatterns: ['registry.terraform.io/company-internal/*'],
                });

                assert.strictEqual(result,
                    mirrorBlock([
                        'include = ["registry.terraform.io/hashicorp/*"]',
                        'exclude = ["registry.terraform.io/hashicorp/aws"]',
                    ]) +
                    directBlock(['exclude = ["registry.terraform.io/company-internal/*", "registry.terraform.io/hashicorp/*"]']) +
                    directBlock([
                        'include = ["registry.terraform.io/hashicorp/aws"]',
                        'exclude = ["registry.terraform.io/company-internal/*"]',
                    ]) +
                    '}\n'
                );
            });

            it('narrows direct to the part of directIncludePatterns the mirror gave up', () => {
                const narrowerInclude = generate({
                    mirrorExcludePatterns: ['registry.terraform.io/hashicorp/*'],
                    directIncludePatterns: ['registry.terraform.io/hashicorp/aws'],
                });
                const broaderInclude = generate({
                    mirrorExcludePatterns: ['registry.terraform.io/hashicorp/aws'],
                    directIncludePatterns: ['registry.terraform.io/hashicorp/*'],
                });

                assert.strictEqual(narrowerInclude,
                    mirrorBlock(['exclude = ["registry.terraform.io/hashicorp/*"]']) +
                    directBlock(['include = ["registry.terraform.io/hashicorp/aws"]']) +
                    '}\n'
                );
                assert.strictEqual(broaderInclude,
                    mirrorBlock(['exclude = ["registry.terraform.io/hashicorp/aws"]']) +
                    directBlock(['include = ["registry.terraform.io/hashicorp/aws"]']) +
                    '}\n'
                );
            });

            // Terraform reads a two-segment pattern as registry.terraform.io/<ns>/<type>
            // and compares provider addresses in lower case, so these two are one pattern.
            it('compares patterns the way Terraform does: default host, any letter case', () => {
                const result = generate({
                    mirrorExcludePatterns: ['registry.terraform.io/hashicorp/aws'],
                    directIncludePatterns: ['HashiCorp/AWS'],
                });

                assert.strictEqual(result,
                    mirrorBlock(['exclude = ["registry.terraform.io/hashicorp/aws"]']) +
                    directBlock(['include = ["registry.terraform.io/hashicorp/aws"]']) +
                    '}\n'
                );
            });

            // The trap in dropping patterns: a block left with no include list at all
            // would match every provider. With nothing left to include there is no block.
            it('writes no direct block when every directIncludePatterns entry is inside the mirror', () => {
                const result = generate({
                    mirrorIncludePatterns: ['registry.terraform.io/hashicorp/*'],
                    directIncludePatterns: ['registry.terraform.io/hashicorp/aws'],
                });

                assert.strictEqual(result,
                    mirrorBlock(['include = ["registry.terraform.io/hashicorp/*"]']) +
                    '}\n'
                );
            });

            it('keeps only the directIncludePatterns entries that reach outside the mirror', () => {
                const result = generate({
                    mirrorIncludePatterns: ['registry.terraform.io/hashicorp/*'],
                    directIncludePatterns: ['registry.terraform.io/hashicorp/aws', 'example.com/acme/*'],
                });

                assert.strictEqual(result,
                    mirrorBlock(['include = ["registry.terraform.io/hashicorp/*"]']) +
                    directBlock([
                        'include = ["example.com/acme/*"]',
                        'exclude = ["registry.terraform.io/hashicorp/*"]',
                    ]) +
                    '}\n'
                );
            });

            // The class, not the examples: an independent reading of Terraform's own
            // matching rules (ParseMultiSourceMatchingPatterns and CanHandleProvider in
            // internal/getproviders/multi_source.go) applied to the generated file, for
            // every combination of short pattern lists.
            it('gives each provider to the mirror or to direct, never both, for every combination of patterns', function () {
                this.timeout(60000);

                type Address = [string, string, string];
                const parsePattern = (pattern: string): Address => {
                    const parts = pattern.toLowerCase().split('/');
                    return (parts.length === 2 ? ['registry.terraform.io', ...parts] : parts) as Address;
                };
                const matchesAny = (patterns: string[], provider: Address): boolean =>
                    patterns.map(parsePattern).some(pattern => pattern.every((segment, i) => segment === '*' || segment === provider[i]));
                const canHandle = (include: string[], exclude: string[], provider: Address): boolean =>
                    !matchesAny(exclude, provider) && (include.length === 0 || matchesAny(include, provider));

                interface Method { type: string; include: string[]; exclude: string[] }
                const parseMethods = (hcl: string): Method[] => {
                    const methods: Method[] = [];
                    for (const line of hcl.split('\n')) {
                        const open = /^ {2}(network_mirror|direct) \{$/.exec(line);
                        if (open) {
                            methods.push({ type: open[1], include: [], exclude: [] });
                            continue;
                        }
                        const list = /^ {4}(include|exclude) = (\[.*\])$/.exec(line);
                        if (list) {
                            methods[methods.length - 1][list[1] as 'include' | 'exclude'] = JSON.parse(list[2]);
                        }
                    }
                    return methods;
                };

                const pool = [
                    '*/*/*',
                    'registry.terraform.io/*/*',
                    'registry.terraform.io/hashicorp/*',
                    'registry.terraform.io/hashicorp/aws',
                    'HashiCorp/AzureRM',
                    'example.com/acme/*',
                ];
                const providers: Address[] = [
                    ['registry.terraform.io', 'hashicorp', 'aws'],
                    ['registry.terraform.io', 'hashicorp', 'azurerm'],
                    ['registry.terraform.io', 'hashicorp', 'random'],
                    ['registry.terraform.io', 'company-internal', 'widget'],
                    ['example.com', 'acme', 'widget'],
                    ['example.com', 'other', 'thing'],
                ];
                // Every list of at most two patterns from the pool.
                const lists: string[][] = [[]];
                pool.forEach((first, i) => {
                    lists.push([first]);
                    pool.slice(i + 1).forEach(second => lists.push([first, second]));
                });
                const shortLists: string[][] = [[], ...pool.map(pattern => [pattern])];

                let checked = 0;
                for (const mirrorIncludePatterns of lists) {
                    for (const mirrorExcludePatterns of lists) {
                        for (const directIncludePatterns of lists) {
                            for (const directExcludePatterns of shortLists) {
                                const config = { mirrorIncludePatterns, mirrorExcludePatterns, directIncludePatterns, directExcludePatterns };
                                const methods = parseMethods(generate(config));
                                const mirrors = methods.filter(method => method.type === 'network_mirror');
                                const directs = methods.filter(method => method.type === 'direct');
                                assert.strictEqual(mirrors.length, 1, `expected one network_mirror block for ${JSON.stringify(config)}`);

                                for (const provider of providers) {
                                    const inMirror = canHandle(mirrorIncludePatterns, mirrorExcludePatterns, provider);
                                    const wantedDirect = canHandle(directIncludePatterns, directExcludePatterns, provider);
                                    const viaMirror = canHandle(mirrors[0].include, mirrors[0].exclude, provider);
                                    const viaDirect = directs.some(method => canHandle(method.include, method.exclude, provider));

                                    if (viaMirror !== inMirror || viaDirect !== (wantedDirect && !inMirror)) {
                                        assert.fail(
                                            `${provider.join('/')} with ${JSON.stringify(config)}: ` +
                                            `mirror ${viaMirror} (want ${inMirror}), direct ${viaDirect} (want ${wantedDirect && !inMirror})`
                                        );
                                    }
                                    checked++;
                                }
                            }
                        }
                    }
                }

                // Measured, so that a pool or loop that silently shrank cannot pass as a clean run.
                assert.strictEqual(checked, 447216);
            });
        });
    });
});

describe('index entrypoint (mock run)', function () {
    this.timeout(20000);

    before(() => {
        // MockTestRunner shells out to node; point it at the current interpreter.
        (ttm.MockTestRunner.prototype as unknown as { getNodePath: () => string }).getNodePath = function () {
            return process.execPath;
        };
    });

    it('writes .terraformrc, sets TF_CLI_CONFIG_FILE, and succeeds for a valid mirror URL', async () => {
        const tp = path.join(__dirname, 'MirrorConfigSuccess.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        assert.ok(tr.succeeded, 'task should have succeeded. stderr: ' + tr.stderr);
        assert.strictEqual(tr.errorIssues.length, 0, 'should have no error issues: ' + tr.errorIssues);

        // The TF_CLI_CONFIG_FILE variable is emitted as a logging command on stdout.
        assert.ok(
            tr.stdout.indexOf('##vso[task.setvariable variable=TF_CLI_CONFIG_FILE') >= 0,
            'stdout should set the TF_CLI_CONFIG_FILE variable. stdout: ' + tr.stdout
        );

        // The task wrote .terraformrc into the mocked Agent.TempDirectory.
        const configPath = path.join(os.tmpdir(), 'tpm-success', '.terraformrc');
        assert.ok(fs.existsSync(configPath), 'expected .terraformrc at ' + configPath);
        const written = fs.readFileSync(configPath, 'utf8');
        assert.ok(
            written.includes('provider_installation {'),
            'generated config should contain a provider_installation block. got: ' + written
        );
    });

    // #1231: a pipeline that sets only mirrorUrl. Both blocks used to match every
    // provider, so init failed whenever the origin registry listed a version the
    // mirror had not published yet.
    it('writes no direct block when only mirrorUrl is set', async () => {
        const tp = path.join(__dirname, 'MirrorConfigDefaultsMirrorOnly.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        assert.ok(tr.succeeded, 'task should have succeeded. stderr: ' + tr.stderr);
        assert.strictEqual(tr.errorIssues.length, 0, 'should have no error issues: ' + tr.errorIssues);

        const configPath = path.join(os.tmpdir(), 'tpm-defaults-mirror-only', '.terraformrc');
        assert.ok(fs.existsSync(configPath), 'expected .terraformrc at ' + configPath);
        assert.strictEqual(fs.readFileSync(configPath, 'utf8'),
            'provider_installation {\n' +
            '  network_mirror {\n' +
            '    url = "https://registry.example.com/terraform/providers/"\n' +
            '  }\n' +
            '}\n'
        );
    });

    // #586: a mirror URL that embeds basic-auth userinfo. The generated .terraformrc
    // must keep the credential (terraform needs it to reach the mirror), but the
    // console echo of the config must be userinfo-stripped and the credential must be
    // registered as a secret.
    it('redacts embedded userinfo from the console echo but keeps it in the config file', async () => {
        const tp = path.join(__dirname, 'MirrorConfigUserInfoRedacted.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        assert.ok(tr.succeeded, 'task should have succeeded. stderr: ' + tr.stderr);
        assert.strictEqual(tr.errorIssues.length, 0, 'should have no error issues: ' + tr.errorIssues);

        // The embedded password is registered as a secret so the agent masks it.
        assert.ok(
            tr.stdout.includes('##vso[task.setsecret]s3cr3t'),
            'the embedded password should be registered as a secret. stdout: ' + tr.stdout
        );

        // The FILE on disk keeps the real credential — terraform needs it to auth.
        const configPath = path.join(os.tmpdir(), 'tpm-userinfo', '.terraformrc');
        assert.ok(fs.existsSync(configPath), 'expected .terraformrc at ' + configPath);
        const written = fs.readFileSync(configPath, 'utf8');
        assert.ok(
            written.includes('user:s3cr3t@mirror.example.com'),
            'the written config must retain the mirror credential. got: ' + written
        );

        // The echoed "Generated configuration" block must show the userinfo-stripped
        // URL. If it echoed the raw HCL, this exact stripped url line would be absent.
        const marker = '--- Generated configuration ---';
        const idx = tr.stdout.indexOf(marker);
        assert.ok(idx >= 0, 'expected the generated-config echo. stdout: ' + tr.stdout);
        const echoed = tr.stdout.slice(idx);
        assert.ok(
            echoed.includes('url = "https://mirror.example.com/terraform/providers/"'),
            'echoed config should show the userinfo-stripped mirror URL. echoed: ' + echoed
        );
        assert.ok(
            !echoed.includes('user:s3cr3t'),
            'echoed config must not contain the raw credential. echoed: ' + echoed
        );
    });

    it('fails with an error issue for an invalid mirror URL', async () => {
        const tp = path.join(__dirname, 'MirrorConfigInvalidUrlFail.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        assert.ok(tr.failed, 'task should have failed. stdout: ' + tr.stdout);
        assert.ok(tr.errorIssues.length > 0, 'should have at least one error issue');
        assert.ok(
            tr.errorIssues.some(e => e.indexOf('mirrorUrl is not a valid absolute URL') >= 0),
            'error should mention an invalid mirror URL: ' + tr.errorIssues
        );
    });

    // #508: neither Agent.TempDirectory nor AGENT_TEMPDIRECTORY is set -- the task
    // must fail closed with a clear error instead of silently writing .terraformrc
    // to a hardcoded, non-agent-managed '/tmp'.
    it('fails with an error issue when no agent temp directory is available', async () => {
        const tp = path.join(__dirname, 'MirrorConfigNoTempDirFail.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        assert.ok(tr.failed, 'task should have failed. stdout: ' + tr.stdout);
        assert.ok(tr.errorIssues.length > 0, 'should have at least one error issue');
        assert.ok(
            tr.errorIssues.some(e => e.indexOf('AgentTempDirectoryNotSet') >= 0),
            'error should fail via the missing agent temp directory check: ' + tr.errorIssues
        );
    });

    // #960: mirrorExcludePatterns must actually reach the network_mirror block so a
    // direct-include override can genuinely bypass the mirror for that provider.
    it('writes a network_mirror exclude entry when mirrorExcludePatterns is set', async () => {
        const tp = path.join(__dirname, 'MirrorConfigMirrorExcludeSuccess.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        assert.ok(tr.succeeded, 'task should have succeeded. stderr: ' + tr.stderr);
        assert.strictEqual(tr.errorIssues.length, 0, 'should have no error issues: ' + tr.errorIssues);
        assert.strictEqual(tr.warningIssues.length, 0, 'should have no warning issues: ' + tr.warningIssues);

        const configPath = path.join(os.tmpdir(), 'tpm-mirror-exclude', '.terraformrc');
        assert.ok(fs.existsSync(configPath), 'expected .terraformrc at ' + configPath);
        const written = fs.readFileSync(configPath, 'utf8');
        const mirrorBlock = written.slice(written.indexOf('network_mirror'), written.indexOf('direct {'));
        assert.ok(
            mirrorBlock.includes('exclude = ["registry.terraform.io/hashicorp/aws"]'),
            'network_mirror block should exclude the direct-included provider. got: ' + written
        );
    });

    // #960: directIncludePatterns alone never bypasses the mirror -- the task must
    // warn when it is set without a matching mirrorExcludePatterns entry.
    it('warns when directIncludePatterns has no matching mirrorExcludePatterns entry', async () => {
        const tp = path.join(__dirname, 'MirrorConfigDirectIncludeWarnsWithoutMirrorExclude.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        assert.ok(tr.succeeded, 'task should have succeeded. stderr: ' + tr.stderr);
        assert.ok(tr.warningIssues.length > 0, 'should have at least one warning issue');
        assert.ok(
            tr.warningIssues.some(w => w.indexOf('registry.terraform.io/hashicorp/time') >= 0),
            'warning should name the unexcluded provider: ' + tr.warningIssues
        );
    });
});
