import * as assert from 'assert';
import { applyAutomationEnvironment } from '../src/terraform';

/**
 * #896: HashiCorp's "Running Terraform in Automation" guidance for CI wrappers.
 * Both variables are opt-OUT via the mechanism Terraform documents -- an operator
 * value on the job or step wins -- so these tests pin the precedence, not just
 * the defaults.
 */
describe('automation environment defaults (#896)', function () {
  it('sets both variables when the operator set neither', () => {
    const env: NodeJS.ProcessEnv = {};
    applyAutomationEnvironment(env);
    assert.strictEqual(env.TF_IN_AUTOMATION, '1');
    assert.strictEqual(env.CHECKPOINT_DISABLE, '1');
  });

  it('never overwrites an operator-supplied value', () => {
    const env: NodeJS.ProcessEnv = { TF_IN_AUTOMATION: 'yes', CHECKPOINT_DISABLE: 'true' };
    applyAutomationEnvironment(env);
    assert.strictEqual(env.TF_IN_AUTOMATION, 'yes');
    assert.strictEqual(env.CHECKPOINT_DISABLE, 'true');
  });

  it('preserves an EMPTY operator value, which Terraform reads as off', () => {
    // The opt-out for a variable whose semantics are "any non-empty value" is to
    // set it empty; treating empty as unset would silently re-enable both.
    const env: NodeJS.ProcessEnv = { TF_IN_AUTOMATION: '', CHECKPOINT_DISABLE: '' };
    applyAutomationEnvironment(env);
    assert.strictEqual(env.TF_IN_AUTOMATION, '');
    assert.strictEqual(env.CHECKPOINT_DISABLE, '');
  });

  it('fills only the variable the operator left unset', () => {
    const env: NodeJS.ProcessEnv = { CHECKPOINT_DISABLE: '' };
    applyAutomationEnvironment(env);
    assert.strictEqual(env.TF_IN_AUTOMATION, '1');
    assert.strictEqual(env.CHECKPOINT_DISABLE, '');
  });

  it('is idempotent across the repeated calls every command path makes', () => {
    const env: NodeJS.ProcessEnv = {};
    applyAutomationEnvironment(env);
    applyAutomationEnvironment(env);
    assert.strictEqual(env.TF_IN_AUTOMATION, '1');
    assert.strictEqual(env.CHECKPOINT_DISABLE, '1');
  });
});
