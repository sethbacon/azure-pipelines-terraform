import tasks = require('azure-pipelines-task-lib/task');
import path = require('path');
import fs = require('fs');
import os = require('os');
import { summarize, moduleCallsPlan, Plan } from 'terraform-drift-contract';
import { postJson } from './callback';

// Reads `.terraform/modules/modules.json` verbatim for the callback's
// module_locks field; null when absent/unreadable (the backend then records
// provenance without locked versions).
function readModuleLocks(manifestPath: string): unknown {
    try {
        if (!fs.existsSync(manifestPath)) {
            return null;
        }
        return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
        return null;
    }
}

async function run(): Promise<void> {
    tasks.setResourcePath(path.join(__dirname, '..', 'task.json'));
    try {
        const planFile = path.resolve(tasks.getInput('planJsonFile', true)!);
        if (!fs.existsSync(planFile)) {
            throw new Error(
                `planJsonFile does not exist: ${planFile}. Provide the JSON output of ` +
                `'terraform show -json <plan>' (or 'tofu show -json <plan>').`,
            );
        }

        const plan = JSON.parse(fs.readFileSync(planFile, 'utf8')) as Plan;
        const result = summarize(plan);

        const detail = tasks.getInput('detail', false) || '';
        const includeProvenance = tasks.getBoolInput('includeModuleProvenance', false);

        const body: Record<string, unknown> = {
            status: 'completed',
            added: result.added,
            changed: result.changed,
            destroyed: result.destroyed,
            drifted: result.drifted,
            summary: result.summary,
            detail,
        };
        if (includeProvenance) {
            body.plan = moduleCallsPlan(plan);
            const manifest = tasks.getInput('moduleManifest', false) || '.terraform/modules/modules.json';
            body.module_locks = readModuleLocks(manifest);
        }

        const summaryFile = path.join(os.tmpdir(), 'tsm-drift-report.json');
        fs.writeFileSync(summaryFile, JSON.stringify(body, null, 2), 'utf8');

        tasks.setVariable('driftDetected', String(result.drifted), false, true);
        tasks.setVariable('addedCount', String(result.added), false, true);
        tasks.setVariable('changedCount', String(result.changed), false, true);
        tasks.setVariable('destroyedCount', String(result.destroyed), false, true);
        tasks.setVariable('summaryFilePath', summaryFile, false, true);

        console.log(
            `Drift: drifted=${result.drifted} added=${result.added} changed=${result.changed} ` +
            `destroyed=${result.destroyed} (${result.summary.length} changed resources)`,
        );

        const callbackUrl = tasks.getInput('callbackUrl', false);
        const callbackToken = tasks.getInput('callbackToken', false);
        if (callbackUrl && callbackToken) {
            const rejectUnauthorized = tasks.getBoolInput('rejectUnauthorized', false);
            const resp = await postJson(
                callbackUrl,
                { 'X-TSM-Callback-Token': callbackToken },
                JSON.stringify(body),
                rejectUnauthorized,
            );
            if (resp.status < 200 || resp.status >= 300) {
                throw new Error(`Drift callback failed (HTTP ${resp.status}): ${resp.body}`);
            }
            console.log(`Drift result posted to TSM (HTTP ${resp.status}).`);
        } else if (callbackUrl || callbackToken) {
            tasks.warning('Both callbackUrl and callbackToken are required to POST results; skipping callback.');
        }

        if (result.drifted && tasks.getBoolInput('failOnDrift', false)) {
            tasks.setResult(tasks.TaskResult.Failed, `Drift detected: ${result.summary.length} changed resource(s).`);
        } else {
            tasks.setResult(tasks.TaskResult.Succeeded, result.drifted ? 'Drift detected.' : 'No drift.');
        }
    } catch (error) {
        tasks.setResult(tasks.TaskResult.Failed, error instanceof Error ? error.message : String(error));
    }
}

void run();
