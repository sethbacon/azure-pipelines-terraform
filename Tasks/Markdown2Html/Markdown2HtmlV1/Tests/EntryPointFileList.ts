import tmrm = require('azure-pipelines-task-lib/mock-run');
import fs = require('fs');
import os = require('os');
import path = require('path');

// #189 (sibling azure-pipelines-packer #189): this task's suite was entirely
// module-level — it imported converter/render/frontmatter directly and never
// loaded src/index.ts, the file task.json's Node24/Node20_1 handlers point the
// ADO agent at. index.js was also excluded from the coverage metric, so the
// entry point's own input plumbing (mode dispatch, the title default, the
// htmlFilePath output variable) shipped unverified.
//
// This scenario runs the REAL src/index.js under the mock runner on the
// filelist path. The scratch directory is deterministic so Tests/L0.ts can
// assert on the produced file rather than only on stdout.
// mkdtempSync creates a unique 0700 directory atomically. A fixed name under the
// shared temp dir is pre-creatable by any local user, so the writes below could be
// redirected through a planted symlink (CWE-377/378) -- the same reason src/ uses
// secure-temp.ts. Tests/L0.ts spawns this file rather than importing it, so nothing
// outside this process needs the path to be predictable.
// Scratch lives under the compiled Tests directory, not os.tmpdir(). The path must
// stay deterministic because Tests/L0.ts reconstructs it independently to assert on
// the produced file, and a fixed name in the shared temp dir is pre-creatable by any
// local user, so the writes below could be redirected through a planted symlink
// (CWE-377/378) -- the reason src/ uses secure-temp.ts.
export const SCRATCH_DIR = path.join(__dirname, '.scratch', 'entrypoint-filelist');
export const OUTPUT_FILE = path.join(SCRATCH_DIR, 'out.html');

fs.mkdirSync(SCRATCH_DIR, { recursive: true });

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const markdownFile = path.join(SCRATCH_DIR, 'doc.md');
fs.writeFileSync(markdownFile, '# Entry Point Heading\n\nBody text.\n');
fs.rmSync(OUTPUT_FILE, { force: true });

tr.setInput('mode', 'filelist');
tr.setInput('inputFiles', markdownFile);
tr.setInput('outputFile', OUTPUT_FILE);
tr.setInput('title', 'Entry Point Test');
tr.setInput('sections', 'false');
tr.setInput('dividers', 'false');
tr.setInput('debug', 'false');

tr.run();
