import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

// A malformed URL fails validateMirrorUrl with "Invalid mirror URL: ...".
tr.setInput('mirrorUrl', 'not-a-valid-url');

tr.run();
