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
 *
 * As of the #675 remediation, the cache's *permissions* (not its content) ARE
 * tightened by default regardless of this flag -- see the "OCI backend cache
 * default-secure permission tightening" describe block below.
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

    it('cleanupTempFiles leaves .terraform/terraform.tfstate content untouched when cleanupOCIBackendCache is unset (permission-tightening is separate -- see afterInit() tests below) (#675)', async () => {
        installInputs(false);
        const handler = new TerraformCommandHandlerOCI();
        await handler.handleBackend(stubToolRunner());
        handler.cleanupTempFiles();

        assert.ok(fs.existsSync(cachePath), 'the backend cache must survive cleanup when cleanupOCIBackendCache is not enabled');
        assert.ok(fs.readFileSync(cachePath, 'utf8').includes('TOKEN123'), 'the file content must be untouched by cleanupTempFiles (default-secure permission tightening is a separate mechanism -- see afterInit() below)');
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

/**
 * Direct unit tests for the DEFAULT-SECURE permission tightening of
 * `.terraform/terraform.tfstate` (#675 remediation): the opt-in scrub above
 * only runs when an operator sets `cleanupOCIBackendCache`, but the PAR
 * bearer credential `terraform init` copies into that cache is exposed under
 * the agent's default umask on EVERY run, opt-in or not, leaving a live
 * credential on disk on reused/self-hosted agents. `afterInit()` (the base
 * class's post-init hook, invoked by `init()` once `execAsync` resolves
 * successfully) must tighten that file's permissions to the current user
 * only whenever this run generated an OCI PAR backend -- regardless of
 * cleanupOCIBackendCache -- while leaving its content in place (unlike the
 * opt-in scrub above, which deletes it outright).
 */
describe('OCI backend cache default-secure permission tightening (#675)', function () {
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
        // A faithful stand-in for task-lib's getBoolInput -- see the identical
        // helper in the describe block above for why this can't use the real one.
        t.getBoolInput = (name: string) => (name === 'cleanupOCIBackendCache' ? cleanupOCIBackendCache : false);
    }

    beforeEach(() => {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oci-backend-cache-perm-test-'));
        fs.mkdirSync(path.join(scratchDir, '.terraform'));
        cachePath = path.join(scratchDir, '.terraform', 'terraform.tfstate');
        // Simulate terraform init's own write: a fresh file inherits the
        // process/agent's umask, not a tightened 0600 -- explicitly chmod to a
        // permissive mode so the "before" state is deterministic across CI
        // runners regardless of their configured umask.
        fs.writeFileSync(cachePath, JSON.stringify({ backend: { config: { address: parUrl } } }));
        if (process.platform !== 'win32') {
            fs.chmodSync(cachePath, 0o644);
        }
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

    it('tightens .terraform/terraform.tfstate to the current user only by DEFAULT (cleanupOCIBackendCache unset) once an OCI PAR backend was generated', async () => {
        installInputs(false);
        const handler = new TerraformCommandHandlerOCI();
        await handler.handleBackend(stubToolRunner());
        // afterInit() is normally invoked by the base class's init() once
        // terraform init's execAsync resolves; called directly here (as with
        // other protected-method tests in this suite, e.g. handleProviderWIF in
        // OciWifHandleProviderL0.ts) to exercise it without needing a real
        // terraform binary. `false` == init succeeded (see the init()-integration
        // describe block below for the wiring-through-init() + failure-path cases).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- protected method
        await (handler as any).afterInit(false);

        assert.ok(fs.existsSync(cachePath), 'the backend cache must survive by default -- this is permission tightening, not the opt-in scrub/delete');
        assert.ok(fs.readFileSync(cachePath, 'utf8').includes('TOKEN123'), 'the cache content must be left untouched -- only its permissions change');
        if (process.platform !== 'win32') {
            assert.strictEqual(fs.statSync(cachePath).mode & 0o777, 0o600, 'the PAR-bearing cache must be tightened to 0600 by default, not left at the agent umask');
        }
    });

    it('does nothing when no OCI PAR backend was generated this run (backendOCIConfigGenerate=no)', async () => {
        installInputs(false);
        t.getInput = (name: string) => {
            if (name === 'workingDirectory') return scratchDir;
            if (name === 'backendOCIConfigGenerate') return 'no';
            return undefined;
        };
        const handler = new TerraformCommandHandlerOCI();
        await handler.handleBackend(stubToolRunner());
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- protected method
        await (handler as any).afterInit(false);

        if (process.platform !== 'win32') {
            assert.strictEqual(fs.statSync(cachePath).mode & 0o777, 0o644, 'afterInit() must not touch a cache when no OCI PAR backend was generated this run');
        }
    });

    it('is a no-op when the cache file does not exist yet (e.g. init never reached the backend-init phase)', async () => {
        installInputs(false);
        fs.rmSync(cachePath);
        const handler = new TerraformCommandHandlerOCI();
        await handler.handleBackend(stubToolRunner());
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- protected method
        await (handler as any).afterInit(false);

        assert.ok(!fs.existsSync(cachePath), 'afterInit() must not (re-)create the cache file when terraform init never wrote one');
    });

    it('also tightens permissions when cleanupOCIBackendCache is enabled, before the opt-in scrub removes the cache on cleanup (#675)', async () => {
        installInputs(true);
        const handler = new TerraformCommandHandlerOCI();
        await handler.handleBackend(stubToolRunner());
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- protected method
        await (handler as any).afterInit(false);

        if (process.platform !== 'win32') {
            assert.strictEqual(fs.statSync(cachePath).mode & 0o777, 0o600, 'permission tightening runs unconditionally, independent of the opt-in flag');
        }

        // The pre-existing opt-in scrub (registered by handleBackend() above,
        // unchanged by this fix) still deletes the cache entirely once the
        // operator has explicitly opted in.
        handler.cleanupTempFiles();
        assert.ok(!fs.existsSync(cachePath), 'the opt-in full scrub must still run afterward, unaffected by the new default-secure tightening');
    });
});

/**
 * BLOCKING 1 (#675 review follow-up): the describe block above exercises
 * afterInit() by calling it DIRECTLY, which proves the tightening logic
 * itself works but does NOT prove init() actually WIRES afterInit() in --
 * a regression that silently dropped the `await this.afterInit(...)` call (or
 * its try/finally) from init() would not be caught by any test above. These
 * tests instead call handler.init() itself, stubbing only
 * terraformToolHandler.createToolRunner() (so no real terraform binary is
 * needed), covering both the success path and -- the actual reachability bug
 * this review found -- the path where init() FAILS after the backend was
 * already configured (no `ignoreReturnCode` on init's execAsync means a
 * non-zero exit REJECTS the promise; a bare post-await afterInit() call would
 * never run in that case).
 */
describe('OCI init() integration -- afterInit() wiring survives success and failure (#675 follow-up)', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
    const t = tasks as any;
    const taskOrig = {
        getInput: t.getInput,
        getBoolInput: t.getBoolInput,
        setSecret: t.setSecret,
        debug: t.debug,
        warning: t.warning,
    };
    let scratchDir: string;
    let cachePath: string;
    const parUrl = 'https://objectstorage.us-ashburn-1.oraclecloud.com/p/TOKEN123/n/ns/b/tfstate/o/state';

    // A minimal stand-in for ITerraformToolHandler/ToolRunner -- init() only
    // calls .arg() (via applyBackendConfig(), a no-op loop over OCI's always-
    // empty backendConfig map) and .execAsync() on the object this returns.
    function stubToolRunner(execAsync: () => Promise<number>): ToolRunner {
        return {
            arg: () => { /* backendConfig is empty for OCI */ },
            execAsync,
        } as unknown as ToolRunner;
    }

    beforeEach(() => {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oci-init-integration-test-'));
        fs.mkdirSync(path.join(scratchDir, '.terraform'));
        cachePath = path.join(scratchDir, '.terraform', 'terraform.tfstate');
        // Simulate terraform init's own write of the PAR-bearing cache: the
        // stubbed execAsync below never touches disk, so this test supplies the
        // "before" state a real terraform init binary would have produced by
        // the time its process exits (whether it then resolves or rejects).
        fs.writeFileSync(cachePath, JSON.stringify({ backend: { config: { address: parUrl } } }));
        if (process.platform !== 'win32') {
            fs.chmodSync(cachePath, 0o644);
        }
        t.getInput = (name: string) => {
            if (name === 'backendServiceOCI') return 'OCI';
            if (name === 'backendOCIConfigGenerate') return 'yes';
            if (name === 'backendOCIPar') return parUrl;
            if (name === 'workingDirectory') return scratchDir;
            return undefined;
        };
        t.getBoolInput = () => false;
        t.setSecret = () => { /* no-op */ };
        t.debug = () => { /* silence */ };
        t.warning = () => { /* silence -- not expected on either path exercised here, since tightenFilePermissions itself is not made to fail */ };
    });

    afterEach(() => {
        t.getInput = taskOrig.getInput;
        t.getBoolInput = taskOrig.getBoolInput;
        t.setSecret = taskOrig.setSecret;
        t.debug = taskOrig.debug;
        t.warning = taskOrig.warning;
        fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    it('tightens the OCI PAR backend cache via init() itself when init succeeds -- not just when afterInit() is called directly', async () => {
        const handler = new TerraformCommandHandlerOCI();
        handler.terraformToolHandler = {
            createToolRunner: () => stubToolRunner(async () => 0),
        };

        const result = await handler.init();

        assert.strictEqual(result, 0);
        if (process.platform !== 'win32') {
            assert.strictEqual(
                fs.statSync(cachePath).mode & 0o777,
                0o600,
                'init() itself must wire afterInit() through to tighten the cache -- removing that wiring should fail this test even though the afterInit()-direct tests above would still pass',
            );
        }
    });

    it('still tightens the cache AND re-throws the ORIGINAL error unmodified when init fails after the backend was already configured (BLOCKING 1)', async () => {
        const handler = new TerraformCommandHandlerOCI();
        const initError = new Error('terraform init failed: could not install provider plugins');
        handler.terraformToolHandler = {
            createToolRunner: () => stubToolRunner(async () => { throw initError; }),
        };

        let caught: unknown;
        try {
            await handler.init();
        } catch (error) {
            caught = error;
        }

        assert.strictEqual(caught, initError, "afterInit() must never mask or replace init()'s own error -- the exact same error object must propagate unmodified");
        if (process.platform !== 'win32') {
            assert.strictEqual(
                fs.statSync(cachePath).mode & 0o777,
                0o600,
                'the cache must still be tightened by default even though init ultimately failed -- the backend (and its cache write) was already configured before the failure',
            );
        }
    });
});

/**
 * BLOCKING 2 (#675 review follow-up): Terraform's config-snapshot plan format
 * embeds the ACTIVE backend config -- including an OCI PAR bearer URL, exactly
 * like `.terraform/terraform.tfstate` -- into every saved plan file. plan()
 * and destroy()/runDestroyPlanForSummary() call afterPlanFileWritten() for
 * every plan file they produce (task-generated tempfile or user-supplied
 * `-out=`); these tests exercise that hook directly, matching this suite's
 * established style for afterInit() above.
 */
describe('OCI saved plan file default-secure permission tightening (#675 follow-up)', function () {
    let scratchDir: string;

    beforeEach(() => {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oci-plan-file-perm-test-'));
    });

    afterEach(() => {
        fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    function writePermissivePlanFile(): string {
        const planFilePath = path.join(scratchDir, 'terraform-plan.tfplan');
        // Content shape doesn't matter to this hook -- only that a file exists
        // at a permissive mode beforehand, standing in for a real saved plan
        // file's config-snapshot section.
        fs.writeFileSync(planFilePath, 'binary-plan-file-content-placeholder');
        if (process.platform !== 'win32') {
            fs.chmodSync(planFilePath, 0o644);
        }
        return planFilePath;
    }

    it('tightens a saved plan file to the current user only for a successful plan/destroy command (BLOCKING 2)', async () => {
        const planFilePath = writePermissivePlanFile();
        const handler = new TerraformCommandHandlerOCI();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- protected method
        await (handler as any).afterPlanFileWritten(planFilePath, false);

        assert.ok(fs.existsSync(planFilePath), 'tightening must not delete the plan file');
        if (process.platform !== 'win32') {
            assert.strictEqual(fs.statSync(planFilePath).mode & 0o777, 0o600, 'a saved plan file must be tightened to 0600 by default for an OCI-provider command');
        }
    });

    it('also tightens a saved plan file when the command that produced it failed', async () => {
        const planFilePath = writePermissivePlanFile();
        const handler = new TerraformCommandHandlerOCI();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- protected method
        await (handler as any).afterPlanFileWritten(planFilePath, true);

        if (process.platform !== 'win32') {
            assert.strictEqual(fs.statSync(planFilePath).mode & 0o777, 0o600, 'a plan file already written before a failing plan/destroy command must still be tightened, best-effort');
        }
    });

    it('is a no-op when no plan file was actually written (e.g. the command failed before producing one)', async () => {
        const planFilePath = path.join(scratchDir, 'never-written.tfplan');
        const handler = new TerraformCommandHandlerOCI();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- protected method
        await (handler as any).afterPlanFileWritten(planFilePath, true);

        assert.ok(!fs.existsSync(planFilePath), 'afterPlanFileWritten() must not (re-)create a plan file that was never written');
    });
});

/**
 * BLOCKING (#675 2nd follow-up review): the describe block above exercises
 * afterPlanFileWritten() by calling it DIRECTLY, which proves the tightening
 * logic itself works but does NOT prove plan() actually wires a bare
 * user-supplied `-out=` (in commandOptions, with publishPlanSummary left
 * UNSET) through to it -- the exact gap this review found. extractOutFlagPath()
 * was only being consulted INSIDE the `if (publishPlanSummary)` block, so a
 * commandOptions `-out=<path>` run with publishPlanSummary unset never
 * populated planFilePath at all, and the resulting saved plan file -- which
 * embeds the OCI PAR bearer credential exactly like the publishPlanSummary
 * tempfile case -- was silently never tightened.
 *
 * Mirrors this file's own "OCI init() integration" describe block above:
 * calls handler.plan() itself (not afterPlanFileWritten() directly), stubbing
 * only terraformToolHandler.createToolRunner() (so no real terraform binary is
 * needed) plus handleProvider()/warnIfMultipleProviders() (OCI auth and the
 * `terraform providers` probe are unrelated to this fix and already covered by
 * their own dedicated tests elsewhere -- stubbing them keeps this test focused
 * on plan()'s own -out=/afterPlanFileWritten() wiring).
 */
describe('OCI plan() integration -- a bare commandOptions -out= is tightened even without publishPlanSummary (#675 2nd follow-up)', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
    const t = tasks as any;
    const taskOrig = {
        getInput: t.getInput,
        getBoolInput: t.getBoolInput,
        setVariable: t.setVariable,
        setSecret: t.setSecret,
        debug: t.debug,
        warning: t.warning,
    };
    let scratchDir: string;
    let planFilePath: string;

    // A minimal stand-in for ITerraformToolHandler/ToolRunner -- plan() only
    // calls .arg()/.line() (building the command line, irrelevant to this
    // wiring test) and .execAsync() on the object this returns.
    function stubToolRunner(execAsync: () => Promise<number>): ToolRunner {
        return {
            arg: () => { /* leading/parallelism/-detailed-exitcode tokens -- unused by this test */ },
            line: () => { /* commandOptions -- the -out= under test is read via getCommandOptions()/extractOutFlagPath(), not re-parsed from here */ },
            execAsync,
        } as unknown as ToolRunner;
    }

    beforeEach(() => {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oci-plan-integration-test-'));
        // Quoted, space-separated `-out "<path>"` form so this round-trips
        // through extractOutFlagPath()'s tokenizer even if the OS temp dir
        // happens to contain a space (the equals form, `-out="<path>"`, is a
        // documented limit of that tokenizer -- see its doc comment).
        planFilePath = path.join(scratchDir, 'user-saved.tfplan');
        t.getInput = (name: string) => {
            if (name === 'provider') return 'oci';
            if (name === 'environmentServiceNameOCI') return 'OCI';
            if (name === 'workingDirectory') return scratchDir;
            if (name === 'commandOptions') return `-out "${planFilePath}"`;
            // publishPlanResults / publishPlanSummary intentionally left unset
            // -- this is precisely the scenario the review found unprotected.
            return undefined;
        };
        t.getBoolInput = () => false;
        t.setVariable = () => { /* no-op -- silence plan()'s trailing changesPresent ##vso line */ };
        t.setSecret = () => { /* no-op */ };
        t.debug = () => { /* silence */ };
        t.warning = () => { /* silence */ };
    });

    afterEach(() => {
        t.getInput = taskOrig.getInput;
        t.getBoolInput = taskOrig.getBoolInput;
        t.setVariable = taskOrig.setVariable;
        t.setSecret = taskOrig.setSecret;
        t.debug = taskOrig.debug;
        t.warning = taskOrig.warning;
        fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    it('tightens a user-supplied -out= plan file after plan() even when publishPlanSummary is unset (removing the plan()-level fix should fail this test)', async () => {
        const handler = new TerraformCommandHandlerOCI();
        handler.terraformToolHandler = {
            createToolRunner: () => stubToolRunner(async () => {
                // Stand-in for the real `terraform plan -out=<path> ...`
                // process actually writing its saved plan file, at a
                // permissive mode -- mirrors writePermissivePlanFile() in the
                // describe block above.
                fs.writeFileSync(planFilePath, 'binary-plan-file-content-placeholder');
                if (process.platform !== 'win32') {
                    fs.chmodSync(planFilePath, 0o644);
                }
                return 0;
            }),
        };
        // handleProvider()/warnIfMultipleProviders() are unrelated to this fix
        // (OCI auth and the `terraform providers` probe already have their own
        // dedicated tests) -- stubbed out so this test exercises ONLY plan()'s
        // own -out=/afterPlanFileWritten() wiring.
        handler.handleProvider = async () => { /* no-op -- see comment above */ };
        handler.warnIfMultipleProviders = async () => { /* no-op -- see comment above */ };

        const result = await handler.plan();

        assert.strictEqual(result, 0);
        assert.ok(fs.existsSync(planFilePath), 'the user-supplied -out= plan file must exist');
        if (process.platform !== 'win32') {
            assert.strictEqual(
                fs.statSync(planFilePath).mode & 0o777,
                0o600,
                'plan() must tighten a user-supplied -out= plan file even when publishPlanSummary is unset -- reverting the plan()-level fix (gating extractOutFlagPath() detection on publishPlanSummary again) should fail this test',
            );
        }
    });
});

/**
 * BLOCKING (#675 3rd follow-up / final panel review): `custom()` was the one
 * remaining command that never called extractOutFlagPath()/afterPlanFileWritten()
 * at all -- a `command: custom` step with e.g. `customCommand: plan` (or
 * `plan -destroy`) plus a user-supplied `-out=` in commandOptions writes a real
 * OCI-PAR-embedding plan file through this same free-text passthrough, with
 * zero permission tightening. customCommand is unrestricted free text
 * (task.json has no enum/regex validating it) -- Terraform does not care that
 * the task labels the step "custom" rather than "plan".
 *
 * Mirrors this file's own "OCI plan() integration" describe block above: calls
 * handler.custom() itself (not afterPlanFileWritten() directly), stubbing only
 * terraformToolHandler.createToolRunner() (no real terraform binary needed)
 * plus handleProvider() (OCI auth is unrelated to this fix and already covered
 * by its own dedicated tests -- stubbing it keeps this test focused on
 * custom()'s own -out=/afterPlanFileWritten() wiring). Both outputTo branches
 * ('console'/'file') share the SAME afterPlanFileWritten() call site in a
 * single try/finally, so exercising the 'console' branch proves the shared
 * wiring -- it is not duplicated per branch.
 */
describe('OCI custom() integration -- a bare commandOptions -out= is tightened (#675 3rd follow-up)', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
    const t = tasks as any;
    const taskOrig = {
        getInput: t.getInput,
        getBoolInput: t.getBoolInput,
        setSecret: t.setSecret,
        debug: t.debug,
        warning: t.warning,
    };
    let scratchDir: string;
    let planFilePath: string;

    // A minimal stand-in for ITerraformToolHandler/ToolRunner -- custom()'s
    // 'console' outputTo branch only calls .execAsync() on the object this
    // returns (unlike plan(), custom() never calls .arg()/.line() itself --
    // additionalArgs/commandOptions are baked into customCommand and applied
    // by the real createToolRunner(), which this stub bypasses entirely).
    function stubToolRunner(execAsync: () => Promise<number>): ToolRunner {
        return { execAsync } as unknown as ToolRunner;
    }

    beforeEach(() => {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oci-custom-integration-test-'));
        // Quoted, space-separated `-out "<path>"` form -- same tokenizer
        // choice as the plan()-integration test above.
        planFilePath = path.join(scratchDir, 'user-saved.tfplan');
        t.getInput = (name: string) => {
            if (name === 'provider') return 'oci';
            if (name === 'environmentServiceNameOCI') return 'OCI';
            if (name === 'workingDirectory') return scratchDir;
            if (name === 'customCommand') return 'plan';
            if (name === 'commandOptions') return `-out "${planFilePath}"`;
            if (name === 'outputTo') return 'console';
            return undefined;
        };
        t.getBoolInput = () => false;
        t.setSecret = () => { /* no-op */ };
        t.debug = () => { /* silence */ };
        t.warning = () => { /* silence */ };
    });

    afterEach(() => {
        t.getInput = taskOrig.getInput;
        t.getBoolInput = taskOrig.getBoolInput;
        t.setSecret = taskOrig.setSecret;
        t.debug = taskOrig.debug;
        t.warning = taskOrig.warning;
        fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    it('tightens a user-supplied -out= plan file after a successful custom() plan command (removing the custom()-level fix should fail this test)', async () => {
        const handler = new TerraformCommandHandlerOCI();
        handler.terraformToolHandler = {
            createToolRunner: () => stubToolRunner(async () => {
                // Stand-in for the real `terraform plan -out=<path> ...`
                // process actually writing its saved plan file, at a
                // permissive mode -- mirrors the plan()-integration test above.
                fs.writeFileSync(planFilePath, 'binary-plan-file-content-placeholder');
                if (process.platform !== 'win32') {
                    fs.chmodSync(planFilePath, 0o644);
                }
                return 0;
            }),
        };
        // handleProvider() is unrelated to this fix (OCI auth already has its
        // own dedicated tests) -- stubbed out so this test exercises ONLY
        // custom()'s own -out=/afterPlanFileWritten() wiring.
        handler.handleProvider = async () => { /* no-op -- see comment above */ };

        const result = await handler.custom();

        assert.strictEqual(result, 0);
        assert.ok(fs.existsSync(planFilePath), 'the user-supplied -out= plan file must exist');
        if (process.platform !== 'win32') {
            assert.strictEqual(
                fs.statSync(planFilePath).mode & 0o777,
                0o600,
                "custom() must tighten a user-supplied -out= plan file produced by a customCommand: plan step -- reverting the custom()-level fix (never calling extractOutFlagPath()/afterPlanFileWritten()) should fail this test",
            );
        }
    });

    it('still tightens the plan file AND re-throws the ORIGINAL error unmodified when the custom command fails after writing it', async () => {
        const handler = new TerraformCommandHandlerOCI();
        const commandError = new Error('terraform plan failed: policy check denied this change');
        handler.terraformToolHandler = {
            createToolRunner: () => stubToolRunner(async () => {
                // A real `terraform plan -out=` can write the plan file and
                // THEN exit non-zero (e.g. a wrapping policy check) -- the
                // saved plan already on disk at that point is just as real a
                // credential exposure as the success path.
                fs.writeFileSync(planFilePath, 'binary-plan-file-content-placeholder');
                if (process.platform !== 'win32') {
                    fs.chmodSync(planFilePath, 0o644);
                }
                throw commandError;
            }),
        };
        handler.handleProvider = async () => { /* no-op -- see comment above */ };

        let caught: unknown;
        try {
            await handler.custom();
        } catch (error) {
            caught = error;
        }

        assert.strictEqual(caught, commandError, "afterPlanFileWritten() must never mask or replace custom()'s own error -- the exact same error object must propagate unmodified");
        if (process.platform !== 'win32') {
            assert.strictEqual(
                fs.statSync(planFilePath).mode & 0o777,
                0o600,
                'the plan file must still be tightened even though the custom command ultimately failed',
            );
        }
    });
});


