import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const dir = path.join(os.tmpdir(), 'tdr-scrub-before-unlink');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const planFile = path.join(dir, 'plan.json');
fs.writeFileSync(
  planFile,
  JSON.stringify({
    resource_changes: [
      { address: 'aws_instance.new', change: { actions: ['create'], before: null, after: { ami: 'ami-1' } } },
    ],
  }),
);

// A distinctive marker embedded in the summary file's `detail` field (#423):
// proves the captured-at-unlink-time content is genuinely zeroed rather than
// e.g. an already-empty/never-written buffer.
const MARKER = 'DRIFTREPORT_SCRUB_MARKER_9f3a1c';

tr.setInput('planJsonFile', planFile);
tr.setInput('includeModuleProvenance', 'false');
tr.setInput('failOnDrift', 'false');
tr.setInput('detail', MARKER);
tr.setInput('cleanupSummaryFile', 'true');

// Intercept fs.unlinkSync to read the summary file's content at the exact
// moment cleanup deletes it -- the same content-at-unlink-time technique as
// TerraformTaskV5's OciBackendConfigFileL0.ts #595 scrub-ordering test. That
// reference test runs in-process (a mocha test importing the handler class
// directly) and restores fs.unlinkSync in a finally block; this file instead
// runs as a separate out-of-process child spawned by MockTestRunner (see
// L0.ts), so the monkeypatch simply ends with the process -- no restore is
// needed. Only the drift-report summary file (tsm-drift-report-<uuid>.json)
// is targeted so this cannot mask an unrelated unlink elsewhere.
const origUnlinkSync = fs.unlinkSync;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared fs module
(fs as any).unlinkSync = (p: fs.PathLike) => {
  if (typeof p === 'string' && /tsm-drift-report-.*\.json$/.test(p)) {
    const content = fs.readFileSync(p);
    const zeroed = content.length > 0 && content.every((b) => b === 0);
    const markerAbsent = !content.includes(Buffer.from(MARKER));
    console.log(`SCRUB_BEFORE_UNLINK_CHECK zeroed=${zeroed} markerAbsent=${markerAbsent} length=${content.length}`);
  }
  return origUnlinkSync(p);
};

tr.run();
