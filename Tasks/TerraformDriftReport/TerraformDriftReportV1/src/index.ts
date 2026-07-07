import tasks = require('azure-pipelines-task-lib/task');
import path = require('path');
import fs = require('fs');
import os = require('os');
import { randomUUID } from 'crypto';
import { summarize, moduleCallsPlan, Plan } from 'terraform-drift-contract';
import { postJson, truncateBody, resolveRejectUnauthorized } from './callback';
import { writeSarif } from './sarif';

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
    // Hoisted so the finally can optionally clean it up (see cleanupSummaryFile).
    let summaryFile: string | undefined;
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

        // The summary can include plan resource values (sensitive), so write it to
        // the agent's private temp dir with a unique name and owner-only (0600)
        // permissions, using O_EXCL to defeat a pre-existing-symlink hazard, rather
        // than a fixed, world-readable path in the shared OS temp directory.
        const tempDir = tasks.getVariable('Agent.TempDirectory') || os.tmpdir();
        summaryFile = path.join(tempDir, `tsm-drift-report-${randomUUID()}.json`);
        fs.writeFileSync(summaryFile, JSON.stringify(body, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        try { fs.chmodSync(summaryFile, 0o600); } catch { /* platforms without POSIX perms */ }

        tasks.setVariable('driftDetected', String(result.drifted), false, true);
        tasks.setVariable('addedCount', String(result.added), false, true);
        tasks.setVariable('changedCount', String(result.changed), false, true);
        tasks.setVariable('destroyedCount', String(result.destroyed), false, true);
        tasks.setVariable('summaryFilePath', summaryFile, false, true);

        if (tasks.getBoolInput('sarifOutput', false)) {
            const sarifFilePath = writeSarif(result, tasks.getInput('sarifPath', false));
            tasks.setVariable('sarifFilePath', sarifFilePath, false, true);
        }

        console.log(
            `Drift: drifted=${result.drifted} added=${result.added} changed=${result.changed} ` +
            `destroyed=${result.destroyed} (${result.summary.length} changed resources)`,
        );

        const callbackUrl = tasks.getInput('callbackUrl', false);
        const callbackToken = tasks.getInput('callbackToken', false);
        // Mask the one-shot callback token as soon as it is read, regardless of
        // whether the callback ends up being made.
        if (callbackToken) {
            tasks.setSecret(callbackToken);
        }
        if (callbackUrl && callbackToken) {
            // Fail-secure: an absent/blank rejectUnauthorized verifies TLS (see
            // resolveRejectUnauthorized); only an explicit "false" disables it.
            const rejectUnauthorized = resolveRejectUnauthorized(tasks.getInput('rejectUnauthorized', false));
            if (!rejectUnauthorized) {
                tasks.warning(
                    'rejectUnauthorized is disabled: TLS certificate validation is OFF for the drift callback, ' +
                    'so the callback token is sent over an unverified TLS channel. Use only for an internal TSM ' +
                    'endpoint fronted by a private CA the agent does not trust.',
                );
            }
            const resp = await postJson(
                callbackUrl,
                { 'X-TSM-Callback-Token': callbackToken },
                JSON.stringify(body),
                rejectUnauthorized,
            );
            if (resp.status < 200 || resp.status >= 300) {
                throw new Error(`Drift callback failed (HTTP ${resp.status}): ${truncateBody(resp.body)}`);
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
    } finally {
        // The summary file backs the summaryFilePath output var by default (downstream
        // steps read it). Operators who don't consume it -- and want the potentially
        // sensitive temp file gone immediately, e.g. on a self-hosted agent whose temp
        // dir is not wiped between jobs -- can opt into deleting it here.
        if (summaryFile && tasks.getBoolInput('cleanupSummaryFile', false)) {
            try { fs.unlinkSync(summaryFile); } catch { /* best effort */ }
        }
    }
}

void run();
