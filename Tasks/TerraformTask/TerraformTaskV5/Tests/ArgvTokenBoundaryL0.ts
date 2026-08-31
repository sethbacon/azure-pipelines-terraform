import * as assert from 'assert';
import tasks = require('azure-pipelines-task-lib/task');
import { TerraformCommandHandlerAzureRM } from '../src/azure-terraform-command-handler';

/**
 * Direct unit tests for the argv-token-boundary fix (#1031): workspaceName,
 * stateAddress, testJunitXmlPath/testFilter, and lockId are single structured
 * values -- not free-text multi-flag strings like commandOptions -- so
 * splicing them into command.additionalArgs sent them through
 * toolRunner.line(), which word-splits on whitespace. A value containing a
 * space (a Windows junit-xml path under "Program Files", for instance) could
 * silently become TWO argv entries instead of one. These tests record the
 * exact sequence of .arg()/.line() calls the real TerraformToolHandler makes
 * (via a fake object installed under the real tasks.tool()) and assert each
 * structured value arrives as a single, whole .arg() call -- neither split
 * apart nor merged into the .line()-based commandOptions text -- in the same
 * effective order the old spliced string produced.
 *
 * The MockTestRunner/exec-string harness used elsewhere in this suite can't
 * prove this: the mock ToolRunner's exec-answer matching joins the whole args
 * array with a single `.join(' ')` (azure-pipelines-task-lib/mock-toolrunner.js),
 * which produces an IDENTICAL string whether "my workspace" arrived as one
 * .arg() call or was word-split into two ["my", "workspace"] -- exactly the
 * distinction under test here.
 */
describe('workspace/state/test/forceUnlock -- structured single-value inputs stay whole argv tokens (#1031)', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
    const t = tasks as any;
    const taskOrig = {
        getInput: t.getInput,
        getBoolInput: t.getBoolInput,
        getVariable: t.getVariable,
        which: t.which,
        tool: t.tool,
        warning: t.warning,
    };

    type Call = { method: 'arg' | 'line'; value: string };
    let calls: Call[];

    function installInputs(inputs: Record<string, string | undefined>): void {
        t.getInput = (name: string) => inputs[name];
        t.getBoolInput = () => false;
        t.getVariable = () => undefined; // no terraformLocation recorded -- falls through to which()
        t.which = () => 'terraform';
        t.warning = () => { /* silence -- state push / force-unlock both warn */ };
    }

    beforeEach(() => {
        calls = [];
        t.tool = () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal fake ToolRunner
            const runner: any = {
                arg(val: string) { calls.push({ method: 'arg', value: val }); return runner; },
                line(val: string) { calls.push({ method: 'line', value: val }); return runner; },
            };
            return runner;
        };
    });

    afterEach(() => {
        t.getInput = taskOrig.getInput;
        t.getBoolInput = taskOrig.getBoolInput;
        t.getVariable = taskOrig.getVariable;
        t.which = taskOrig.which;
        t.tool = taskOrig.tool;
        t.warning = taskOrig.warning;
    });

    // execWithTimeout would otherwise try to actually exec the fake tool (which
    // has no .exec()); every method under test only needs the argv this fake
    // tool recorded before execWithTimeout is ever reached, not a real exit code.
    function stubExecWithTimeout(handler: TerraformCommandHandlerAzureRM): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- instance-level stub, not shared across tests
        (handler as any).commandExecutor.execWithTimeout = async () => 0;
    }

    it('workspace(): workspaceName is a whole .arg() token, even containing a space; commandOptions still goes through .line(), same order as before', async () => {
        installInputs({
            workspaceSubCommand: 'select',
            workspaceName: 'my workspace',
            commandOptions: '-lock=false',
            workingDirectory: 'DummyWorkingDirectory',
        });
        const handler = new TerraformCommandHandlerAzureRM();
        stubExecWithTimeout(handler);

        await handler.workspace();

        assert.deepStrictEqual(calls, [
            { method: 'arg', value: 'workspace select' },
            { method: 'arg', value: 'my workspace' },
            { method: 'line', value: '-lock=false' },
        ]);
    });

    it('state(): stateAddress is a whole .arg() token, even containing a space; commandOptions precedes it, same order as before', async () => {
        installInputs({
            stateSubCommand: 'show',
            stateAddress: 'module.foo["a b"].resource',
            commandOptions: '-no-color',
            workingDirectory: 'DummyWorkingDirectory',
        });
        const handler = new TerraformCommandHandlerAzureRM();
        stubExecWithTimeout(handler);

        await handler.state();

        assert.deepStrictEqual(calls, [
            { method: 'arg', value: 'state show' },
            { method: 'line', value: '-no-color' },
            { method: 'arg', value: 'module.foo["a b"].resource' },
        ]);
    });

    it('test(): testJunitXmlPath/testFilter are whole -flag=value .arg() tokens even when the value contains a space, with commandOptions text first', async () => {
        installInputs({
            provider: 'azurerm',
            commandOptions: '-no-color',
            testJunitXmlPath: 'C:\\Program Files\\out.xml',
            testFilter: 'My Filter',
            workingDirectory: 'DummyWorkingDirectory',
        });
        const handler = new TerraformCommandHandlerAzureRM();
        stubExecWithTimeout(handler);
        // No service connection input set: exercises the createBaseCommand
        // (auth-optional) branch -- runTestCommand's own capture wiring is
        // covered elsewhere; this test is only about argv token boundaries.
        (handler as any).runTestCommand = async () => 0;

        await handler.test();

        assert.deepStrictEqual(calls, [
            { method: 'arg', value: 'test' },
            { method: 'line', value: '-no-color' },
            { method: 'arg', value: '-junit-xml=C:\\Program Files\\out.xml' },
            { method: 'arg', value: '-filter=My Filter' },
        ]);
    });

    it('forceUnlock(): lockId is a whole .arg() token after -force and commandOptions, same order as before', async () => {
        installInputs({
            lockId: 'lock id with spaces',
            commandOptions: '-no-color',
            workingDirectory: 'DummyWorkingDirectory',
        });
        const handler = new TerraformCommandHandlerAzureRM();
        stubExecWithTimeout(handler);

        await handler.forceUnlock();

        assert.deepStrictEqual(calls, [
            { method: 'arg', value: 'force-unlock' },
            { method: 'arg', value: '-force' },
            { method: 'line', value: '-no-color' },
            { method: 'arg', value: 'lock id with spaces' },
        ]);
    });
});
