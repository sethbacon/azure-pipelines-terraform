import * as assert from 'assert';
import { getBinaryName } from '../src/terraform';

/**
 * Direct unit tests for getBinaryName's allowlist (#52/terragrunt): binaryName
 * was previously accepted with zero implementation, silently disabling
 * cross-cloud backend-credential injection (backend-detection.ts never finds
 * .terraform/terraform.tfstate at the plain working directory under
 * terragrunt, which nests it under .terragrunt-cache/<hash>/<hash>/).
 */
describe('getBinaryName allowlist', () => {
    function fakeTasks(input: string | undefined): typeof import('azure-pipelines-task-lib/task') {
        return {
            getInput: () => input,
        } as unknown as typeof import('azure-pipelines-task-lib/task');
    }

    it('defaults to terraform when binaryName is not set', () => {
        assert.strictEqual(getBinaryName(fakeTasks(undefined)), 'terraform');
    });

    it('accepts tofu', () => {
        assert.strictEqual(getBinaryName(fakeTasks('tofu')), 'tofu');
    });

    it('rejects terragrunt with a clear error instead of silently disabling cross-cloud backend detection', () => {
        assert.throws(
            () => getBinaryName(fakeTasks('terragrunt')),
            /Invalid binaryName 'terragrunt'/,
        );
    });

    it('rejects an arbitrary unrecognized binary name', () => {
        assert.throws(
            () => getBinaryName(fakeTasks('some-other-binary')),
            /Invalid binaryName 'some-other-binary'/,
        );
    });
});
