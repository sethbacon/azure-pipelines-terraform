import * as assert from 'assert';
import * as fs from 'fs';
import tasks = require('azure-pipelines-task-lib/task');
import { resolveToolPath } from '../src/terraform';

/**
 * Direct unit tests for tool-path resolution. PipelineTerraformInstaller records
 * the binary it installed in the terraformLocation variable (and PATH, via
 * tools.prependPath — see TerraformInstallerV1 issue #319). Both are job-scoped
 * the same way, so terraformLocation is same-job defense-in-depth for cases where
 * a PATH lookup would otherwise fail, not a cross-job handoff. The recorded path
 * is only trusted when its filename matches the requested binary, so installing
 * tofu in one step can't make a `terraform` command silently run the tofu binary.
 */
describe('resolveToolPath — installer terraformLocation vs PATH lookup', function () {
    const originalGetVariable = tasks.getVariable;
    const originalWhich = tasks.which;
    const originalExistsSync = fs.existsSync;

    afterEach(() => {
        (tasks as any).getVariable = originalGetVariable;
        (tasks as any).which = originalWhich;
        (fs as any).existsSync = originalExistsSync;
    });

    it('prefers terraformLocation when it exists on disk and matches the requested binary', () => {
        (tasks as any).getVariable = (name: string) =>
            name === 'terraformLocation' ? '/tmp/terraform-cached/terraform' : undefined;
        (fs as any).existsSync = (p: string) => p === '/tmp/terraform-cached/terraform';
        (tasks as any).which = () => {
            throw new Error('tasks.which should not be called when terraformLocation is valid');
        };
        assert.strictEqual(resolveToolPath(tasks, 'terraform'), '/tmp/terraform-cached/terraform');
    });

    it('falls back to PATH lookup when terraformLocation points at a different binary', () => {
        (tasks as any).getVariable = (name: string) =>
            name === 'terraformLocation' ? '/tmp/tofu-cached/tofu' : undefined;
        (fs as any).existsSync = () => true;
        (tasks as any).which = (name: string) => '/usr/local/bin/' + name;
        assert.strictEqual(resolveToolPath(tasks, 'terraform'), '/usr/local/bin/terraform');
    });

    it('falls back to PATH lookup when terraformLocation no longer exists on disk', () => {
        (tasks as any).getVariable = (name: string) =>
            name === 'terraformLocation' ? '/tmp/terraform-cached/terraform' : undefined;
        (fs as any).existsSync = () => false;
        (tasks as any).which = (name: string) => '/usr/local/bin/' + name;
        assert.strictEqual(resolveToolPath(tasks, 'terraform'), '/usr/local/bin/terraform');
    });

    it('falls back to PATH lookup when terraformLocation is unset', () => {
        (tasks as any).getVariable = () => undefined;
        (tasks as any).which = (name: string) => '/usr/local/bin/' + name;
        assert.strictEqual(resolveToolPath(tasks, 'terraform'), '/usr/local/bin/terraform');
    });

    it('throws when neither terraformLocation nor PATH resolve the binary', () => {
        (tasks as any).getVariable = () => undefined;
        (tasks as any).which = () => { throw new Error('not found'); };
        assert.throws(() => resolveToolPath(tasks, 'terraform'));
    });
});
