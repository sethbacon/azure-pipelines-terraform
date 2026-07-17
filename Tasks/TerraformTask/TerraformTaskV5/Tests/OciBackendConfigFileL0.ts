import * as assert from 'assert';
import fs = require('fs');
import os = require('os');
import path = require('path');
import tasks = require('azure-pipelines-task-lib/task');
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import { TerraformCommandHandlerOCI } from '../src/oci-terraform-command-handler';

/**
 * Direct unit tests for the generated OCI backend config file (#545). The
 * config-<uuid>.tf embeds the escaped PAR URL — a bearer credential to the
 * Terraform state bucket — so it must be written through the shared
 * writeSecretFile primitive (exclusive create + 0600 on Unix / restrictive
 * DACL on Windows), not a plain write followed by a separate chmod. It must
 * stay INSIDE the working directory (terraform init only loads *.tf from
 * there) and remain registered for cleanup.
 */
describe('OCI backend config file — secret-file write hardening (#545)', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
    const t = tasks as any;
    const taskOrig = {
        getInput: t.getInput,
        setSecret: t.setSecret,
        debug: t.debug,
    };
    let scratchDir: string;

    const parUrl = 'https://objectstorage.us-ashburn-1.oraclecloud.com/p/TOKEN123/n/ns/b/tfstate/o/state';

    beforeEach(() => {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oci-backend-config-test-'));
        t.getInput = (name: string) => {
            if (name === 'backendServiceOCI') return 'OCI';
            if (name === 'backendOCIConfigGenerate') return 'yes';
            if (name === 'backendOCIPar') return parUrl;
            if (name === 'workingDirectory') return scratchDir;
            return undefined;
        };
        t.setSecret = () => { /* no-op */ };
        t.debug = () => { /* silence */ };
    });

    afterEach(() => {
        t.getInput = taskOrig.getInput;
        t.setSecret = taskOrig.setSecret;
        t.debug = taskOrig.debug;
        fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    function stubToolRunner(): ToolRunner {
        return { arg: () => { /* backendConfig is empty for OCI */ } } as unknown as ToolRunner;
    }

    it('writes config-<uuid>.tf into the working directory with restrictive permissions', async () => {
        const handler = new TerraformCommandHandlerOCI();
        await handler.handleBackend(stubToolRunner());

        const configFiles = fs.readdirSync(scratchDir).filter((f) => /^config-[0-9a-f-]+\.tf$/.test(f));
        assert.strictEqual(configFiles.length, 1, 'exactly one config-<uuid>.tf must be generated in the working directory');
        const configPath = path.join(scratchDir, configFiles[0]);
        const content = fs.readFileSync(configPath, 'utf8');
        assert.ok(content.includes(`address = "${parUrl}"`), 'the generated backend block must carry the PAR address');
        if (process.platform !== 'win32') {
            assert.strictEqual(fs.statSync(configPath).mode & 0o777, 0o600, 'the PAR-bearing config file must be 0600');
        }
    });

    it('registers the generated config file for cleanup', async () => {
        const handler = new TerraformCommandHandlerOCI();
        await handler.handleBackend(stubToolRunner());

        const configFiles = fs.readdirSync(scratchDir).filter((f) => /^config-[0-9a-f-]+\.tf$/.test(f));
        assert.strictEqual(configFiles.length, 1);
        handler.cleanupTempFiles();
        assert.ok(!fs.existsSync(path.join(scratchDir, configFiles[0])), 'cleanupTempFiles must remove the PAR-bearing config file');
    });
});
