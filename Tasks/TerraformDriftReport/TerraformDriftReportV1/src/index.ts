import tasks = require('azure-pipelines-task-lib/task');
import path = require('path');
import fs = require('fs');
import os = require('os');
import { randomUUID } from 'crypto';
import { summarize, moduleCallsPlan, Plan, Result } from '@4cloudguru/terraform-drift-contract';
import { postJsonWithRetry, truncateBody, resolveRejectUnauthorized, resolveFailOnCallbackError, assertRejectUnauthorizedNotAgainstPublicHost } from './callback';
import { writeSarif } from './sarif';
import { isWithinWorkingDirectory } from './path-containment';
import { writeSecretFile, scrubFile } from '@4cloudguru/pipeline-task-ado';

/**
 * Upper bound on the JSON files this task reads into memory (the required plan
 * JSON and the optional module manifest). An unbounded `fs.readFileSync` + JSON
 * parse of a pathological/wrong file can cause excessive memory use or a hang
 * (#632, CWE-400), mirroring TerraformTaskV5's backend-detection MAX_BACKEND_
 * STATE_BYTES guard. Generous: a real `show -json` plan for a large estate is
 * legitimately tens of MB, but a runaway can't exhaust the agent.
 */
export const MAX_PLAN_JSON_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * The wire contract with TSM: what this task POSTs to the drift callback, and
 * byte-for-byte what it writes as the on-agent summary artifact.
 *
 * It used to be a bare `Record<string, unknown>` assembled by naming the
 * contract's fields one at a time (#950). Both halves of that were the bug. The
 * pick list could only ever describe the contract as of the day it was written,
 * and `Record<string, unknown>` accepts anything, so `tsc` could not report that
 * `summarize()` had begun returning fields the body did not carry. The omission
 * was invisible to the entire toolchain.
 *
 * Contract 1.2.0 is where that bill came due: it added five markers describing
 * what a check did NOT do -- `unparseable`, `unmasked`, `truncated`,
 * `omitted_entries`, `omitted_attrs` -- and this task forwarded none of them.
 * `unparseable` is the one that changed an answer. A truncated `terraform show
 * -json`, a wrong file and an empty `{}` all summarize to `added: 0, changed: 0,
 * destroyed: 0, drifted: false`, byte-identical to a verified-clean plan, and
 * TSM auto-resolved the live drift record on receiving one.
 *
 * So `extends Result` rather than a copy of its members, and the body below is a
 * SPREAD of the summarize() result: the contract's own type is the field list,
 * every field of it is required here, a field the contract adds next is
 * forwarded by construction, and dropping one is a compile error rather than a
 * silent omission.
 *
 * The wire names are the contract's field names unchanged -- which is what the
 * backend decodes (`completeness`, internal/api/drift_records.go) and what its
 * generated jq templates already post. That callback deliberately does NOT use
 * DisallowUnknownFields, because its token is one-shot and a rejected body would
 * strand the run permanently; the cost of that leniency is that a renamed or
 * missing key is dropped in silence, which is exactly how this went unnoticed.
 */
export interface CallbackBody extends Result {
    status: string;
    detail: string;
    /** Module provenance; present only with includeModuleProvenance. */
    plan?: unknown;
    module_locks?: unknown;
}

// Reads `.terraform/modules/modules.json` verbatim for the callback's
// module_locks field; null when absent/unreadable/oversized/out-of-bounds (the
// backend then records provenance without locked versions).
function readModuleLocks(manifestPath: string): unknown {
    // moduleManifest is an operator-supplied task input with no built-in
    // path-resolution/containment guarantee. Constrain it to the working
    // directory (symlinks resolved) before touching the filesystem -- otherwise
    // a value like '../../secrets/x.json' (or an in-tree symlink pointing
    // outside) could read an arbitrary file's contents into the callback body
    // and the on-agent summary artifact (#1031).
    const resolved = path.resolve(manifestPath);
    if (!isWithinWorkingDirectory(resolved, process.cwd())) {
        tasks.warning(`Module manifest '${manifestPath}' resolves outside the working directory (${resolved}); skipping module_locks.`);
        return null;
    }
    // Opened once and stat/read via that same descriptor (not an existsSync +
    // statSync + readFileSync sequence on the path) so there is no window
    // between the size check and the read where the path could be repointed
    // at a different, larger file (TOCTOU / CWE-367).
    let fd: number;
    try {
        fd = fs.openSync(manifestPath, 'r');
    } catch {
        return null;
    }
    try {
        // Skip an implausibly large manifest rather than risk an unbounded read
        // (best-effort field; degrade gracefully, like backend-detection.ts).
        const size = fs.fstatSync(fd).size;
        if (size > MAX_PLAN_JSON_BYTES) {
            tasks.debug(`Module manifest ${manifestPath} exceeds the ${MAX_PLAN_JSON_BYTES}-byte guard; skipping module_locks.`);
            return null;
        }
        return JSON.parse(fs.readFileSync(fd, 'utf8'));
    } catch {
        return null;
    } finally {
        fs.closeSync(fd);
    }
}

async function run(): Promise<void> {
    tasks.setResourcePath(path.join(__dirname, '..', 'task.json'));
    // Hoisted so the finally can optionally clean it up (see cleanupSummaryFile).
    let summaryFile: string | undefined;
    // Hoisted so emergencyCleanup (below) can scrub+delete it too (#882) -- set
    // only when sarifOutput is enabled.
    let sarifFile: string | undefined;

    // #775: Node terminates immediately on an unhandled SIGTERM/SIGINT without
    // running the try/finally below, so a pipeline cancellation mid-run would
    // otherwise leave the writeSecretFile'd summary (which can hold sensitive plan
    // values) on disk -- scrubbed only by the agent's end-of-job temp purge, a
    // plain delete rather than a secure overwrite, and not at all when
    // Agent.TempDirectory is unset and os.tmpdir() is used. On a cancellation there
    // is no downstream step left to read summaryFilePath, so scrub+delete it
    // unconditionally here (the normal-completion path below keeps the opt-in
    // cleanupSummaryFile gate). Registering a signal listener suppresses Node's
    // default terminate-on-signal behavior, so each handler must also re-raise the
    // signal with its default disposition. Mirrors TerraformTaskV5's index.ts.
    const emergencyCleanup = () => {
        if (summaryFile && fs.existsSync(summaryFile)) {
            try {
                scrubFile(summaryFile);
            } catch { /* best-effort scrub before the unlink below */ }
            try {
                fs.unlinkSync(summaryFile);
            } catch { /* best-effort: the agent temp purge is the backstop */ }
        }
        // #882: the SARIF report is the same plan-derived, writeSecretFile'd class
        // of temp file as summaryFile above (same job, written moments later) --
        // without this it was the one such file in this task never registered
        // with the emergency path, so a cancellation left it behind unscrubbed.
        if (sarifFile && fs.existsSync(sarifFile)) {
            try {
                scrubFile(sarifFile);
            } catch { /* best-effort scrub before the unlink below */ }
            try {
                fs.unlinkSync(sarifFile);
            } catch { /* best-effort: the agent temp purge is the backstop */ }
        }
    };
    const handleTerminationSignal = (signal: NodeJS.Signals) => {
        emergencyCleanup();
        process.removeListener(signal, handleTerminationSignal);
        process.kill(process.pid, signal);
    };
    process.on('SIGTERM', handleTerminationSignal);
    process.on('SIGINT', handleTerminationSignal);
    process.on('uncaughtException', (err) => {
        emergencyCleanup();
        tasks.setResult(tasks.TaskResult.Failed, `Uncaught exception: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    });
    process.on('unhandledRejection', (reason) => {
        emergencyCleanup();
        tasks.setResult(tasks.TaskResult.Failed, `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
        process.exit(1);
    });

    try {
        const planFile = path.resolve(tasks.getInput('planJsonFile', true)!);
        const planStat = fs.existsSync(planFile) ? fs.statSync(planFile) : undefined;
        if (!planStat) {
            throw new Error(tasks.loc('PlanFileNotFound', planFile));
        }
        // Bound the read before it happens: a huge/wrong file would otherwise be
        // slurped whole and JSON-parsed, risking excessive memory or a hang
        // (#632). Fail closed with a clear diagnostic since the plan is required.
        if (planStat.size > MAX_PLAN_JSON_BYTES) {
            throw new Error(tasks.loc('PlanFileTooLarge', planFile, planStat.size, MAX_PLAN_JSON_BYTES));
        }

        // Surface a malformed/truncated plan file as a clear diagnostic naming the
        // file rather than a raw SyntaxError from the top-level catch.
        let plan: Plan;
        try {
            plan = JSON.parse(fs.readFileSync(planFile, 'utf8')) as Plan;
        } catch (err) {
            throw new Error(tasks.loc('PlanFileInvalidJson', planFile, err instanceof Error ? err.message : err));
        }
        const result = summarize(plan);

        const detail = tasks.getInput('detail', false) || '';
        const includeProvenance = tasks.getBoolInput('includeModuleProvenance', false);

        // Spread, not a pick list. Everything the contract computed goes on the
        // wire, including the markers that say what this check did NOT do; only
        // the two fields the contract does not own are added here.
        const body: CallbackBody = {
            ...result,
            status: 'completed',
            detail,
        };
        if (includeProvenance) {
            body.plan = moduleCallsPlan(plan);
            const manifest = tasks.getInput('moduleManifest', false) || '.terraform/modules/modules.json';
            body.module_locks = readModuleLocks(manifest);
        }

        // The summary can include plan resource values (sensitive), so write it to
        // the agent's private temp dir with a unique name via the shared
        // writeSecretFile primitive: owner-only (0600) + O_EXCL on Unix (defeating a
        // pre-existing-symlink hazard) and an explicit restrictive DACL on Windows
        // (where 0600 is a no-op), both fail closed -- see secure-temp.ts, a
        // byte-identical copy of TerraformTaskV5's module gated by
        // scripts/check-shared-modules.js (#607) -- rather than a fixed,
        // world-readable path in the shared OS temp directory.
        const tempDir = tasks.getVariable('Agent.TempDirectory') || os.tmpdir();
        summaryFile = path.join(tempDir, `tsm-drift-report-${randomUUID()}.json`);
        writeSecretFile(summaryFile, JSON.stringify(body, null, 2));

        tasks.setVariable('driftDetected', String(result.drifted), false, true);
        tasks.setVariable('addedCount', String(result.added), false, true);
        tasks.setVariable('changedCount', String(result.changed), false, true);
        tasks.setVariable('destroyedCount', String(result.destroyed), false, true);
        tasks.setVariable('summaryFilePath', summaryFile, false, true);

        if (tasks.getBoolInput('sarifOutput', false)) {
            sarifFile = writeSarif(result, tasks.getInput('sarifPath', false), tempDir);
            tasks.setVariable('sarifFilePath', sarifFile, false, true);
        }

        console.log(
            tasks.loc('DriftSummary', result.drifted, result.added, result.changed, result.destroyed, result.summary.length),
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
                // Refuses outright against a genuinely public callback host (#588) --
                // disabling TLS verification only makes sense for an internal
                // endpoint fronted by a private CA the agent doesn't trust.
                await assertRejectUnauthorizedNotAgainstPublicHost(callbackUrl);
                tasks.warning(tasks.loc('RejectUnauthorizedDisabled'));
            }
            const resp = await postJsonWithRetry(
                callbackUrl,
                { 'X-TSM-Callback-Token': callbackToken },
                JSON.stringify(body),
                rejectUnauthorized,
                undefined,
                { log: (message) => tasks.warning(message) },
            );
            if (resp.status < 200 || resp.status >= 300) {
                // Fail-secure: an absent/blank failOnCallbackError preserves the task's
                // original behavior (fail); only an explicit "false" makes this non-fatal
                // (see resolveFailOnCallbackError).
                if (resolveFailOnCallbackError(tasks.getInput('failOnCallbackError', false))) {
                    throw new Error(tasks.loc('DriftCallbackFailed', resp.status, truncateBody(resp.body)));
                }
                tasks.warning(tasks.loc('DriftCallbackNonFatal', resp.status, truncateBody(resp.body)));
            } else {
                console.log(tasks.loc('DriftPostedToTsm', resp.status));
            }
        } else if (callbackUrl || callbackToken) {
            tasks.warning(tasks.loc('CallbackUrlAndTokenRequired'));
        }

        if (result.drifted && tasks.getBoolInput('failOnDrift', false)) {
            tasks.setResult(tasks.TaskResult.Failed, tasks.loc('DriftDetectedFailed', result.summary.length));
        } else {
            tasks.setResult(tasks.TaskResult.Succeeded, result.drifted ? tasks.loc('DriftDetectedMessage') : tasks.loc('NoDriftMessage'));
        }
    } catch (error) {
        tasks.setResult(tasks.TaskResult.Failed, error instanceof Error ? error.message : String(error));
    } finally {
        // The summary file backs the summaryFilePath output var by default (downstream
        // steps read it). Operators who don't consume it -- and want the potentially
        // sensitive temp file gone immediately, e.g. on a self-hosted agent whose temp
        // dir is not wiped between jobs -- can opt into deleting it here.
        if (summaryFile && tasks.getBoolInput('cleanupSummaryFile', false)) {
            try {
                // Mirrors TerraformTaskV5's scrubAndUnlink: skip silently if the file
                // was never created (e.g. an earlier failure before writeSecretFile
                // ran) rather than emit a misleading ENOENT warning below.
                if (fs.existsSync(summaryFile)) {
                    // Scrub the content (overwrite with zeros) before unlinking, matching
                    // every other credential/sensitive temp file in this codebase (#595):
                    // a bare unlink only removes the directory entry, leaving the plan
                    // values in this summary file recoverable on disk until overwritten.
                    // A scrub failure is surfaced but does not skip the unlink attempt.
                    try {
                        scrubFile(summaryFile);
                    } catch (scrubErr) {
                        tasks.warning(`Failed to scrub summary file ${summaryFile} before deletion: ${scrubErr}`);
                    }
                    fs.unlinkSync(summaryFile);
                    tasks.debug(`Cleaned up summary file: ${summaryFile}`);
                }
            } catch (err) {
                // A leftover summary file (which can hold sensitive plan values) is a
                // real exposure on a self-hosted agent -- surface it above debug,
                // matching TerraformTaskV5's scrubAndUnlink rationale.
                tasks.warning(`Failed to clean up summary file ${summaryFile}: ${err}`);
            }
        }
        process.removeListener('SIGTERM', handleTerminationSignal);
        process.removeListener('SIGINT', handleTerminationSignal);
    }
}

void run();
