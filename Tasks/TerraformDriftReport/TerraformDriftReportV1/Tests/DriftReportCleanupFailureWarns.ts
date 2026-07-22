import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

// Unique per-run temp dir via fs.mkdtempSync instead of a predictable os.tmpdir()
// path, to avoid the insecure-temp-file symlink-race class (CodeQL js/insecure-temporary-file).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdr-cleanupfail-'));
const planFile = path.join(dir, 'plan.json');
fs.writeFileSync(
  planFile,
  JSON.stringify({
    resource_changes: [
      { address: 'aws_instance.new', change: { actions: ['create'], before: null, after: { ami: 'ami-1' } } },
    ],
  }),
);

const FIXED_UUID = 'fixed-driftreport-cleanupfail-uuid';
const summaryFile = path.join(os.tmpdir(), `tsm-drift-report-${FIXED_UUID}.json`);
// This fixture deliberately makes the unlink of summaryFile fail (below), so
// it is never actually removed from disk -- pre-clean any copy left behind by
// a prior run of this exact scenario, otherwise writeSecretFile's exclusive
// (O_EXCL) create would fail with EEXIST before cleanup is even reached.
fs.rmSync(summaryFile, { force: true });

tr.registerMock('crypto', { randomUUID: () => FIXED_UUID });

tr.setInput('planJsonFile', planFile);
tr.setInput('includeModuleProvenance', 'false');
tr.setInput('failOnDrift', 'false');
tr.setInput('cleanupSummaryFile', 'true');

// Force cleanup's unlink step to hit its failure branch for the summary file
// specifically (mirrors TerraformPolicyCheckV1's GitCloneCleanupFailureWarns.ts
// #766 monkeypatch-throws-on-exact-path technique): the drift report itself
// still succeeds, proving a leftover summary file (which can hold sensitive
// plan values) isn't silently swallowed at debug level in an otherwise-green
// run -- it must surface via tasks.warning.
const origUnlinkSync = fs.unlinkSync;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared fs module
(fs as any).unlinkSync = (p: fs.PathLike) => {
  if (p === summaryFile) {
    throw new Error('simulated cleanup failure');
  }
  return origUnlinkSync(p);
};

tr.run();
