import { before, describe, it } from 'mocha';
import assert = require('assert');
import * as ttm from 'azure-pipelines-task-lib/mock-test';
import path = require('path');
import os = require('os');
import fs = require('fs');
import './UrlSecretRedactionL0';
// Direct unit tests for this task's copy of the secure-temp writer (#628).
import './SecureTempL0';
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
            tr.errorIssues.some(e => e.indexOf('Invalid mirror URL') >= 0),
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
});
