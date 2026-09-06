import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #1110: a fragment in registryUrl is even worse than a query string --
// nothing after '#' is sent to the server at all, so the concatenated
// '/api/v1/modules/...' path is silently discarded client-side. Must be
// rejected before either publisher or the HTTP transport is ever invoked.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('registryType', 'private');
tr.setInput('namespace', 'aceo');
tr.setInput('name', 'networking-vpc');
tr.setInput('provider', 'aws');
tr.setInput('version', '1.0.0');
// A bare trailing '#' parses to an EMPTY hash (new URL('https://x/#').hash === ''),
// which is a no-op, not a retargeting case -- a non-empty fragment is what
// actually drops everything after it.
tr.setInput('registryUrl', 'https://registry.example/#frag');
tr.setInput('apiKey', 'super-secret-api-key');
tr.setInput('waitForPublish', 'false');
tr.setInput('timeoutSeconds', '180');

tr.registerMock('./http', {
  createHttpsClient: () => () => Promise.resolve({ status: 200, body: '{}' }),
});

tr.registerMock('./private-publisher', {
  PrivateRegistryPublisher: class {
    publish() {
      return Promise.resolve({ published: true, message: 'should not be called' });
    }
  },
});

tr.run();
