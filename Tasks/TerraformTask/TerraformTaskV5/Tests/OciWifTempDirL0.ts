import * as assert from 'assert';
import * as os from 'os';
import tasks = require('azure-pipelines-task-lib/task');
import { resolveWifTempDir } from '../src/oci-terraform-command-handler';

/**
 * Direct unit tests for the OCI WIF temp-dir resolution. The ephemeral credential
 * files (private key, UPST, synthetic OCI config) are written to Agent.TempDirectory
 * when the task runs on a pipeline agent — the agent auto-purges that directory at
 * job end, so the residual-on-disk window is bounded to the job even if both the
 * finally cleanup and the signal handlers are bypassed (SIGKILL/host crash). Off a
 * pipeline agent it falls back to os.tmpdir().
 */
describe('OCI WIF temp-dir resolution', function () {
    const originalGetVariable = tasks.getVariable;
    afterEach(() => { (tasks as any).getVariable = originalGetVariable; });

    it('prefers Agent.TempDirectory when the agent provides it', () => {
        (tasks as any).getVariable = (name: string) =>
            name === 'Agent.TempDirectory' ? '/agent/_work/_temp' : originalGetVariable(name);
        assert.strictEqual(resolveWifTempDir(), '/agent/_work/_temp');
    });

    it('falls back to os.tmpdir() when Agent.TempDirectory is unset', () => {
        (tasks as any).getVariable = (name: string) =>
            name === 'Agent.TempDirectory' ? undefined : originalGetVariable(name);
        assert.strictEqual(resolveWifTempDir(), os.tmpdir());
    });
});
