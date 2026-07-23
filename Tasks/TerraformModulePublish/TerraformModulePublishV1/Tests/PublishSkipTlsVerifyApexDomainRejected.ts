import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #588 companion to PublishSkipTlsVerifyPublicRegistryRejected: covers the bare
// apex domain (`terraform.io` itself, no subdomain) -- the exact-match half of
// `hostname === 'terraform.io' || hostname.endsWith('.terraform.io')`. Without
// this fixture, only the `.endsWith('.terraform.io')` subdomain branch was
// exercised by a test; a regression that dropped the exact-match clause would
// have gone uncaught.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('registryType', 'private');
tr.setInput('namespace', 'aceo');
tr.setInput('name', 'networking-vpc');
tr.setInput('provider', 'aws');
tr.setInput('version', '1.0.0');
tr.setInput('registryUrl', 'https://terraform.io/v1/modules');
tr.setInput('apiKey', 'super-secret-api-key');
tr.setInput('skipTlsVerify', 'true');
tr.setInput('waitForPublish', 'false');
tr.setInput('timeoutSeconds', '180');

// Stub the HTTPS transport so createHttpsClient never opens a socket -- if the
// rejection below regresses, this stub would otherwise mask that a real network
// call almost happened.
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

tr.registerMock('./hcp-publisher', {
  HcpPublisher: class {
    publish() {
      return Promise.resolve({ published: true, message: 'should not be called' });
    }
  },
});

tr.run();
