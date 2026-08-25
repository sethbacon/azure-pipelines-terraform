import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import tasks = require('azure-pipelines-task-lib/task');
import { TerraformCommandHandlerOCI } from '../src/oci-terraform-command-handler';
import { TerraformAuthorizationCommandInitializer } from '../src/terraform-commands';
import { EnvironmentVariableHelper } from '@4cloudguru/pipeline-task-ado';
import { getSecureVarFileArgs, ISecureFileLoader } from '../src/secure-file-loader';
import { TEST_OCI_PRIVATE_KEY_PEM } from './test-oci-fixtures';

/**
 * CLASS TEST — "credential-bearing material reaches the build log in a form that
 * was never registered with tasks.setSecret() BEFORE the emission".
 *
 * Cross-repo twin of azure-pipelines-packer's
 * Tasks/PackerTask/PackerTaskV1/Tests/PreMaskingClassL0.ts. The class was
 * reported against the packer extension (#185, #195, #186, #193, #66) but the
 * two extensions are built to the same idioms and copy modules between each
 * other, so every mechanism was re-enumerated here and fixed at the same time.
 *
 *   M1  read-then-mask   — the value is logged by the read API itself
 *                          (tasks.getEndpointDataParameter debug-logs its result)
 *   M2  registration throws — setSecret() rejects CR/LF, so a whole-PEM
 *                          registration throws and registers NOTHING
 *   M3  wrong form registered — the emitted serialization (URL percent-encoding,
 *                          PEM normalization) differs byte-wise from the
 *                          registered one
 *   M4  never registered — secure var-file CONTENTS were never masked at all
 *   M5  credential-bearing URL — a pre-signed/userinfo URL is emitted before (or
 *                          without) its credential being registered/redacted
 *
 * Rows in THIS npm package are exercised behaviourally. Rows in the sibling
 * installer packages (separate npm packages that cannot be imported from here)
 * are asserted at source level against the same predicate the re-runnable class
 * signature uses: the guard construct must be present, and the pre-fix defect
 * shape must be absent. Inverting either guard turns its own row RED.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const TF_INSTALLER = path.join(REPO_ROOT, 'Tasks', 'TerraformInstaller', 'TerraformInstallerV1', 'src');
const POLICY_INSTALLER = path.join(REPO_ROOT, 'Tasks', 'PolicyAgentInstaller', 'PolicyAgentInstallerV1', 'src');
const DOCS_INSTALLER = path.join(REPO_ROOT, 'Tasks', 'TerraformDocsInstaller', 'TerraformDocsInstallerV1', 'src');

function readSource(file: string): string {
    return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

interface SourceSite {
    mechanism: 'M1' | 'M2' | 'M3' | 'M4' | 'M5';
    site: string;
    file: string;
    guard: RegExp;
    defect: RegExp;
}

/**
 * M3: the WHATWG URL setter percent-encodes the password, so the string the
 * dispatcher URL embeds is byte-different from the raw proxyPassword — the
 * agent's masker matches registered literals, never derivations of them.
 *
 * This class NO LONGER HAS A SOURCE ROW IN THIS REPO. Assembling the proxy URL,
 * registering every spelling it produced, and building the dispatcher all moved
 * into @4cloudguru/pipeline-task-ado's buildAdoFetchOptions, so the regexes that
 * used to pin the ordering here now match nothing — and a source assertion that
 * cannot fail is worse than no assertion, because it reads as coverage.
 *
 * What is still checkable from here is PROVENANCE: that each installer depends
 * on a version of the package known to contain the wiring AND the test that
 * asserts its ordering (both events share one log there, and the assertion is
 * that no dispatcher is constructed before the last setSecret). The floor below
 * is that check. See ADO_PACKAGE_FLOOR.
 */
const ADO_PACKAGE = '@4cloudguru/pipeline-task-ado';
const ADO_PACKAGE_FLOOR = '0.3.0';

/**
 * M5: the registry-supplied pre-signed download_url carries a live signing token
 * in its query string. The token registration must happen BEFORE the https-pin
 * rejection that interpolates that same URL into its message.
 */
const PRESIGNED_GUARD = /const urlTokenSecrets = extractUrlTokenSecrets\(data\.download_url\);[\s\S]{0,400}?tasks\.setSecret\(secret\);[\s\S]{0,400}?if \(!data\.download_url\.startsWith\('https:\/\/'\)\) \{\s*\n\s*throw new Error\(tasks\.loc\("InsecureUrlRejected", redactUrl\(data\.download_url\)\)\);/;
const PRESIGNED_DEFECT = /tasks\.loc\("InsecureUrlRejected", data\.download_url\)/;

const SOURCE_SITES: SourceSite[] = [
    {
        mechanism: 'M5',
        site: 'TerraformInstallerV1/src/terraform-installer.ts:downloadZipFromRegistry (pre-signed download_url)',
        file: path.join(TF_INSTALLER, 'terraform-installer.ts'),
        guard: PRESIGNED_GUARD,
        defect: PRESIGNED_DEFECT,
    },
    {
        mechanism: 'M5',
        site: 'PolicyAgentInstallerV1/src/policy-agent-installer.ts:downloadFromRegistry (pre-signed download_url)',
        file: path.join(POLICY_INSTALLER, 'policy-agent-installer.ts'),
        guard: PRESIGNED_GUARD,
        defect: PRESIGNED_DEFECT,
    },
    {
        mechanism: 'M5',
        site: 'TerraformDocsInstallerV1/src/terraform-docs-installer.ts:downloadFromRegistry (pre-signed download_url)',
        file: path.join(DOCS_INSTALLER, 'terraform-docs-installer.ts'),
        guard: PRESIGNED_GUARD,
        defect: PRESIGNED_DEFECT,
    },
    {
        mechanism: 'M5',
        site: 'TerraformInstallerV1/src/terraform-installer.ts:downloadZipFromRegistry/FromMirror (operator userinfo) — PRE-EXISTING GUARD',
        file: path.join(TF_INSTALLER, 'terraform-installer.ts'),
        // Already closed before this batch (#586); pinned here so the class test
        // fails if a later change drops it, rather than only covering what this
        // batch happened to touch.
        guard: /maskOperatorUrlCredentials\(registryUrl\);[\s\S]*maskOperatorUrlCredentials\(mirrorBaseUrl\);[\s\S]*tasks\.loc\("InsecureUrlRejected", redactUrlUserInfo\(mirrorBaseUrl\)\)/,
        defect: /tasks\.loc\("InsecureUrlRejected", mirrorBaseUrl\)|terraformDownloadedFrom', `(registry:\$\{registryUrl\}|mirror:\$\{mirrorBaseUrl\})`/,
    },
    {
        mechanism: 'M5',
        site: 'TerraformInstallerV1/src/terraform-installer.ts:downloadZipFromHashiCorp/downloadTofu (RECORDED EXEMPTION)',
        file: path.join(TF_INSTALLER, 'terraform-installer.ts'),
        // Exempt, and the exemption is asserted rather than asserted-away: these
        // two download URLs are built from hardcoded release-host literals plus a
        // validated version/platform/arch, so no operator input reaches them and
        // they can carry neither userinfo nor a signing token. If either constant
        // is ever replaced by an input-derived value this row goes RED and the
        // sites stop being exempt.
        guard: /return `https:\/\/releases\.hashicorp\.com\/terraform\/[\s\S]*const downloadUrl = `https:\/\/github\.com\/opentofu\/opentofu\/releases\/download\//,
        defect: /function getHashiCorpDownloadUrl\([\s\S]{0,400}?(registryUrl|mirrorBaseUrl|tasks\.getInput)|opentofu\/releases\/download\/v\$\{version\}[\s\S]{0,80}?(registryUrl|mirrorBaseUrl|tasks\.getInput)/,
    },
];

describe('Pre-mask defect class — credential emitted before it was registered as a secret', function () {
    this.timeout(15000);

    describe('source-level rows (sibling installer npm packages)', () => {
        for (const row of SOURCE_SITES) {
            it(`${row.mechanism} — ${row.site}`, () => {
                const source = readSource(row.file);
                assert.ok(
                    row.guard.test(source),
                    `guard missing or inverted at ${row.site}: ${row.guard}`,
                );
                assert.ok(
                    !row.defect.test(source),
                    `pre-fix defect shape is back at ${row.site}: ${row.defect}`,
                );
            });
        }
    });

    // M3's source rows are gone: the proxy URL assembly and the secret
    // registration that must precede it now live in pipeline-task-ado. Deleting
    // them without this would quietly retire the class from this repo, so what
    // replaces them is the one thing still checkable here — that every installer
    // consuming that wiring pins a version known to contain it, and the test
    // that asserts its ordering.
    describe('M3 — delegated to pipeline-task-ado, checked by version floor', () => {
        const installers: ReadonlyArray<readonly [string, string]> = [
            ['TerraformInstallerV1', path.join(TF_INSTALLER, '..', 'package.json')],
            ['PolicyAgentInstallerV1', path.join(POLICY_INSTALLER, '..', 'package.json')],
            ['TerraformDocsInstallerV1', path.join(DOCS_INSTALLER, '..', 'package.json')],
        ];

        for (const [name, manifest] of installers) {
            it(`${name} pins ${ADO_PACKAGE} >= ${ADO_PACKAGE_FLOOR}`, () => {
                const json = JSON.parse(fs.readFileSync(manifest, 'utf8'));
                const range: string | undefined = (json.dependencies || {})[ADO_PACKAGE];
                assert.ok(range, `${name} does not depend on ${ADO_PACKAGE}, so the proxy masking wiring has no declared source`);

                // Only a caret or exact range pins a floor that can be reasoned
                // about; `*` or a git URL cannot be shown to include the fix.
                const parsed = /^\^?(\d+)\.(\d+)\.(\d+)/.exec(range.trim());
                assert.ok(parsed, `${name} pins ${ADO_PACKAGE} as ${range}, which cannot be shown to include the masking fix`);

                const actual = parsed.slice(1, 4).map(Number);
                const floor = ADO_PACKAGE_FLOOR.split('.').map(Number);
                const ordered = actual[0] - floor[0] || actual[1] - floor[1] || actual[2] - floor[2];
                assert.ok(ordered >= 0, `${name} pins ${ADO_PACKAGE}@${range}, below the ${ADO_PACKAGE_FLOOR} floor that carries the pre-mask ordering`);
            });
        }
    });

    describe('behavioural rows (this npm package)', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
        const t = tasks as any;
        const orig = {
            setSecret: t.setSecret,
            debug: t.debug,
            warning: t.warning,
            getInput: t.getInput,
            getBoolInput: t.getBoolInput,
            getEndpointDataParameter: t.getEndpointDataParameter,
        };

        let setSecretCalls: string[] = [];
        let debugLines: string[] = [];
        let warnings: string[] = [];

        const PRIVATE_KEY_ENV = 'ENDPOINT_DATA_OCI_PRIVATEKEY';
        const endpointData: Record<string, string> = {
            tenancy: 'ocid1.tenancy.oc1..dummy',
            user: 'ocid1.user.oc1..dummy',
            region: 'us-ashburn-1',
            fingerprint: 'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99',
        };

        beforeEach(() => {
            setSecretCalls = [];
            debugLines = [];
            warnings = [];
            // Reproduce task-lib's real setSecret contract exactly: it THROWS on a
            // CR/LF-bearing value (LIB_MultilineSecret) rather than registering it.
            // That is what makes the M2 row mutation-provable.
            t.setSecret = (value: string) => {
                if (value && /\r|\n/.test(value)) {
                    throw new Error('LIB_MultilineSecret');
                }
                setSecretCalls.push(value);
            };
            t.debug = (message: string) => { debugLines.push(String(message)); };
            t.warning = (message: string) => { warnings.push(String(message)); };
            t.getInput = () => undefined;
            t.getBoolInput = () => false;
            // Non-secret OCI data parameters keep the ordinary accessor; only the
            // private key must bypass it. A stub that RECORDS the key would hide
            // the defect, so this one emits the same debug line task-lib does.
            t.getEndpointDataParameter = (id: string, key: string) => {
                const value = key === 'privateKey' ? process.env[PRIVATE_KEY_ENV] : endpointData[key];
                debugLines.push(`${id} data ${key} = ${value}`);
                return value;
            };
        });

        afterEach(() => {
            t.setSecret = orig.setSecret;
            t.debug = orig.debug;
            t.warning = orig.warning;
            t.getInput = orig.getInput;
            t.getBoolInput = orig.getBoolInput;
            t.getEndpointDataParameter = orig.getEndpointDataParameter;
            delete process.env[PRIVATE_KEY_ENV];
            EnvironmentVariableHelper.clearTrackedVariables();
        });

        it('M1 — TerraformTaskV5/src/oci-terraform-command-handler.ts:handleProvider (OCI privateKey endpoint DATA param)', async () => {
            process.env[PRIVATE_KEY_ENV] = TEST_OCI_PRIVATE_KEY_PEM;

            const handler = new TerraformCommandHandlerOCI();
            await handler.handleProvider(new TerraformAuthorizationCommandInitializer('plan', 'DummyWorkingDirectory', 'OCI'));

            // (a) The key must never have been emitted on a debug line. This is the
            //     whole of M1: tasks.getEndpointDataParameter() ends with
            //     debug(id + ' data ' + key + ' = ' + val), which fires at READ
            //     time — strictly before any setSecret the handler could make.
            const bodyLines = TEST_OCI_PRIVATE_KEY_PEM.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('-----'));
            assert.ok(bodyLines.length > 0, 'sanity: the fixture PEM has body lines');
            for (const line of bodyLines) {
                assert.ok(
                    !debugLines.some((d) => d.includes(line)),
                    'no ##vso[task.debug] line may contain the OCI private key body',
                );
            }

            // (b) The raw value must not survive in process.env: ENDPOINT_DATA_* is
            //     not vaulted by task-lib, so anything left there is inherited by
            //     the terraform child process and every provider plugin it forks.
            assert.strictEqual(process.env[PRIVATE_KEY_ENV], undefined,
                'the ENDPOINT_DATA_* private key must be deleted from the environment once read');

            handler.cleanupTempFiles();
        });

        it('M2 — TerraformTaskV5/src/oci-terraform-command-handler.ts:getPrivateKeyFilePath (genuine multi-line PEM)', async () => {
            // A service connection created via the REST API / az devops CLI (rather
            // than the UI passwordbox, which flattens newlines) delivers a real
            // multi-line PEM. A whole-value setSecret() throws on it — registering
            // NOTHING — so the handler must register line-wise.
            process.env[PRIVATE_KEY_ENV] = TEST_OCI_PRIVATE_KEY_PEM;

            const handler = new TerraformCommandHandlerOCI();
            await handler.handleProvider(new TerraformAuthorizationCommandInitializer('plan', 'DummyWorkingDirectory', 'OCI'));

            const rawLines = TEST_OCI_PRIVATE_KEY_PEM.split('\n').map((l) => l.trim()).filter((l) => l);
            for (const line of rawLines) {
                assert.ok(setSecretCalls.includes(line),
                    `raw PEM line must be registered: ${line.slice(0, 12)}...`);
            }

            // M3 in its PEM guise: normalizePem rewrites the key to a byte-different
            // on-disk form, which needs its own registration.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const tempFiles: readonly string[] = (handler as any).tempFileManager.tracked;
            assert.strictEqual(tempFiles.length, 1, 'exactly one tracked temp file: the OCI key');
            const onDisk = fs.readFileSync(tempFiles[0], 'utf8');
            const onDiskBody = onDisk.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('-----'));
            assert.ok(onDiskBody.length > 0, 'sanity: the normalized PEM has body lines');
            for (const line of onDiskBody) {
                assert.ok(setSecretCalls.includes(line),
                    `normalized on-disk PEM body line must be registered: ${line.slice(0, 12)}...`);
            }

            handler.cleanupTempFiles();
        });

        it('M4 — TerraformTaskV5/src/secure-file-loader.ts:getSecureVarFileArgs (secure var-file contents)', async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'premask-class-'));
            const varFile = path.join(dir, 'secrets.tfvars');
            const hclSecret = 'sup3r-s3cret-value-from-hcl';
            const jsonSecret = 'sup3r-s3cret-value-from-json';
            fs.writeFileSync(varFile, [
                '# a comment mentioning "not-a-secret-comment-token"',
                `api_token = "${hclSecret}"`,
                'replica_count = 3',
                'flags = ["alpha-flag", "beta-flag"]',
            ].join('\n'));

            const jsonFile = path.join(dir, 'secrets.tfvars.json');
            fs.writeFileSync(jsonFile, JSON.stringify({ nested: { api_token: jsonSecret }, count: 3 }));

            t.getInput = (name: string) => (name === 'secureVarsFile' ? 'secure-file-id' : undefined);

            const loaderFor = (filePath: string): ISecureFileLoader => ({
                downloadSecureFile: async () => filePath,
                deleteSecureFile: () => { /* cleanup is elsewhere */ },
            });

            const hclResult = await getSecureVarFileArgs(loaderFor(varFile));
            assert.strictEqual(hclResult?.varFileArg, `-var-file=${varFile}`);
            assert.ok(setSecretCalls.includes(hclSecret),
                'an HCL secure var-file value must be registered with the masker');
            assert.ok(setSecretCalls.includes('alpha-flag'),
                'list elements of a secure var-file value must be registered too');
            assert.ok(!setSecretCalls.includes('not-a-secret-comment-token'),
                'a quoted word inside a comment must not be registered (over-masking guard)');

            setSecretCalls = [];
            const jsonResult = await getSecureVarFileArgs(loaderFor(jsonFile));
            assert.strictEqual(jsonResult?.varFileArg, `-var-file=${jsonFile}`);
            assert.ok(setSecretCalls.includes(jsonSecret),
                'a nested JSON secure var-file value must be registered with the masker');

            // Best-effort contract: an unreadable file warns, it does not throw.
            setSecretCalls = [];
            await getSecureVarFileArgs(loaderFor(path.join(dir, 'does-not-exist.tfvars')));
            assert.ok(warnings.some((w) => w.includes('mask')),
                'an unreadable secure var file must warn rather than fail the task');

            fs.rmSync(dir, { recursive: true, force: true });
        });
    });
});
