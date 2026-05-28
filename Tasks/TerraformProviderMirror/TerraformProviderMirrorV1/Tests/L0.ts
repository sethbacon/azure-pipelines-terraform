import { describe, it } from 'mocha';
import assert = require('assert');
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
                /Only HTTPS URLs are allowed/
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
                /Invalid mirror URL/
            );
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

        it('should generate config with direct fallback (no patterns)', () => {
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
                '  direct {\n' +
                '  }\n' +
                '}\n'
            );
        });

        it('should generate config with exclude patterns', () => {
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
                '  direct {\n' +
                '    exclude = ["registry.terraform.io/company-internal/*"]\n' +
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

        it('should generate config with include patterns', () => {
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
                '  direct {\n' +
                '    include = ["registry.terraform.io/hashicorp/*"]\n' +
                '  }\n' +
                '}\n'
            );
        });

        it('should prefer include over exclude when both are provided', () => {
            const config: ProviderMirrorConfig = {
                mirrorUrl: 'https://registry.example.com',
                allowDirectFallback: true,
                directExcludePatterns: ['registry.terraform.io/foo/*'],
                directIncludePatterns: ['registry.terraform.io/hashicorp/*'],
            };

            const result = generateProviderInstallationConfig(config);

            assert.ok(result.includes('include = '));
            assert.ok(!result.includes('exclude = '));
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
    });
});
