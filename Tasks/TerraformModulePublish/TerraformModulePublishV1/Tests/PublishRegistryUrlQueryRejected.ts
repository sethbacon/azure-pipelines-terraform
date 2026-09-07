import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #1110: private-publisher.ts builds request URLs by trimming a trailing slash
// off registryUrl and concatenating a fixed API path onto it, rather than
// resolving through the URL parser -- so a query string in the base would
// silently retarget the request (the intended '/api/v1/modules/...' path lands
// inside the query string instead of the URL path). Must be rejected before
// either publisher or the HTTP transport is ever invoked.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('registryType', 'private');
tr.setInput('namespace', 'aceo');
tr.setInput('name', 'networking-vpc');
tr.setInput('provider', 'aws');
tr.setInput('version', '1.0.0');
tr.setInput('registryUrl', 'https://registry.example/?x=');
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
