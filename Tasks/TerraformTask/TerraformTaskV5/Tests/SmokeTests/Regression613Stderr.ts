import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import { prepareScratchFixture, setFakeAzureServiceConnectionEnv } from './smoke-helpers';

/**
 * #613 stderr-surfacing (real terraform, no mocks): apply() against a
 * nonexistent saved-plan file, with publishApplyResults set (the structured
 * path runs with `silent:true`, so ToolRunner's own stderr echo is
 * suppressed). Asserts the task fails closed (never silently succeeds) AND
 * that the real terraform diagnostic text is present in the thrown error.
 *
 * Building this harness found that under -json (publishApplyResults),
 * terraform's own error for this exact case is an NDJSON diagnostic on
 * STDOUT, not stderr -- so apply()'s original stderr-fold (#613's fix) did
 * not surface it, and the thrown message was just the bare loc string with
 * no cause. Filed and fixed as #750: error-severity diagnostic summaries
 * from the NDJSON stdout are now folded into the failure alongside stderr.
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
