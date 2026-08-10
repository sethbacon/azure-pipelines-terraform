import { describe, it } from 'mocha';
import assert = require('assert');
import { BaseTerraformCommandHandler } from '../src/base-terraform-command-handler';
import { TerraformAuthorizationCommandInitializer } from '../src/terraform-commands';
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';

/**
 * Class test (issues #884/#897) for THIS task's command dispatch.
 *
 * The sibling halves of this class live in Markdown2HtmlV1 and
 * PublishKbArticleV1's PrototypeSafeLookupClassL0.ts. This row covers
 * executeCommand(), which the prototype-safe-lookup signature found still
 * indexing a plain object literal with the `command` task input after the rest
 * of the class had been converted to Maps.
 *
 * Mutation-provable: restore the object literal + `commands[command]` and the
 * `constructor` row goes red, because Object is truthy AND callable, so the
 * not-found guard never fires and `fn()` runs Object() instead of throwing.
 */

class ProbeHandler extends BaseTerraformCommandHandler {
  async handleBackend(_t: ToolRunner): Promise<void> { /* unreachable in these rows */ }
  async handleProvider(_c: TerraformAuthorizationCommandInitializer): Promise<void> { /* unreachable */ }
  async configureBackendCredentials(): Promise<void> { /* unreachable */ }
}

describe('command dispatch: prototype-chain lookup class (#884/#897)', () => {
  // Every name Object.prototype contributes that a plain-object lookup would
  // resolve to something truthy. `constructor` is the dangerous one: it is also
  // callable, so a `!fn` guard passes it straight through to fn().
  for (const magic of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    it(`rejects '${magic}' with the invalid-command error rather than resolving an inherited member`, async () => {
      const handler = new ProbeHandler();
      await assert.rejects(
        () => handler.executeCommand(magic),
        (err: Error) => {
          assert.match(err.message, /^Invalid command: /, `expected the not-found branch, got: ${err.message}`);
          return true;
        },
      );
    });
  }

  it('still rejects an ordinary unknown command', async () => {
    const handler = new ProbeHandler();
    await assert.rejects(() => handler.executeCommand('definitely-not-a-command'), /^Error: Invalid command: /);
  });

  it('lists the real commands in the error, not inherited members', async () => {
    const handler = new ProbeHandler();
    await assert.rejects(() => handler.executeCommand('nope'), (err: Error) => {
      assert.ok(err.message.includes('init'), 'the valid-command list must survive the Map conversion');
      assert.ok(!err.message.includes('hasOwnProperty'), 'no inherited member may appear in the valid-command list');
      return true;
    });
  });
});
