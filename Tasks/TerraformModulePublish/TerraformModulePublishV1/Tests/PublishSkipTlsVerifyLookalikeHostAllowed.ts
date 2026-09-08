import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import { stubDnsZone, TLS_OPT_OUT_ZONE } from './stub-dns';

// #588 lookalike-safety companion to PublishSkipTlsVerifyPublicRegistryRejected:
// a host whose NAME contains "terraform.io" but which resolves into RFC1918
// space must NOT be falsely rejected -- it's a legitimate private registry the
// skipTlsVerify escape hatch exists for. Since the guard became a
// private-destination check rather than a name denylist, this confirms the
// decision is made on the RESOLVED ADDRESS: no spelling of a name, lookalike or
// otherwise, can decide it either way.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

// The #588 guard classifies a NAME by the address it resolves to, so this
// fixture pins a zone instead of depending on the runner's network.
stubDnsZone(TLS_OPT_OUT_ZONE);

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
