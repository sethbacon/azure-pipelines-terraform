import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import { prepareScratchFixture, setFakeAzureServiceConnectionEnv } from './smoke-helpers';

/**
 * #613 stderr-surfacing (real terraform, no mocks): apply() against a
 * nonexistent saved-plan file, with publishApplyResults set (the structured
 * path runs with `silent:true`, so ToolRunner's own stderr echo is
 * suppressed). Asserts the task fails closed (never silently succeeds).
 *
 * Building this harness found that under -json (publishApplyResults),
 * terraform's own error for this exact case is an NDJSON diagnostic on
 * STDOUT, not stderr -- so apply()'s stderr-fold (#613's original fix) does
 * not surface it, and the thrown message is currently just the bare loc
 * string. Filed as #750; see the L0 driver's comment for the exact assertion
 * this test currently makes pending that fix.
 */
const scratchDir = prepareScratchFixture();

const tp = path.join(__dirname, 'Regression613StderrL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'apply');
tr.setInput('workingDirectory', scratchDir);
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');
tr.setInput('commandOptions', 'missing.tfplan');
tr.setInput('publishApplyResults', 'my-apply-results');

setFakeAzureServiceConnectionEnv();

tr.run(true);
