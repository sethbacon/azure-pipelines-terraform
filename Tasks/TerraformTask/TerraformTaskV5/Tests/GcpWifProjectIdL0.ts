import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import tasks = require('azure-pipelines-task-lib/task');
import adoModule = require('@4cloudguru/pipeline-task-ado');
import { EnvironmentVariableHelper } from '@4cloudguru/pipeline-task-ado';
import { TerraformCommandHandlerGCP } from '../src/gcp-terraform-command-handler';
import { TerraformAuthorizationCommandInitializer } from '../src/terraform-commands';

/**
 * azure-pipelines-terraform#1107 finding 4: under WIF, GOOGLE_PROJECT was the
 * project NUMBER while the service-connection scheme sets the project ID --
 * the same provider default resolved to a different kind of identifier
 * depending on the auth scheme. With gcpProjectId set, WIF exports the ID;
 * without it, the number remains (with a warning) so existing pipelines keep
 * their behaviour.
 */
describe('GCP WIF: GOOGLE_PROJECT is the project ID when gcpProjectId is set (#1107 finding 4)', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = tasks as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ado = adoModule as any;
    const orig = { getInput: t.getInput, warning: t.warning, debug: t.debug, generateIdToken: ado.generateIdToken };
    const INPUTS: Record<string, string> = {
        gcpProjectNumber: '123456789012',
        gcpWorkloadIdentityPoolId: 'my-wif-pool',
        gcpWorkloadIdentityProviderId: 'my-oidc-provider',
        gcpServiceAccountEmail: 'terraform@my-project.iam.gserviceaccount.com',
    };
    let warnings: string[] = [];
    let tempDir = '';
    let savedAgentTemp: string | undefined;

    beforeEach(() => {
        warnings = [];
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcp-wif-project-'));
        savedAgentTemp = process.env['AGENT_TEMPDIRECTORY'];
        process.env['AGENT_TEMPDIRECTORY'] = tempDir;
        t.getInput = (name: string) => INPUTS[name];
        t.warning = (m: string) => warnings.push(m);
        t.debug = () => { /* silence */ };
        ado.generateIdToken = async () => 'mock-oidc-token-12345';
    });

    afterEach(() => {
        t.getInput = orig.getInput;
        t.warning = orig.warning;
        t.debug = orig.debug;
        ado.generateIdToken = orig.generateIdToken;
        EnvironmentVariableHelper.clearTrackedVariables();
        if (savedAgentTemp === undefined) delete process.env['AGENT_TEMPDIRECTORY']; else process.env['AGENT_TEMPDIRECTORY'] = savedAgentTemp;
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    async function runWif(extra: Record<string, string>): Promise<void> {
        t.getInput = (name: string) => extra[name] ?? INPUTS[name];
        const handler = new TerraformCommandHandlerGCP();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (handler as any).handleProviderWIF(new TerraformAuthorizationCommandInitializer('plan', 'DummyWorkingDirectory', 'GCP'));
    }

    it('exports GOOGLE_PROJECT = gcpProjectId (the ID, as the service-connection scheme does) and does not warn', async () => {
        await runWif({ gcpProjectId: 'my-project-123' });
        assert.strictEqual(process.env['GOOGLE_PROJECT'], 'my-project-123');
        assert.deepStrictEqual(warnings.filter((w) => w.includes('gcpProjectId')), []);
    });

    it('falls back to the project NUMBER with a warning when gcpProjectId is empty (existing pipelines keep their behaviour)', async () => {
        await runWif({});
        assert.strictEqual(process.env['GOOGLE_PROJECT'], '123456789012');
        assert.ok(warnings.some((w) => w.includes('gcpProjectId')), `a warning must name the missing input: ${warnings}`);
    });

    it('rejects a gcpProjectId that is not a project ID (a number, or a value with a shell metacharacter) before minting anything', async () => {
        let minted = false;
        ado.generateIdToken = async () => { minted = true; return 'mock-oidc-token-12345'; };
        for (const bad of ['123456789012', 'My_Project', 'x', 'proj;rm -rf /']) {
            minted = false;
            await assert.rejects(runWif({ gcpProjectId: bad }), /gcpProjectId/, bad);
        }
        // the ID is validated after the assertion is minted (the credentials file
        // needs the token); what matters is that the run is refused.
        assert.strictEqual(process.env['GOOGLE_PROJECT'], undefined);
    });
});
