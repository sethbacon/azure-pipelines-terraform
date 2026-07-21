import * as assert from 'assert';
import * as ttm from 'azure-pipelines-task-lib/mock-test';
import * as path from 'path';

/**
 * Real-terraform smoke harness (#719). Kept as a SEPARATE suite/CI job from
 * L0.ts's mock-runner suite (not folded into test:coverage) so the normal
 * suite stays terraform-free and fast, and local devs without terraform on
 * PATH still run the mock suite. Requires a real terraform (or tofu) binary
 * on PATH -- see docs/initiatives/smoke-fuzz-testing-plan.md for the full
 * design and rationale.
 *
 * Unlike L0.ts's mock-runner scenarios (where ToolRunner exec answers are
 * keyed by the exact command-line string the code currently emits -- so a
 * WRONG argv shape the test wasn't told to expect is invisible), every
 * scenario here runs a real terraform binary against a real local-backend
 * fixture (Tests/SmokeTests/fixtures/local-data/main.tf) with no mocking at
 * all (TaskMockRunner.run(true)), and asserts on the real exit code and real
 * on-disk artifacts.
 */
describe('TerraformTaskV5 Smoke Test Suite (real terraform, #719)', function () {
  this.timeout(60000);

  function runValidations(validator: () => void, tr: ttm.MockTestRunner) {
    try {
      validator();
    } catch (error) {
      console.log('STDERR', tr.stderr);
      console.log('STDOUT', tr.stdout);
      throw error;
    }
  }

  describe('Regression floor', () => {
    it('#612 plan: user-supplied -out is honored, no task-injected second -out shadows it', async () => {
      const tp = path.join(__dirname, 'SmokeTests', 'Regression612Plan.js');
      const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
      await tr.runAsync();

      runValidations(() => {
        assert(tr.succeeded, 'task should have succeeded. errors: ' + tr.errorIssues);
        assert(tr.stdOutContained('Regression612PlanL0 should have succeeded.'), 'expected the L0 driver to report success');
      }, tr);
    });

    it('#612 destroy: user-supplied -out is honored, no task-injected second -out shadows it', async () => {
      const tp = path.join(__dirname, 'SmokeTests', 'Regression612Destroy.js');
      const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
      await tr.runAsync();

      runValidations(() => {
        assert(tr.succeeded, 'task should have succeeded. errors: ' + tr.errorIssues);
        assert(tr.stdOutContained('Regression612DestroyL0 should have succeeded.'), 'expected the L0 driver to report success');
      }, tr);
    });

    it('#613 apply: -json is emitted before the positional saved-plan path, not after', async () => {
      const tp = path.join(__dirname, 'SmokeTests', 'Regression613Apply.js');
      const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
      await tr.runAsync();

      runValidations(() => {
        assert(tr.succeeded, 'task should have succeeded. errors: ' + tr.errorIssues);
        assert(tr.stdOutContained('Regression613ApplyL0 should have succeeded.'), 'expected the L0 driver to report success');
      }, tr);
    });

    it('#613 stderr-surfacing: a real terraform failure message reaches the thrown error under publishApplyResults', async () => {
      const tp = path.join(__dirname, 'SmokeTests', 'Regression613Stderr.js');
      const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
      await tr.runAsync();

      runValidations(() => {
        assert(tr.succeeded, 'task should have succeeded. errors: ' + tr.errorIssues);
        assert(tr.stdOutContained('Regression613StderrL0 should have succeeded.'), 'expected the L0 driver to report success');
      }, tr);
    });

    it('#749 destroy + publishPlanSummary: a real destroy-plan digest is built and the real destroy still succeeds', async () => {
      const tp = path.join(__dirname, 'SmokeTests', 'Regression749DestroyPlanSummary.js');
      const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
      await tr.runAsync();

      runValidations(() => {
        assert(tr.succeeded, 'task should have succeeded. errors: ' + tr.errorIssues);
        assert(tr.stdOutContained('Regression749DestroyPlanSummaryL0 should have succeeded.'), 'expected the L0 driver to report success');
      }, tr);
    });
  });

  describe('Baseline command matrix', () => {
    it('plan: no additional options', async () => {
      const tp = path.join(__dirname, 'SmokeTests', 'BaselinePlainPlan.js');
      const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
      await tr.runAsync();

      runValidations(() => {
        assert(tr.succeeded, 'task should have succeeded. errors: ' + tr.errorIssues);
        assert(tr.stdOutContained('BaselinePlainPlanL0 should have succeeded.'), 'expected the L0 driver to report success');
      }, tr);
    });

    it('plan + publishPlanSummary: task-owned tempfile -out', async () => {
      const tp = path.join(__dirname, 'SmokeTests', 'BaselinePlanSummary.js');
      const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
      await tr.runAsync();

      runValidations(() => {
        assert(tr.succeeded, 'task should have succeeded. errors: ' + tr.errorIssues);
        assert(tr.stdOutContained('BaselinePlanSummaryL0 should have succeeded.'), 'expected the L0 driver to report success');
      }, tr);
    });

    it('apply: fresh (no saved plan) + publishApplyResults', async () => {
      const tp = path.join(__dirname, 'SmokeTests', 'BaselineApplyResults.js');
      const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
      await tr.runAsync();

      runValidations(() => {
        assert(tr.succeeded, 'task should have succeeded. errors: ' + tr.errorIssues);
        assert(tr.stdOutContained('BaselineApplyResultsL0 should have succeeded.'), 'expected the L0 driver to report success');
      }, tr);
    });

    it('show: current state + publishStateResults', async () => {
      const tp = path.join(__dirname, 'SmokeTests', 'BaselineShowStateResults.js');
      const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
      await tr.runAsync();

      runValidations(() => {
        assert(tr.succeeded, 'task should have succeeded. errors: ' + tr.errorIssues);
        assert(tr.stdOutContained('BaselineShowStateResultsL0 should have succeeded.'), 'expected the L0 driver to report success');
      }, tr);
    });

    it('output -json', async () => {
      const tp = path.join(__dirname, 'SmokeTests', 'BaselineOutputJson.js');
      const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
      await tr.runAsync();

      runValidations(() => {
        assert(tr.succeeded, 'task should have succeeded. errors: ' + tr.errorIssues);
        assert(tr.stdOutContained('BaselineOutputJsonL0 should have succeeded.'), 'expected the L0 driver to report success');
      }, tr);
    });

    it('validate (auth-free)', async () => {
      const tp = path.join(__dirname, 'SmokeTests', 'BaselineValidate.js');
      const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
      await tr.runAsync();

      runValidations(() => {
        assert(tr.succeeded, 'task should have succeeded. errors: ' + tr.errorIssues);
        assert(tr.stdOutContained('BaselineValidateL0 should have succeeded.'), 'expected the L0 driver to report success');
      }, tr);
    });

    it('fmt -check (auth-free)', async () => {
      const tp = path.join(__dirname, 'SmokeTests', 'BaselineFmt.js');
      const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
      await tr.runAsync();

      runValidations(() => {
        assert(tr.succeeded, 'task should have succeeded. errors: ' + tr.errorIssues);
        assert(tr.stdOutContained('BaselineFmtL0 should have succeeded.'), 'expected the L0 driver to report success');
      }, tr);
    });
  });
});
