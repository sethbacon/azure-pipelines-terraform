import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #588 lookalike-safety companion to PublishSkipTlsVerifyPublicRegistryRejected:
// a host that merely CONTAINS "terraform.io" as a substring, without an actual
// dot-anchored suffix match, must NOT be falsely rejected -- it's a legitimate
// private registry the skipTlsVerify escape hatch exists for. Confirms the
// suffix check is dot-anchored (endsWith('.terraform.io') / === 'terraform.io'),
// not a bare substring match.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('registryType', 'private');
tr.setInput('namespace', 'aceo');
tr.setInput('name', 'networking-vpc');
tr.setInput('provider', 'aws');
tr.setInput('version', '1.0.0');
tr.setInput('registryUrl', 'https://my-terraform.io.internal.corp/v1/modules');
tr.setInput('apiKey', 'super-secret-api-key');
tr.setInput('skipTlsVerify', 'true');
tr.setInput('waitForPublish', 'false');
tr.setInput('timeoutSeconds', '180');

tr.registerMock('./http', {
  createHttpsClient: () => () => Promise.resolve({ status: 200, body: '{}' }),
});

tr.registerMock('./private-publisher', {
  PrivateRegistryPublisher: class {
    publish() {
      return Promise.resolve({ published: true, message: 'Sync triggered for version 1.0.0.' });
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
