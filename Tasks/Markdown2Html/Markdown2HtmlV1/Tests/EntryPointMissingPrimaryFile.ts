import tmrm = require('azure-pipelines-task-lib/mock-run');
import fs = require('fs');
import os = require('os');
import path = require('path');

// #189, failure half: the REAL src/index.ts must fail closed — not throw out of
// run() and not report Succeeded — when the front-matter primary file does not
// exist. Exercises the entry point's frontMatter dispatch branch and its catch,
// neither of which the module-level suite reaches.
// Unique 0700 directory: a fixed name under the shared temp dir is pre-creatable by
// any local user and the writes below could be redirected through a planted symlink.
// Scratch lives under the compiled Tests directory, not os.tmpdir(). The path must
// stay deterministic because Tests/L0.ts reconstructs it independently to assert on
// the produced file, and a fixed name in the shared temp dir is pre-creatable by any
// local user, so the writes below could be redirected through a planted symlink
// (CWE-377/378) -- the reason src/ uses secure-temp.ts.
const SCRATCH_DIR = path.join(__dirname, '.scratch', 'entrypoint-missing');

fs.mkdirSync(SCRATCH_DIR, { recursive: true });

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);


tr.setInput('mode', 'frontMatter');
tr.setInput('primaryFile', path.join(SCRATCH_DIR, 'does-not-exist.md'));
tr.setInput('outputFile', path.join(SCRATCH_DIR, 'out.html'));

tr.run();
