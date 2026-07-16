import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

// Neither Agent.TempDirectory nor AGENT_TEMPDIRECTORY is set: the task must fail
// closed with a clear error instead of silently falling back to a hardcoded
// non-agent-managed path (#508).
delete process.env['AGENT_TEMPDIRECTORY'];

tr.setInput('mirrorUrl', 'https://registry.example.com/terraform/providers');

tr.run();
