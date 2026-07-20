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

    /**
     * The PAR URL is a bearer credential and this config file cannot be
     * relocated to a purged temp directory (#595) — a plain unlink only
     * removes the directory entry, leaving the bytes potentially recoverable
     * until overwritten. cleanupTempFiles() must scrub the content (zero it
     * out) before the unlink, so we intercept fs.unlinkSync to read the
     * file's content at the exact moment cleanup deletes it and assert the
     * PAR token is already gone.
     */
    it('scrubs the PAR-bearing config file content to zeros before cleanupTempFiles unlinks it (#595)', async () => {
        const handler = new TerraformCommandHandlerOCI();
        await handler.handleBackend(stubToolRunner());

        const configFiles = fs.readdirSync(scratchDir).filter((f) => /^config-[0-9a-f-]+\.tf$/.test(f));
        assert.strictEqual(configFiles.length, 1);
        const configPath = path.join(scratchDir, configFiles[0]);
        const originalSize = fs.statSync(configPath).size;

        const origUnlinkSync = fs.unlinkSync;
        let contentAtUnlinkTime: Buffer | undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared fs module
        (fs as any).unlinkSync = (p: fs.PathLike) => {
            contentAtUnlinkTime = fs.readFileSync(p as string);
            return origUnlinkSync(p);
        };
        try {
            handler.cleanupTempFiles();
        } finally {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- restore
            (fs as any).unlinkSync = origUnlinkSync;
        }

        assert.ok(contentAtUnlinkTime, 'fs.unlinkSync must have been invoked on the config file');
        assert.strictEqual(contentAtUnlinkTime!.length, originalSize, 'the scrub must preserve the original file length');
        assert.ok(contentAtUnlinkTime!.every((b) => b === 0), 'the file must be zeroed out before deletion, not left with the PAR token recoverable');
        assert.ok(!contentAtUnlinkTime!.includes(Buffer.from('TOKEN123')), 'the bearer token must not survive to the unlink call');
    });
});

/**
 * Direct unit tests for the opt-in `cleanupOCIBackendCache` scrub (#675):
 * `terraform init` copies the OCI PAR bearer URL into
 * `<workingDirectory>/.terraform/terraform.tfstate`, a cache this task does
 * not generate directly (it's Terraform's own behavior) and therefore cannot
 * unconditionally delete -- most pipelines run separate init/plan/apply steps
 * against the same working directory, and each later step needs this cache to
 * still be present. Default off; only scrubbed when the operator opts in.
 */
describe('OCI backend cache cleanup — opt-in scrub of .terraform/terraform.tfstate (#675)', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
    const t = tasks as any;
    const taskOrig = {
        getInput: t.getInput,
        getBoolInput: t.getBoolInput,
        setSecret: t.setSecret,
        debug: t.debug,
    };
    let scratchDir: string;
    let cachePath: string;
    const parUrl = 'https://objectstorage.us-ashburn-1.oraclecloud.com/p/TOKEN123/n/ns/b/tfstate/o/state';

    function installInputs(cleanupOCIBackendCache: boolean): void {
        t.getInput = (name: string) => {
            if (name === 'backendServiceOCI') return 'OCI';
            if (name === 'backendOCIConfigGenerate') return 'yes';
            if (name === 'backendOCIPar') return parUrl;
            if (name === 'workingDirectory') return scratchDir;
            return undefined;
        };
        // A faithful stand-in for task-lib's getBoolInput: the real one
        // snapshots inputs at module load, so it can't see a value set at
        // test time -- must be stubbed directly (matches RunAzLoginL0.ts).
        t.getBoolInput = (name: string) => (name === 'cleanupOCIBackendCache' ? cleanupOCIBackendCache : false);
    }

    beforeEach(() => {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oci-backend-cache-test-'));
        fs.mkdirSync(path.join(scratchDir, '.terraform'));
        cachePath = path.join(scratchDir, '.terraform', 'terraform.tfstate');
        fs.writeFileSync(cachePath, JSON.stringify({ backend: { config: { address: parUrl } } }));
        t.setSecret = () => { /* no-op */ };
        t.debug = () => { /* silence */ };
    });

    afterEach(() => {
        t.getInput = taskOrig.getInput;
        t.getBoolInput = taskOrig.getBoolInput;
        t.setSecret = taskOrig.setSecret;
        t.debug = taskOrig.debug;
        fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    function stubToolRunner(): ToolRunner {
        return { arg: () => { /* backendConfig is empty for OCI */ } } as unknown as ToolRunner;
    }

    it('leaves .terraform/terraform.tfstate untouched by default (cleanupOCIBackendCache unset)', async () => {
        installInputs(false);
        const handler = new TerraformCommandHandlerOCI();
        await handler.handleBackend(stubToolRunner());
        handler.cleanupTempFiles();

        assert.ok(fs.existsSync(cachePath), 'the backend cache must survive cleanup when cleanupOCIBackendCache is not enabled');
        assert.ok(fs.readFileSync(cachePath, 'utf8').includes('TOKEN123'), 'the file content must be untouched');
    });

    it('scrubs and removes .terraform/terraform.tfstate when cleanupOCIBackendCache is enabled after init (#675)', async () => {
        installInputs(true);
        const handler = new TerraformCommandHandlerOCI();
        await handler.handleBackend(stubToolRunner());
        handler.cleanupTempFiles();

        assert.ok(!fs.existsSync(cachePath), 'the backend cache must be removed once the operator opts in');
    });

    it('also registers the cache for cleanup from handleProvider (apply/destroy as the last step, no handleBackend call)', async () => {
        installInputs(true);
        const handler = new TerraformCommandHandlerOCI();
        await handler.handleProvider({ serviceProviderName: undefined } as unknown as Parameters<TerraformCommandHandlerOCI['handleProvider']>[0]);
        handler.cleanupTempFiles();

        assert.ok(!fs.existsSync(cachePath), 'handleProvider (used by plan/apply/destroy/...) must register the same opt-in cleanup, not only handleBackend (init)');
    });

    it('registers the cache for cleanup from handleProvider even when backendOCIConfigGenerate is no (#675 simplification: gated only on cleanupOCIBackendCache)', async () => {
        installInputs(true);
        t.getInput = (name: string) => {
            if (name === 'workingDirectory') return scratchDir;
            if (name === 'backendOCIConfigGenerate') return 'no';
            return undefined;
        };
        const handler = new TerraformCommandHandlerOCI();
        await handler.handleProvider({ serviceProviderName: undefined } as unknown as Parameters<TerraformCommandHandlerOCI['handleProvider']>[0]);
        handler.cleanupTempFiles();

        // backendOCIConfigGenerate's own input group is only visible/defaulted
        // for command=init in the classic UI designer, so an apply/destroy
        // step relying on its default resolving to "yes" would be fragile;
        // gating solely on the operator's own explicit cleanupOCIBackendCache
        // opt-in avoids that dependency entirely. Scrubbing a cache that
        // happens to exist even when this task did not generate the backend
        // config itself is a safe, idempotent action the operator already
        // consented to.
        assert.ok(!fs.existsSync(cachePath), 'handleProvider must register cleanup based on cleanupOCIBackendCache alone, independent of backendOCIConfigGenerate');
    });
});

