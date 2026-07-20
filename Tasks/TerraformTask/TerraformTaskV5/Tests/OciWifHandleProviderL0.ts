import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import tasks = require('azure-pipelines-task-lib/task');
import idTokenGeneratorModule = require('../src/id-token-generator');
import ociTokenExchangeModule = require('../src/oci-token-exchange');
import secureTempModule = require('../src/secure-temp');
import { TerraformCommandHandlerOCI } from '../src/oci-terraform-command-handler';
import { TerraformAuthorizationCommandInitializer } from '../src/terraform-commands';
import { EnvironmentVariableHelper } from '../src/environment-variables';

/**
 * Direct unit tests for handleProviderWIF (#680) -- the OCI Workload Identity
 * Federation auth path. Unlike the OCIPlanWIFSuccess MockTestRunner scenario
 * (which only asserts a coarse task-succeeded string), these tests call the
 * handler directly and assert on the generated config file's exact content,
 * the fingerprint's MD5 correctness against the REAL generated keypair, the
 * per-line setSecret() masking of the ephemeral private key, and that a
 * secret file already written before a later write fails is still cleaned up.
 *
 * Only the two network-hop helpers (generateIdToken, exchangeOidcForUpst) are
 * stubbed by monkey-patching the required CommonJS module objects (the same
 * technique RunAzLoginL0.ts uses for task-lib) -- the ephemeral RSA-2048
 * keypair generation, MD5 fingerprint computation, and writeSecretFile calls
 * all run for real against a real scratch temp dir (os.tmpdir(), via the
 * real resolveWifTempDir() fallback).
 */
describe('handleProviderWIF -- OCI WIF config content, fingerprint, secret masking & cleanup ordering (#680)', function () {
    this.timeout(10000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch shared modules
    const t = tasks as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const itg = idTokenGeneratorModule as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ote = ociTokenExchangeModule as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const st = secureTempModule as any;

    const orig = {
        debug: t.debug,
        warning: t.warning,
        setSecret: t.setSecret,
        getInput: t.getInput,
        generateIdToken: itg.generateIdToken,
        exchangeOidcForUpst: ote.exchangeOidcForUpst,
        writeSecretFile: st.writeSecretFile,
    };

    const setSecretCalls: string[] = [];
    const INPUTS: Record<string, string> = {
        ociWifIdentityDomainUrl: 'https://idcs-dummy.identity.oraclecloud.com',
        ociWifClientId: 'dummy-client-id',
        ociWifTenancyOcid: 'ocid1.tenancy.oc1..dummy',
        ociWifRegion: 'us-ashburn-1',
    };

    beforeEach(() => {
        setSecretCalls.length = 0;
        t.debug = () => { /* silence */ };
        t.warning = () => { /* silence */ };
        t.setSecret = (s: string) => { setSecretCalls.push(s); };
        t.getInput = (name: string) => INPUTS[name];
        itg.generateIdToken = async () => 'mock-oidc-token-12345';
        ote.exchangeOidcForUpst = async () => 'mock-upst-token-67890';
    });

    afterEach(() => {
        t.debug = orig.debug;
        t.warning = orig.warning;
        t.setSecret = orig.setSecret;
        t.getInput = orig.getInput;
        itg.generateIdToken = orig.generateIdToken;
        ote.exchangeOidcForUpst = orig.exchangeOidcForUpst;
        st.writeSecretFile = orig.writeSecretFile;
        EnvironmentVariableHelper.clearTrackedVariables();
    });

    function makeCommand(): TerraformAuthorizationCommandInitializer {
        return new TerraformAuthorizationCommandInitializer('plan', 'DummyWorkingDirectory', 'OCI');
    }

    it('writes a config file with the exact tenancy/region/key_file/fingerprint/security_token_file content, matching the real ephemeral keypair', async () => {
        const handler = new TerraformCommandHandlerOCI();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (handler as any).handleProviderWIF(makeCommand());

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tempFiles: string[] = (handler as any).tempFiles;
        assert.strictEqual(tempFiles.length, 3, 'private key, UPST, and config -- exactly 3 tracked temp files');
        const [privateKeyPath, upstPath, configPath] = tempFiles;

        assert.ok(path.basename(privateKeyPath).startsWith('oci-wif-key-'));
        assert.ok(path.basename(upstPath).startsWith('oci-wif-upst-'));
        assert.ok(path.basename(configPath).startsWith('oci-wif-config-'));

        // Independently re-derive the fingerprint from the REAL generated
        // private key file to prove the config's fingerprint= line is
        // actually correct, not merely present.
        const privateKeyPem = fs.readFileSync(privateKeyPath, 'utf-8');
        const publicKeyDer = crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' });
        const expectedFingerprint = crypto.createHash('md5').update(publicKeyDer).digest('hex').match(/.{2}/g)!.join(':');

        const configContent = fs.readFileSync(configPath, 'utf-8');
        assert.strictEqual(
            configContent,
            [
                '[DEFAULT]',
                'tenancy=ocid1.tenancy.oc1..dummy',
                'region=us-ashburn-1',
                `key_file=${privateKeyPath}`,
                `fingerprint=${expectedFingerprint}`,
                `security_token_file=${upstPath}`,
            ].join('\n') + '\n',
        );

        assert.strictEqual(fs.readFileSync(upstPath, 'utf-8'), 'mock-upst-token-67890');

        assert.strictEqual(process.env['OCI_CLI_CONFIG_FILE'], configPath);
        assert.strictEqual(process.env['OCI_CLI_PROFILE'], 'DEFAULT');
        assert.strictEqual(process.env['OCI_CLI_AUTH'], 'security_token');
        assert.strictEqual(process.env['TF_VAR_tenancy_ocid'], 'ocid1.tenancy.oc1..dummy');
        assert.strictEqual(process.env['TF_VAR_region'], 'us-ashburn-1');

        handler.cleanupTempFiles();
    });

    it('setSecret()s every non-boundary line of the real ephemeral private key, plus the OIDC token and the UPST', async () => {
        const handler = new TerraformCommandHandlerOCI();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (handler as any).handleProviderWIF(makeCommand());

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tempFiles: string[] = (handler as any).tempFiles;
        const privateKeyPem = fs.readFileSync(tempFiles[0], 'utf-8');
        const nonBoundaryLines = privateKeyPem.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('-----'));
        assert.ok(nonBoundaryLines.length > 0, 'sanity: the real PEM has body lines to mask');
        for (const line of nonBoundaryLines) {
            assert.ok(setSecretCalls.includes(line), `PEM body line must be masked: ${line.slice(0, 12)}...`);
        }
        assert.ok(setSecretCalls.includes('mock-oidc-token-12345'), 'the OIDC token must be masked');
        assert.ok(setSecretCalls.includes('mock-upst-token-67890'), 'the UPST must be masked');

        handler.cleanupTempFiles();
    });

    it('leaves already-written secret files cleaned up when a later writeSecretFile call fails (cleanup ordering)', async () => {
        let writeCalls = 0;
        st.writeSecretFile = (filePath: string, content: string) => {
            writeCalls++;
            if (writeCalls === 3) {
                throw new Error('simulated disk failure on the third write');
            }
            return orig.writeSecretFile(filePath, content);
        };

        const handler = new TerraformCommandHandlerOCI();
        await assert.rejects(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (handler as any).handleProviderWIF(makeCommand()),
            /simulated disk failure/,
        );

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tempFiles: string[] = (handler as any).tempFiles;
        assert.strictEqual(tempFiles.length, 2, 'the private key and UPST were tracked before the third call threw');
        for (const f of tempFiles) {
            assert.ok(fs.existsSync(f), `file written before the failure must still exist prior to cleanup: ${f}`);
        }

        handler.cleanupTempFiles();
        for (const f of tempFiles) {
            assert.ok(!fs.existsSync(f), `cleanupTempFiles() must remove the file written before the failure: ${f}`);
        }
    });
});
