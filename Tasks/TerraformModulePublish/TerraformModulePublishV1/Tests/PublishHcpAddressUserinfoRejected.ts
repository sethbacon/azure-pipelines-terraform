import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #1110: hcp-publisher.ts's moduleUrl/vcsUrl trim-and-concatenate hcpAddress the
// same way private-publisher.ts does for registryUrl -- userinfo embedded in
// the base would ride along with every request built from it. Must be rejected
// before either publisher or the HTTP transport is ever invoked. Covers the
// hcp branch of the same guard the two sibling fixtures cover for private.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('registryType', 'hcp');
tr.setInput('namespace', 'aceo');
tr.setInput('name', 'networking-vpc');
tr.setInput('provider', 'aws');
tr.setInput('version', '1.0.0');
tr.setInput('hcpToken', 'super-secret-token');
tr.setInput('hcpAddress', 'https://user:pass@app.terraform.io');
tr.setInput('waitForPublish', 'false');
tr.setInput('timeoutSeconds', '180');

tr.registerMock('./http', {
  createHttpsClient: () => () => Promise.resolve({ status: 200, body: '{}' }),
});

tr.registerMock('./hcp-publisher', {
  HcpPublisher: class {
    publish() {
      return Promise.resolve({ published: true, message: 'should not be called' });
    }
  },
});

tr.run();
