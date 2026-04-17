import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, './ResourceAddressL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{};
tr.setAnswers(a);
tr.run();
