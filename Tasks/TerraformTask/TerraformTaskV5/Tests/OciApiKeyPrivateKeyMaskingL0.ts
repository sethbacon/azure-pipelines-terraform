import * as assert from 'assert';
import * as fs from 'fs';
import tasks = require('azure-pipelines-task-lib/task');
import { TerraformCommandHandlerOCI } from '../src/oci-terraform-command-handler';
import { TerraformAuthorizationCommandInitializer } from '../src/terraform-commands';
import { EnvironmentVariableHelper } from '@4cloudguru/pipeline-task-ado';
import {
    TEST_OCI_PRIVATE_KEY_SPACES,
    TEST_OCI_PRIVATE_KEY_PEM,
    TEST_OCI_PRIVATE_KEY_CRLF,
} from './test-oci-fixtures';

/**
 * Direct unit tests for handleProvider's classic (non-WIF, API-key)
 * authentication path (#723). The OCI signing private key is sourced via
 * getEndpointDataParameter -- an ADO endpoint DATA parameter, which (unlike an
 * endpoint AUTHORIZATION parameter, e.g. the GCP static key) is NOT
 * automatically registered as a secret by the platform. Confidentiality of
 * this value therefore rests entirely on the task's own manual per-line
 * tasks.setSecret() masking in getPrivateKeyFilePath -- these tests are the
 * regression guard for that masking (any future code path that reads the raw
 * key before it is masked, or a new error/log path that echoes it, will fail
 * one of the assertions below).
 *
 * Mirrors OciWifHandleProviderL0.ts's monkeypatch-the-required-module
 * technique. Only tasks.getEndpointDataParameter, tasks.getInput,
 * tasks.getBoolInput, and tasks.setSecret are stubbed; the real
 * normalizePem/writeSecretFile/resolveWifTempDir all run for real against a
 * real scratch temp dir.
 */
describe('handleProvider -- OCI classic API-key private key masking (#723)', function () {
    this.timeout(10000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch shared module
    const t = tasks as any;

    const orig = {
        getEndpointDataParameter: t.getEndpointDataParameter,
        getEndpointAuthorizationParameter: t.getEndpointAuthorizationParameter,
        getInput: t.getInput,
        getBoolInput: t.getBoolInput,
        setSecret: t.setSecret,
        debug: t.debug,
    };

    const setSecretCalls: string[] = [];
    let endpointData: Record<string, string> = {};

    // The private key is no longer read through tasks.getEndpointDataParameter --
    // that helper debug-logs the value it returns, so it can never carry a secret
    // (#185). readSecretEndpointDataParameter reads the ENDPOINT_DATA_* variable
    // the agent actually sets, so the test has to deliver it the same way the
    // agent does rather than by stubbing the accessor.
    const PRIVATE_KEY_ENV = 'ENDPOINT_DATA_OCI_PRIVATEKEY';
    function deliverPrivateKey(value: string | undefined): void {
        if (value === undefined) delete process.env[PRIVATE_KEY_ENV];
        else process.env[PRIVATE_KEY_ENV] = value;
    }

    beforeEach(() => {
        setSecretCalls.length = 0;
        endpointData = {
            tenancy: 'ocid1.tenancy.oc1..dummy',
            user: 'ocid1.user.oc1..dummy',
            region: 'us-ashburn-1',
            fingerprint: 'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99',
        };
        deliverPrivateKey(TEST_OCI_PRIVATE_KEY_SPACES);
        t.getEndpointDataParameter = (_service: string, key: string) => endpointData[key];
        // Legacy connections carry the key as endpoint DATA; the auth parameter is
        // absent unless a test opts into the post-migration shape.
        t.getEndpointAuthorizationParameter = () => undefined;
        // No environmentAuthSchemeOCI input configured -> resolveAuthScheme defaults
        // to "ServiceConnection", taking the classic (non-WIF) branch under test.
        t.getInput = () => undefined;
        t.getBoolInput = () => false;
        t.setSecret = (s: string) => { setSecretCalls.push(s); };
        t.debug = () => { /* silence */ };
    });

    afterEach(() => {
        deliverPrivateKey(undefined);
        t.getEndpointDataParameter = orig.getEndpointDataParameter;
        t.getEndpointAuthorizationParameter = orig.getEndpointAuthorizationParameter;
        t.getInput = orig.getInput;
        t.getBoolInput = orig.getBoolInput;
        t.setSecret = orig.setSecret;
        t.debug = orig.debug;
        EnvironmentVariableHelper.clearTrackedVariables();
    });

    function makeCommand(): TerraformAuthorizationCommandInitializer {
        return new TerraformAuthorizationCommandInitializer('plan', 'DummyWorkingDirectory', 'OCI');
    }

    it('masks every non-boundary line of both the raw (ADO spaces-form) and normalized PEM before the key file is written', async () => {
        const handler = new TerraformCommandHandlerOCI();
        await handler.handleProvider(makeCommand());

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tempFiles: readonly string[] = (handler as any).tempFileManager.tracked;
        // Two tracked files since #1082: the private key AND the synthetic OCI config
        // that names it. Selected by NAME rather than index so this stays honest if
        // the write order ever changes.
        assert.strictEqual(tempFiles.length, 2, 'tracked: the private key and the OCI config that names it');
        const privateKeyPath = tempFiles.find((p) => !p.includes('oci-apikey-config'))!;
        assert.ok(privateKeyPath, 'the private key file must still be tracked');

        const writtenPem = fs.readFileSync(privateKeyPath, 'utf-8');
        assert.strictEqual(writtenPem, TEST_OCI_PRIVATE_KEY_PEM, 'the ADO spaces-form key is normalized to proper multi-line PEM on disk');

        // The raw (spaces-form) value never appears verbatim as a masked
        // token -- ADO's masker matches per LINE, and the raw form is one
        // single line, so what must actually be masked is the raw value split
        // on its embedded PEM boundaries (there are no embedded newlines to
        // split on in the spaces form) -- assert the whole raw string was
        // masked, since it is itself the only "line" of that form.
        assert.ok(setSecretCalls.includes(TEST_OCI_PRIVATE_KEY_SPACES), 'the raw ADO spaces-form value must be masked in full');

        // Every non-boundary line of the on-disk (normalized, multi-line) PEM
        // must ALSO be masked -- ADO's masker matches per line, so the
        // byte-different on-disk form needs its own masking independent of
        // the raw form above.
        const nonBoundaryLines = writtenPem.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('-----'));
        assert.ok(nonBoundaryLines.length > 0, 'sanity: the normalized PEM has body lines to mask');
        for (const line of nonBoundaryLines) {
            assert.ok(setSecretCalls.includes(line), `normalized PEM body line must be masked: ${line.slice(0, 12)}...`);
        }

        // The raw key must not be left in process.env: ENDPOINT_DATA_* is not
        // vaulted by task-lib, so anything still there is inherited by the
        // terraform child process and every provider plugin it forks (#185).
        assert.strictEqual(process.env[PRIVATE_KEY_ENV], undefined,
            'the ENDPOINT_DATA_* private key must be deleted from the environment once read');

        handler.cleanupTempFiles();
    });

    it('masks every non-boundary line of an already-multiline (LF) PEM the same way', async () => {
        deliverPrivateKey(TEST_OCI_PRIVATE_KEY_PEM);

        const handler = new TerraformCommandHandlerOCI();
        await handler.handleProvider(makeCommand());

        const nonBoundaryLines = TEST_OCI_PRIVATE_KEY_PEM.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('-----'));
        for (const line of nonBoundaryLines) {
            assert.ok(setSecretCalls.includes(line), `PEM body line must be masked: ${line.slice(0, 12)}...`);
        }

        handler.cleanupTempFiles();
    });

    it('masks every non-boundary line of a CRLF-delivered PEM the same way', async () => {
        deliverPrivateKey(TEST_OCI_PRIVATE_KEY_CRLF);

        const handler = new TerraformCommandHandlerOCI();
        await handler.handleProvider(makeCommand());

        const nonBoundaryLines = TEST_OCI_PRIVATE_KEY_CRLF.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('-----'));
        for (const line of nonBoundaryLines) {
            assert.ok(setSecretCalls.includes(line), `CRLF PEM body line must be masked: ${line.slice(0, 12)}...`);
        }

        handler.cleanupTempFiles();
    });

    it('sets TF_VAR_tenancy_ocid/user_ocid/region/fingerprint/private_key_path from the endpoint data parameters', async () => {
        const handler = new TerraformCommandHandlerOCI();
        await handler.handleProvider(makeCommand());

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tempFiles: readonly string[] = (handler as any).tempFileManager.tracked;
        assert.strictEqual(process.env['TF_VAR_tenancy_ocid'], 'ocid1.tenancy.oc1..dummy');
        assert.strictEqual(process.env['TF_VAR_user_ocid'], 'ocid1.user.oc1..dummy');
        assert.strictEqual(process.env['TF_VAR_region'], 'us-ashburn-1');
        assert.strictEqual(process.env['TF_VAR_fingerprint'], 'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99');
        assert.strictEqual(process.env['TF_VAR_private_key_path'], tempFiles[0]);

        handler.cleanupTempFiles();
    });

    it('throws before writing any file when the service connection has no privateKey data parameter', async () => {
        endpointData = {};
        deliverPrivateKey(undefined); // privateKey (and everything else) missing

        const handler = new TerraformCommandHandlerOCI();
        await assert.rejects(
            handler.handleProvider(makeCommand()),
            /field 'privateKey' is missing or empty/,
        );

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        assert.strictEqual((handler as any).tempFileManager.tracked.length, 0, 'no temp file is tracked when the key is missing');
        assert.strictEqual(setSecretCalls.length, 0, 'nothing is masked when there is no key to mask');
    });

    // azure-pipelines-packer#185: the privatekey descriptor moved under the
    // endpoint's auth scheme, so ADO now vaults it, keeps it out of process.env
    // and seeds the agent's masker at job start. Connections created before that
    // change still deliver it as endpoint DATA, so both shapes must work.
    describe('privatekey delivery migration (data -> auth scheme)', () => {
        it('reads the vaulted auth parameter when the connection supplies one', async () => {
            deliverPrivateKey(undefined); // nothing in ENDPOINT_DATA_*_PRIVATEKEY
            t.getEndpointAuthorizationParameter = (_service: string, key: string) =>
                (key === 'privateKey' ? TEST_OCI_PRIVATE_KEY_SPACES : undefined);

            const handler = new TerraformCommandHandlerOCI();
            await handler.handleProvider(makeCommand());

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const tempFiles: readonly string[] = (handler as any).tempFileManager.tracked;
            // Two tracked files since #1082: the private key AND the synthetic OCI
            // config that names it. Selected by NAME rather than index so this
            // stays honest if the write order ever changes.
            assert.strictEqual(tempFiles.length, 2, 'tracked: the auth-delivered key and the OCI config');
            const keyPath = tempFiles.find((p) => !p.includes('oci-apikey-config'))!;
            assert.strictEqual(fs.readFileSync(keyPath, 'utf-8'), TEST_OCI_PRIVATE_KEY_PEM);
            assert.ok(setSecretCalls.includes(TEST_OCI_PRIVATE_KEY_SPACES),
                'the auth-delivered key must be masked exactly as the data-delivered one is');
        });

        it('prefers the auth parameter over a legacy data parameter when both are present', async () => {
            // The data path carries the CRLF fixture; the auth path the spaces one.
            // Only the auth value may reach disk.
            deliverPrivateKey(TEST_OCI_PRIVATE_KEY_CRLF);
            t.getEndpointAuthorizationParameter = (_service: string, key: string) =>
                (key === 'privateKey' ? TEST_OCI_PRIVATE_KEY_SPACES : undefined);

            const handler = new TerraformCommandHandlerOCI();
            await handler.handleProvider(makeCommand());

            assert.ok(setSecretCalls.includes(TEST_OCI_PRIVATE_KEY_SPACES),
                'the auth-delivered key is the one that must be used');
            assert.ok(!setSecretCalls.includes(TEST_OCI_PRIVATE_KEY_CRLF),
                'the legacy data value must not be read when the auth parameter is present');
        });

        it('still fails closed when neither delivery carries the key', async () => {
            deliverPrivateKey(undefined);
            t.getEndpointAuthorizationParameter = () => undefined;

            const handler = new TerraformCommandHandlerOCI();
            await assert.rejects(
                handler.handleProvider(makeCommand()),
                /field 'privateKey' is missing or empty/,
            );
        });
    });
});
