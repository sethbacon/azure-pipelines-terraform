import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import tasks = require('azure-pipelines-task-lib/task');
import { resolveRoleSessionName } from '../src/credential-guards';

/**
 * CLASS TEST — a task.json default must not silently reinstate the behaviour the
 * code was changed to stop producing (#197).
 *
 * #197 replaced the fixed AWS role session names (`AzureDevOps-Terraform`,
 * `AzureDevOps-Terraform-Backend`) with a per-run derivation, because a constant
 * collapses CloudTrail attribution across every federated run of every pipeline
 * in every organization using this extension.
 *
 * The code fallback was changed — but `task.json` still declared
 * `"defaultValue": "AzureDevOps-Terraform"`, and the ADO agent supplies a
 * declared default when the pipeline author leaves the input blank. So
 * `tasks.getInput('awsSessionName')` returned the constant on every real run,
 * `resolveRoleSessionName()` took its explicit-input branch, and the derivation
 * was dead code in production. The mock-runner tests could not see it: the mock
 * runner only supplies inputs a test sets with `tr.setInput()`, so it never
 * applies a manifest default. The fix was to clear both defaults; this table is
 * what keeps them cleared.
 *
 * Table-driven over EVERY session-name input the manifest declares, so an input
 * added for a fourth cloud is covered without a new test.
 *
 * Mutation-provability: restoring either `defaultValue` turns that input's
 * MANIFEST row RED and no other; making resolveRoleSessionName return its
 * `prefix` unconditionally turns the DERIVATION rows RED and no manifest row.
 */

const taskJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'task.json'), 'utf8'),
) as { inputs: Array<{ name: string; defaultValue?: string; helpMarkDown?: string }> };

/** Every input whose value becomes an AWS role session name. Derived, not listed. */
const SESSION_NAME_INPUTS = taskJson.inputs.filter((i) => /SessionName$/i.test(i.name));

/** The constants #197 removed. A default equal to any of these is the defect. */
const RETIRED_CONSTANTS = ['AzureDevOps-Terraform', 'AzureDevOps-Terraform-Backend'];

/** (input, prefix) pairs as wired in aws-terraform-command-handler.ts. */
const DERIVATION_ROWS: Array<{ input: string; prefix: string }> = [
    { input: 'awsSessionName', prefix: 'ado-tf' },
    { input: 'backendAWSSessionName', prefix: 'ado-tf-backend' },
];

describe('AWS role session name — manifest defaults and per-run derivation (class test #197)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
    const t = tasks as any;
    const origGetInput = t.getInput;
    const origGetVariable = t.getVariable;

    afterEach(() => {
        t.getInput = origGetInput;
        t.getVariable = origGetVariable;
    });

    it('the manifest declares at least one session-name input (the table is not vacuous)', () => {
        assert.ok(SESSION_NAME_INPUTS.length > 0, 'no *SessionName inputs found in task.json');
    });

    describe('MANIFEST — no declared default may re-pin a session name', () => {
        for (const input of SESSION_NAME_INPUTS) {
            it(`${input.name} declares no default`, () => {
                assert.ok(
                    !input.defaultValue,
                    `${input.name} declares defaultValue ${JSON.stringify(input.defaultValue)}. The agent supplies a ` +
                    'declared default when the author leaves the input blank, so resolveRoleSessionName() would take ' +
                    'its explicit-input branch on every run and the per-run derivation would never execute (#197).',
                );
            });

            it(`${input.name} does not document a retired constant`, () => {
                for (const retired of RETIRED_CONSTANTS) {
                    assert.ok(
                        !(input.helpMarkDown ?? '').includes(retired),
                        `${input.name}'s helpMarkDown still tells the user it defaults to '${retired}'`,
                    );
                }
            });
        }
    });

    describe('DERIVATION — a blank input yields a per-run, AWS-valid name', () => {
        for (const row of DERIVATION_ROWS) {
            it(`${row.input} derives ado-* from the job context`, () => {
                t.getInput = () => undefined;
                t.getVariable = (name: string) =>
                    name === 'System.TeamProject' ? 'Contoso Infra' : name === 'Build.BuildId' ? '4242' : undefined;

                const name = resolveRoleSessionName(row.input, row.prefix);

                assert.strictEqual(name, `${row.prefix}-Contoso-Infra-4242`);
                assert.ok(!RETIRED_CONSTANTS.includes(name), `${row.input} still resolves to a retired constant`);
                assert.ok(/^[A-Za-z0-9_+=,.@-]{2,64}$/.test(name),
                    `${row.input}: the derived name must satisfy AWS's RoleSessionName grammar; got '${name}'`);
            });

            it(`${row.input} still honours an explicit value`, () => {
                t.getInput = (n: string) => (n === row.input ? 'MyExplicitSession' : undefined);
                t.getVariable = () => undefined;
                assert.strictEqual(resolveRoleSessionName(row.input, row.prefix), 'MyExplicitSession');
            });

            it(`${row.input} rejects an explicit value AWS would reject`, () => {
                t.getInput = (n: string) => (n === row.input ? 'not a valid/session*name' : undefined);
                t.getVariable = () => undefined;
                assert.throws(() => resolveRoleSessionName(row.input, row.prefix), /not a valid AWS role session name/);
            });
        }
    });
});
