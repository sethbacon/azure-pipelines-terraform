import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import { prepareScratchFixture, setFakeAzureServiceConnectionEnv } from './smoke-helpers';

/**
 * #613 regression floor (real terraform, no mocks): the standard saved-plan
 * apply pattern -- `commandOptions` is a POSITIONAL plan-file path (not a
 * flag). Pre-fix, applyAutoApprove() appended `-json` AFTER commandOptions,
 * producing `apply -auto-approve x.tfplan -json`, which terraform's flag
 * parser rejects as "Too many command line arguments" (it stops parsing flags
 * at the first positional argument). The fix emits `-json` BEFORE the
 * positional. This can only be proven with a REAL terraform binary -- a mock
 * exec answer keyed on the current (already-fixed) command line can't detect
 * that the fixed code would have failed against a real CLI parser if the
 * ordering regressed.
 */
const scratchDir = prepareScratchFixture();

const tp = path.join(__dirname, 'Regression613ApplyL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'apply');
tr.setInput('workingDirectory', scratchDir);
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');
tr.setInput('commandOptions', 'x.tfplan');
tr.setInput('publishApplyResults', 'my-apply-results');

setFakeAzureServiceConnectionEnv();

tr.run(true);
