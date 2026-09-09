import * as assert from 'assert';
import fs = require('fs');
import os = require('os');
import path = require('path');
import tasks = require('azure-pipelines-task-lib/task');
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import { TerraformCommandHandlerOCI } from '../src/oci-terraform-command-handler';
import { STATE_COMMANDS } from '../src/parent-handler';
import { TEST_OCI_PRIVATE_KEY_SPACES } from './test-oci-fixtures';
import ado = require('@4cloudguru/pipeline-task-ado');
import { EnvironmentVariableHelper } from '@4cloudguru/pipeline-task-ado';

/**
 * CLASS test for #675 option 3 — "which commands can reach the OCI PAR backend
 * cache cleanup at all".
 *
 * The opt-in `cleanupOCIBackendCache` scrub of
 * `<workingDirectory>/.terraform/terraform.tfstate` (where `terraform init`
 * caches the OCI PAR *bearer credential*) is registered by
 * `registerOciBackendCacheForCleanup`, which used to be reachable ONLY from
 * `setupBackend()` (i.e. `init`) and `handleProvider()`. Every command that
 * runs terraform against the working directory WITHOUT provider auth —
 * `workspace`, `state`, `forceunlock` — therefore silently did nothing when an
 * operator set the input on it, which the input's own help text admitted. The
 * fix is the base handler's `onStateTouchingCommand()` hook, overridden by the
 * OCI handler.
 *
 * A single-command regression test would pass forever while a sibling command
 * stayed unreachable — that is exactly how this issue reopened three times. So
 * the table below is over EVERY command in `executeCommand()`'s dispatch map,
 * driven THROUGH that map, and it asserts both directions:
 *
 *   - opt-in SET   → the cache is scrubbed+removed by end of step for every
 *                    state-touching command;
 *   - opt-in UNSET → the cache and its content survive EVERY command (the
 *                    documented multi-step contract, and the existing
 *                    OciBackendConfigFileL0 idiom — this is what makes the
 *                    "fix" a reachability change and not a default change).
 *
 * `expected: 'survives'` rows are the recorded exemptions, and they are not a
 * free-text note: `commandsCoveredByTheClass` below pins them against
 * `parent-handler.ts`'s own `STATE_COMMANDS` set, which already classifies
 * `validate`/`fmt`/`get`/`test` as commands that never touch remote state (and
 * therefore never cause the credential cache to be written or re-read). Adding
 * a command to `STATE_COMMANDS` without wiring the hook fails this file.
 */

/** A complete, well-formed OCI API-key connection: handleProvider fails closed without one. */
const OCI_ENDPOINT_DATA: Record<string, string> = {
    tenancy: 'ocid1.tenancy.oc1..dummy',
    user: 'ocid1.user.oc1..dummy',
    region: 'us-ashburn-1',
    fingerprint: 'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99',
};
const OCI_PRIVATE_KEY_ENV = 'ENDPOINT_DATA_OCI_PRIVATEKEY';
const PAR_URL = 'https://objectstorage.us-ashburn-1.oraclecloud.com/p/TOKEN123/n/ns/b/tfstate/o/state';

/** How a command is expected to leave the PAR-bearing backend cache once the operator opts in. */
type Expectation = 'scrubbed' | 'survives';

interface CommandRow {
    /** The key in BaseTerraformCommandHandler.executeCommand()'s dispatch map. */
    command: string;
    /** Distinguishes the two `test` rows; defaults to `command`. */
    label?: string;
    /** How this command reaches (or fails to reach) registerOciBackendCacheForCleanup. */
    via: string;
    expected: Expectation;
    /** Inputs this command needs on top of the shared set. */
    inputs?: Record<string, string>;
    /** Inputs to withhold from the shared set (the no-service-connection `test` row). */
    without?: string[];
}

const ROWS: CommandRow[] = [
    { command: 'init', via: 'handleBackend() -> setupBackend()', expected: 'scrubbed' },
    { command: 'plan', via: 'handleProvider()', expected: 'scrubbed' },
    { command: 'apply', via: 'handleProvider()', expected: 'scrubbed' },
    { command: 'destroy', via: 'handleProvider()', expected: 'scrubbed' },
    { command: 'refresh', via: 'handleProvider()', expected: 'scrubbed' },
    { command: 'output', via: 'handleProvider()', expected: 'scrubbed' },
    { command: 'show', via: 'handleProvider()', expected: 'scrubbed', inputs: { outputTo: 'console' } },
    { command: 'custom', via: 'handleProvider()', expected: 'scrubbed', inputs: { outputTo: 'console', customCommand: 'providers' } },
    { command: 'import', via: 'handleProvider()', expected: 'scrubbed', inputs: { importAddress: 'null_resource.a', importId: 'abc' } },
    // The three the option never reached before #675's option-3 increment.
    { command: 'workspace', via: 'onStateTouchingCommand() [#675 option 3]', expected: 'scrubbed', inputs: { workspaceSubCommand: 'select', workspaceName: 'dev' } },
    { command: 'state', via: 'onStateTouchingCommand() [#675 option 3]', expected: 'scrubbed', inputs: { stateSubCommand: 'list' } },
    { command: 'forceunlock', via: 'onStateTouchingCommand() [#675 option 3]', expected: 'scrubbed', inputs: { lockId: '3f2a' } },
    // `test` reaches handleProvider only when a service connection is supplied.
    { command: 'test', label: 'test (with a service connection)', via: 'handleProvider()', expected: 'scrubbed' },
    {
        command: 'test',
        label: 'test (no service connection)',
        via: 'EXEMPT — not a state command',
        expected: 'survives',
        without: ['environmentServiceNameOCI'],
    },
    // Exempt: never touch the backend, so they can neither cause the cache to be
    // written nor be the command that re-reads it (parent-handler's own
    // STATE_COMMANDS classification).
    { command: 'validate', via: 'EXEMPT — not a state command', expected: 'survives' },
    { command: 'fmt', via: 'EXEMPT — not a state command', expected: 'survives' },
    { command: 'get', via: 'EXEMPT — not a state command', expected: 'survives' },
];

/** Every command the dispatch map accepts, as the rows claim to cover it. */
const DISPATCHED_COMMANDS = [
    'init', 'validate', 'plan', 'apply', 'destroy', 'show', 'output', 'custom',
    'workspace', 'state', 'fmt', 'test', 'get', 'import', 'forceunlock', 'refresh',
];

describe('OCI PAR backend cache cleanup — reachable from every state-touching command (#675 option 3)', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
    const t = tasks as any;
    const taskOrig = {
        getInput: t.getInput,
        getBoolInput: t.getBoolInput,
        getVariable: t.getVariable,
        setVariable: t.setVariable,
        setSecret: t.setSecret,
        debug: t.debug,
        warning: t.warning,
        addAttachment: t.addAttachment,
        getEndpointDataParameter: t.getEndpointDataParameter,
    };
    const adoOrig = {
        readSecretInput: (ado as any).readSecretInput,
        readUrlInput: (ado as any).readUrlInput,
    };

    let scratchDir: string;
    let cachePath: string;

    /**
     * A stand-in for ITerraformToolHandler's ToolRunner. Every command builds
     * its argv on this and then runs it through CommandExecutor, which either
     * calls execAsync directly (execWithTimeout) or attaches stdout/stderr
     * listeners first (execWithStdoutCapture / captureMessageStreams). `{}` is
     * emitted so the `-json` consumers (output/show) parse something valid.
     */
    function stubToolRunner(): ToolRunner {
        const listeners: Record<string, ((data: string) => void)[]> = {};
        return {
            arg: () => { /* argv construction is not what this file asserts */ },
            line: () => { /* ditto */ },
            on: (event: string, handler: (data: string) => void) => {
                (listeners[event] ||= []).push(handler);
            },
            killChildProcess: () => { /* never reached: every stub run exits 0 */ },
            execAsync: async () => {
                for (const handler of listeners['stdout'] || []) { handler('{}'); }
                return 0;
            },
        } as unknown as ToolRunner;
    }

    function installInputs(row: CommandRow, optIn: boolean): void {
        const withheld = new Set(row.without || []);
        const values: Record<string, string> = {
            provider: 'oci',
            command: row.command,
            workingDirectory: scratchDir,
            backendServiceOCI: 'OCI',
            backendOCIConfigGenerate: 'yes',
            backendOCIPar: PAR_URL,
            environmentServiceNameOCI: 'OCI',
            ...(row.inputs || {}),
        };
        for (const name of withheld) { delete values[name]; }
        t.getInput = (name: string) => values[name];
        // task-lib's real getBoolInput snapshots inputs at module load and so
        // cannot see a value set at test time -- stubbed directly, matching
        // OciBackendConfigFileL0.
        t.getBoolInput = (name: string) => (name === 'cleanupOCIBackendCache' ? optIn : false);
        (ado as any).readSecretInput = (name: string) => values[name];
        (ado as any).readUrlInput = (name: string) => values[name];
    }

    beforeEach(() => {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oci-cache-reach-class-'));
        fs.mkdirSync(path.join(scratchDir, '.terraform'));
        cachePath = path.join(scratchDir, '.terraform', 'terraform.tfstate');
        t.getVariable = (name: string) => (name === 'Agent.TempDirectory' ? scratchDir : undefined);
        t.setVariable = () => { /* silence the ##vso output-variable lines */ };
        t.setSecret = () => { /* no-op */ };
        t.debug = () => { /* silence */ };
        t.warning = () => { /* silence: force-unlock and state push warn by design */ };
        t.addAttachment = () => { /* not reached: no publish* input is set */ };
        t.getEndpointDataParameter = (_id: string, key: string) => OCI_ENDPOINT_DATA[key];
    });

    afterEach(() => {
        t.getInput = taskOrig.getInput;
        t.getBoolInput = taskOrig.getBoolInput;
        t.getVariable = taskOrig.getVariable;
        t.setVariable = taskOrig.setVariable;
        t.setSecret = taskOrig.setSecret;
        t.debug = taskOrig.debug;
        t.warning = taskOrig.warning;
        t.addAttachment = taskOrig.addAttachment;
        t.getEndpointDataParameter = taskOrig.getEndpointDataParameter;
        (ado as any).readSecretInput = adoOrig.readSecretInput;
        (ado as any).readUrlInput = adoOrig.readUrlInput;
        delete process.env[OCI_PRIVATE_KEY_ENV];
        EnvironmentVariableHelper.clearTrackedVariables();
        fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    /** Runs one command end to end (through the real dispatch map) and reports the cache's fate. */
    async function runCommand(row: CommandRow, optIn: boolean): Promise<{ exists: boolean; content: string }> {
        // Stands in for what `terraform init` already wrote: the resolved
        // backend address, PAR bearer token included, in cleartext.
        fs.writeFileSync(cachePath, JSON.stringify({ backend: { config: { address: PAR_URL } } }));
        // Re-set per run: readSecretEndpointDataParameter deletes it once read.
        process.env[OCI_PRIVATE_KEY_ENV] = TEST_OCI_PRIVATE_KEY_SPACES;
        installInputs(row, optIn);

        const handler = new TerraformCommandHandlerOCI();
        handler.terraformToolHandler = { createToolRunner: () => stubToolRunner() };
        // The `terraform providers` probe shells out to a real binary and is
        // unrelated to cache registration (it already has its own tests); every
        // command's handleProvider() call happens BEFORE it.
        handler.warnIfMultipleProviders = async () => { /* see comment above */ };

        await handler.executeCommand(row.command);
        // The end-of-step cleanup ParentCommandHandler runs in its `finally`.
        handler.cleanupTempFiles();

        const exists = fs.existsSync(cachePath);
        return { exists, content: exists ? fs.readFileSync(cachePath, 'utf8') : '' };
    }

    describe('with cleanupOCIBackendCache SET, every state-touching command scrubs the cache', function () {
        for (const row of ROWS) {
            const label = row.label || row.command;
            it(`${label} — ${row.via}`, async () => {
                const { exists, content } = await runCommand(row, true);
                if (row.expected === 'scrubbed') {
                    assert.ok(
                        !exists,
                        `'${label}' left the OCI PAR bearer credential in .terraform/terraform.tfstate even though the ` +
                        `operator opted into cleanupOCIBackendCache. It must reach registerOciBackendCacheForCleanup ` +
                        `via ${row.via}.`,
                    );
                } else {
                    assert.ok(exists, `'${label}' is exempt (${row.via}) and must leave the cache alone`);
                    assert.ok(
                        content.includes('TOKEN123'),
                        `'${label}' is exempt (${row.via}) and must not scrub the cache's content either`,
                    );
                }
            });
        }
    });

    describe('with cleanupOCIBackendCache UNSET, the cache survives every command (no default changes)', function () {
        for (const row of ROWS) {
            const label = row.label || row.command;
            it(`${label} leaves the cache in place`, async () => {
                const { exists, content } = await runCommand(row, false);
                assert.ok(exists, `'${label}' removed the backend cache with cleanupOCIBackendCache unset — the documented multi-step contract requires it to survive`);
                assert.ok(content.includes('TOKEN123'), `'${label}' scrubbed the backend cache's content with cleanupOCIBackendCache unset`);
            });
        }
    });

    describe('the table is the whole command surface, and its exemptions match the repo contract', function () {
        it('covers every command in executeCommand()\'s dispatch map', () => {
            const covered = new Set(ROWS.map(row => row.command));
            for (const command of DISPATCHED_COMMANDS) {
                assert.ok(covered.has(command), `command '${command}' is dispatchable but has no row in this class table`);
            }
            for (const command of covered) {
                assert.ok(DISPATCHED_COMMANDS.includes(command), `row '${command}' is not a dispatchable command`);
            }
        });

        it('every command parent-handler classifies as state-touching reaches the cleanup', () => {
            for (const command of STATE_COMMANDS) {
                const rows = ROWS.filter(row => row.command === command);
                assert.ok(rows.length > 0, `STATE_COMMANDS names '${command}' but this class table has no row for it`);
                for (const row of rows) {
                    assert.strictEqual(
                        row.expected,
                        'scrubbed',
                        `'${row.label || row.command}' is in parent-handler's STATE_COMMANDS, so it reads or writes remote ` +
                        `state and MUST reach registerOciBackendCacheForCleanup — it cannot be carried as an exemption`,
                    );
                }
            }
        });

        it('every exempt row is a command parent-handler classifies as not state-touching', () => {
            for (const row of ROWS.filter(r => r.expected === 'survives')) {
                assert.ok(
                    !STATE_COMMANDS.has(row.command),
                    `'${row.label || row.command}' is exempted here but IS in parent-handler's STATE_COMMANDS; ` +
                    `re-adjudicate the exemption or wire onStateTouchingCommand() into it`,
                );
            }
        });
    });
});
