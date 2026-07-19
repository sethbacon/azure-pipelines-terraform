import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BaseTerraformCommandHandler } from '../src/base-terraform-command-handler';
import { TerraformAuthorizationCommandInitializer } from '../src/terraform-commands';

/**
 * Direct unit tests for the emergency-only temp-file cleanup split (#650). The
 * retained `terraform output -json` file (when cleanupOutputFile is off) must
 * SURVIVE a normal end-of-step cleanup so downstream steps can read it via the
 * jsonOutputVariablesPath contract, but must be scrubbed+deleted on a
 * cancellation (SIGTERM/emergency), where no legitimate downstream reader is
 * left. cleanupTempFiles() therefore leaves emergencyOnlyTempFiles alone;
 * emergencyCleanupTempFiles() removes both the ordinary temp files and the
 * emergency-only ones.
 */

/** Concrete handler exposing the protected temp-file arrays for the test. */
class TestHandler extends BaseTerraformCommandHandler {
    async handleBackend(): Promise<void> { /* no-op */ }
    async handleProvider(_command: TerraformAuthorizationCommandInitializer): Promise<void> { /* no-op */ }
    async configureBackendCredentials(): Promise<void> { /* no-op */ }
    public trackTemp(p: string): void { this.tempFiles.push(p); }
    public trackEmergencyOnly(p: string): void { this.emergencyOnlyTempFiles.push(p); }
}

describe('emergency-only temp-file cleanup (#650)', function () {
    let scratchDir: string;

    beforeEach(() => {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-emergency-only-'));
    });

    afterEach(() => {
        fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    function writeFile(name: string): string {
        const p = path.join(scratchDir, name);
        fs.writeFileSync(p, 'output = "s3cr3t"\n');
        return p;
    }

    it('cleanupTempFiles removes ordinary temp files but keeps the emergency-only file', () => {
        const handler = new TestHandler();
        const ordinary = writeFile('ordinary.json');
        const retained = writeFile('output-retained.json');
        handler.trackTemp(ordinary);
        handler.trackEmergencyOnly(retained);

        handler.cleanupTempFiles();

        assert.strictEqual(fs.existsSync(ordinary), false, 'the ordinary temp file must be scrubbed+deleted at step end');
        assert.strictEqual(fs.existsSync(retained), true, 'the retained output file must survive a normal step for downstream readers');
    });

    it('emergencyCleanupTempFiles removes both the ordinary and the emergency-only file', () => {
        const handler = new TestHandler();
        const ordinary = writeFile('ordinary.json');
        const retained = writeFile('output-retained.json');
        handler.trackTemp(ordinary);
        handler.trackEmergencyOnly(retained);

        handler.emergencyCleanupTempFiles();

        assert.strictEqual(fs.existsSync(ordinary), false, 'the ordinary temp file must be removed on cancellation');
        assert.strictEqual(fs.existsSync(retained), false, 'the retained output file must be scrubbed+deleted on cancellation');
    });

    it('emergencyCleanupTempFiles is a safe no-op when nothing was tracked', () => {
        const handler = new TestHandler();
        assert.doesNotThrow(() => handler.emergencyCleanupTempFiles());
    });
});
