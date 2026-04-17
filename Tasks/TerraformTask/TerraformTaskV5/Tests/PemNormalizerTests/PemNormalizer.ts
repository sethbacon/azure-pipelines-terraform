import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, './PemNormalizerL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.run();
