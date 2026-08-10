import { TempFileManager } from './temp-file-manager';
import { replaceSecretFile, writeSecretFile } from './secure-temp';
import { DigestBuildMeta } from './results/digest-common';
import { Digest } from './results/digest-schema';
import { serializeDigest, maskHasSensitiveLeaf } from './results/redact';
import { buildApplyDigest, ApplyDigestOptions, parseNdjsonLines } from './results/apply-digest';
import { scrubSecrets } from './results/secret-scrub';
import { EnvironmentVariableHelper } from './environment-variables';
import tasks = require('azure-pipelines-task-lib/task');
import path = require('path');
import { randomUUID as uuidV4 } from 'crypto';
import fs = require('fs');
import os = require('os');

/**
 * Reads this task's own version from task.json (Major.Minor.Patch) for the
 * structured digest's `producedBy.taskVersion` field (design §4.1). Falls back
 * to 'unknown' rather than throwing -- a version-read failure must not prevent
 * an already-redacted, already-computed digest from being attached.
 */
export function getTaskVersion(): string {
    try {
        const raw = fs.readFileSync(path.join(__dirname, '..', 'task.json'), 'utf-8');
        const v = JSON.parse(raw).version;
        return `${v.Major}.${v.Minor}.${v.Patch}`;
    } catch {
        return 'unknown';
    }
}

/**
 * The digest's `meta.workingDirectory` must be a relative path only, never an
 * absolute host filesystem path (design §4.1 -- avoids leaking agent directory
 * layout into a build-read-scoped attachment). The `workingDirectory` task
 * input is normally relative, but is not validated as such; an absolute value
 * is simply omitted rather than passed through.
 */
export function relativeWorkingDirectoryForDigest(workingDirectory: string): string | undefined {
    if (!workingDirectory || path.isAbsolute(workingDirectory)) return undefined;
    return workingDirectory;
}

/** Sanity bound on any value handed to tasks.setVariable(). */
const OUTPUT_VAR_MAX_LENGTH = 1024;

/**
 * Turns a finished terraform command's output into the things a pipeline
 * consumes: build attachments, TF_OUT_* variables, console echo, output files
 * and sensitivity warnings.
 *
 * Split out of BaseTerraformCommandHandler for #878. Everything here reads
 * terraform's output and writes somewhere a pipeline can see; nothing here
 * decides what command to run or how to run it. That boundary is the reason
 * publishPlanSummaryAttachment/publishStateSummaryAttachment did NOT come
 * along: both shell out to `terraform show` first, so they need the tool
 * handler and the command executor and belong with the per-command
 * orchestration that is still in the handler.
 *
 * Takes the {@link TempFileManager} because two sensitivity checks register
 * the cleartext file they just inspected for scrub+delete before failing the
 * task -- the failure must not leave the values on disk.
 */
export class ResultsPublisher {
    constructor(private readonly tempFileManager: TempFileManager) { }

    /**
     * Writes a terraform command's captured stdout (show/output/custom -- any
     * of which can carry unredacted `sensitive = true` values, most notably
     * `terraform output -json`) to disk with restrictive 0600 permissions
     * instead of the default umask. The parent directory is created first
     * since `show`/`custom` accept a caller-supplied, possibly-nested
     * `filename`. Because that filename is user-supplied and predictable, the
     * write refuses a pre-planted symlink and re-creates the file exclusively
     * (see replaceSecretFile) instead of writing through whatever is already
     * there (#484).
     */
    writeCommandOutputFile(filePath: string, content: string): void {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        replaceSecretFile(filePath, content);
    }

    /**
     * Builds the DigestMeta identity/provenance fields (design §4.1) shared by
     * both the plan and apply structured attachments.
     */
    buildDigestMeta(publishName: string, workingDirectory: string): DigestBuildMeta {
        return {
            taskVersion: getTaskVersion(),
            toolName: 'terraform',
            name: publishName,
            workingDirectory: relativeWorkingDirectoryForDigest(workingDirectory),
            stage: tasks.getVariable('System.StageDisplayName') || undefined,
            job: tasks.getVariable('System.JobDisplayName') || undefined,
            createdIso: tasks.getVariable('System.PipelineStartTime') || new Date().toISOString(),
        };
    }

    /**
     * Shared tail of the three structured-summary publishers (plan/state/apply):
     * writes the serialized digest to a uuid-named file under tempDir and
     * attaches it as `terraform-<kind>-summary`. Deliberately NOT pushed onto
     * `tempFiles`: the agent uploads attachment files asynchronously after
     * reading the ##vso[task.addattachment] line from stdout, so
     * cleanupTempFiles() would unlink the file before the upload (see the
     * publishPlanResults comment in plan()). Written via the 0600/DACL
     * secret-file primitive (#881), matching the raw terraform-plan-results
     * attachment above: the digest is redacted but is still plan/state/apply
     * -derived, and is published as a build attachment readable by anyone
     * with build-read.
     */
    writeAndAttachDigest(kind: 'plan' | 'state' | 'apply', digest: Digest, tempDir: string): void {
        const digestPath = path.join(tempDir, `terraform-${kind}-summary-${uuidV4()}.json`);
        writeSecretFile(digestPath, serializeDigest(digest));
        tasks.addAttachment(`terraform-${kind}-summary`, digest.meta.name, digestPath);
    }

    /**
     * Extracts error-severity diagnostic summaries from apply's `-json` NDJSON
     * stdout (#750). Mirrors apply-digest.ts's own NDJSON line-parsing and
     * `diagnostic` event shape (`{diagnostic: {severity, summary, ...}}`), kept
     * intentionally lighter-weight here: this is a one-shot extraction for an
     * error message, not the full digest, so no caps or detail-toggle plumbing.
     * Malformed lines are skipped silently, same as the digest builder's own
     * tolerance for a partial/truncated NDJSON stream.
     *
     * Each summary is scrubbed via scrubSecrets() with the SAME knownSecrets
     * source (EnvironmentVariableHelper.getTrackedSecretValues()) the production
     * digest call site uses -- this text reaches the thrown error unconditionally
     * (unlike the digest attachment's own includeDiagnostics opt-in gate, #613's
     * stderr-fold precedent is likewise unconditional), so it must carry the same
     * redaction guarantee the digest's `summary` field always gets.
     */
    extractApplyErrorDiagnostics(ndjson: string): string[] {
        const knownSecrets = EnvironmentVariableHelper.getTrackedSecretValues();
        const summaries: string[] = [];
        // Shared tolerant NDJSON parse (#781): yields only object events, dropping
        // malformed/non-object lines exactly as this pass did inline before.
        for (const event of parseNdjsonLines(ndjson).events) {
            const diagnostic = (event as Record<string, unknown>).diagnostic;
            if (!diagnostic || typeof diagnostic !== 'object') continue;
            const d = diagnostic as Record<string, unknown>;
            if (d.severity === 'error' && typeof d.summary === 'string' && d.summary) {
                summaries.push(scrubSecrets(d.summary, knownSecrets));
            }
        }
        return summaries;
    }

    /**
     * Echoes each `apply -json` NDJSON event's `@message` field to the console
     * so the live log stays human-readable when `-json` replaces Terraform's
     * normal human-readable apply output (design D2/§5.4). Never echoes raw
     * structured event fields -- only the already-human-readable `@message`
     * line Terraform itself produced; the structured fields are consumed only
     * by the redaction pipeline. Malformed lines are skipped silently here --
     * apply-digest.ts's own parser separately counts and notes them in the
     * digest's truncationNotes.
     *
     * `@message` is least-trusted content (provider/module/remote-state
     * controlled) reaching a raw console.log sink, unlike tasks.* calls which
     * route through azure-pipelines-task-lib's own newline-escaping. An
     * embedded newline followed by a `##vso[`/`##[` marker could otherwise
     * forge an ADO logging command, so each physical line is echoed
     * separately (see #678) and neutralized via echoSafeConsoleLine().
     */
    echoApplyMessages(ndjson: string): void {
        // Shared tolerant NDJSON parse (#781): yields only object events, silently
        // dropping malformed lines exactly as this pass did inline before.
        for (const event of parseNdjsonLines(ndjson).events) {
            const message = (event as Record<string, unknown>)['@message'];
            if (typeof message === 'string') {
                this.echoSafeConsoleLine(message);
            }
        }
    }

    /**
     * Prints least-trusted, multi-line-capable text to the console one
     * physical line at a time, neutralizing any leading `##` marker on each
     * resulting line so it cannot be interpreted by the ADO agent as a
     * `##vso[...]`/`##[...]` logging command (CWE-117). Splitting on
     * newlines first (rather than filtering the whole string) preserves the
     * message's own intentional line breaks for readability.
     *
     * Splits on the full ECMAScript LineTerminatorSequence set (`\r\n`, `\n`,
     * `\r`, and the Unicode line/paragraph separators U+2028/U+2029) -- a
     * JSON string escape (`\u2028`) can carry one of the latter two through
     * JSON.parse just like `\n`, and some consoles/terminals render them as a
     * new line even though a plain `/\r?\n/` split would not treat them as a
     * boundary, which would let a leading `##` past this check undetected.
     */
    echoSafeConsoleLine(message: string): void {
        for (const line of message.split(/\r\n|[\r\n\u2028\u2029]/)) {
            console.log(line.replace(/^(\s*)##/, '$1# #'));
        }
    }

    /**
     * Builds and attaches the redacted ApplyDigest (`terraform-apply-summary`)
     * for the structured results path (design §7).
     */
    async publishApplySummaryAttachment(
        ndjson: string,
        workingDirectory: string,
        publishName: string,
    ): Promise<void> {
        const tempDir = tasks.getVariable("Agent.TempDirectory") || os.tmpdir();
        // includeDiagnostics defaults to FALSE (opt-IN): diagnostics are omitted
        // unless the operator explicitly enables them (safe default — a
        // provider-echoed short secret in a diagnostic must not land in the
        // build-read-readable attachment by default).
        const includeDiagnostics = tasks.getBoolInput('includeDiagnostics', false);
        const options: ApplyDigestOptions = {
            // Operator opt-in for the provider-echoed-secret residual (§5.10): unless
            // explicitly set true, the whole diagnostics array is omitted so no
            // freeform provider text reaches the (build-read-wide) attachment; the
            // failure is still detectable via outcome + the agent-secret-masked live
            // console log.
            includeDiagnostics,
            includeDiagnosticDetail: tasks.getBoolInput('includeDiagnosticDetail', false),
            // §5.4 / #694 / #886: exact-match redaction covers every credential this
            // task has masked, including the federated ones minted mid-command (the
            // ADO OIDC JWT, the OCI UPST, the ephemeral RSA key, the PAR URL) that
            // never become environment variables. Those previously reached this
            // attachment covered only by the 40-char entropy heuristic -- incidental
            // coverage that a shorter token, or one the heuristic fragments on a `.`
            // or `:`, would have slipped through. Build attachments are not
            // agent-masked (SECURITY.md), so on this path the heuristic was the only
            // control. Mitigated further by includeDiagnostics (above) and by
            // includeDiagnosticDetail defaulting to false.
            knownSecrets: EnvironmentVariableHelper.getTrackedSecretValues(),
        };

        const digest = buildApplyDigest(ndjson, this.buildDigestMeta(publishName, workingDirectory), options);
        this.writeAndAttachDigest('apply', digest, tempDir);
    }

    /**
     * State/output content a compromised module or provider can fully
     * control must not reach tasks.setVariable() unsanitized: a value
     * containing control characters (e.g. an embedded newline) could forge
     * additional ADO logging commands in the console output that consumes
     * this variable downstream. Also caps length as a sanity bound.
     */
    sanitizeOutputVariableValue(value: string): string | null {
        if (!value || value.length > OUTPUT_VAR_MAX_LENGTH) return null;
        return /^[\x20-\x7E]+$/.test(value) ? value : null;
    }

    setOutputVariables(jsonOutput: string): void {
        try {
            const outputs = JSON.parse(jsonOutput);
            for (const [key, outputDef] of Object.entries(outputs)) {
                const def = outputDef as { value?: unknown; sensitive?: boolean; type?: unknown };
                if (def.value === undefined) continue;

                const stringValue = typeof def.value === 'object'
                    ? JSON.stringify(def.value)
                    : String(def.value);

                const safeValue = this.sanitizeOutputVariableValue(stringValue);
                if (safeValue === null) {
                    tasks.warning(`Output '${key}' failed output-variable validation (length/printable-ASCII); skipping TF_OUT_${key}.`);
                    continue;
                }

                const isSecret = def.sensitive === true;
                tasks.setVariable(`TF_OUT_${key}`, safeValue, isSecret, true);
                tasks.debug(`Set pipeline variable TF_OUT_${key}${isSecret ? ' (secret)' : ''}`);
            }
        } catch (err) {
            // #783: a parse failure here silently populates ZERO TF_OUT_* variables,
            // which a downstream step reads as empty/undefined with no explanation.
            // Surface it at warning (visible by default), matching the sibling
            // detectDestroyChanges / warnIfSensitiveOutputs handlers rather than the
            // System.Debug-only visibility this previously had.
            tasks.warning(`Could not parse terraform output as JSON for pipeline variables; no TF_OUT_* variables were set: ${err}`);
        }
    }

    detectDestroyChanges(jsonOutput: string): void {
        try {
            const plan = JSON.parse(jsonOutput);
            const resourceChanges = plan.resource_changes;
            if (!Array.isArray(resourceChanges)) return;

            const hasDestroy = resourceChanges.some((rc: { change?: { actions?: string[] } }) =>
                rc.change?.actions?.includes('delete')
            );
            tasks.setVariable('destroyChangesPresent', hasDestroy.toString(), false, true);
            if (hasDestroy) {
                tasks.warning("Terraform plan contains resource deletions. Review carefully before applying.");
            }
        } catch (err) {
            tasks.warning(`Could not parse terraform show output for destroy-change detection; the deletion safety warning did not run: ${err}`);
        }
    }

    /**
     * Detects `sensitive = true` outputs (and resource attributes) in a
     * `terraform show -json` plan. Warns by default; when the opt-in
     * `failOnSensitiveOutputs` input is set, sensitive *outputs* instead fail
     * the task (#488). Sensitive resource *attributes* stay warning-only even
     * in strict mode: nearly every real plan carries some, so failing on them
     * would make the strict mode unusable.
     *
     * `filePath` is the just-written output file for the `outputTo=file`
     * branch (registered for end-of-step deletion before a strict failure so
     * the cleartext values are not left behind), or `undefined` for the
     * `outputTo=console` branch (audit id0) -- there is no file to clean up
     * there, and the caller is expected to invoke this BEFORE echoing the
     * captured stdout, so a strict failure throws before anything reaches the
     * console at all rather than merely warning after the fact.
     */
    warnIfSensitiveOutputs(jsonOutput: string, filePath: string | undefined): boolean {
        let plan: { planned_values?: { outputs?: unknown }, resource_changes?: unknown };
        try {
            plan = JSON.parse(jsonOutput);
        } catch (error) {
            tasks.warning(`Could not parse terraform plan for sensitive-output detection; the sensitive-value safety warning did not run: ${String(error)}`);
            return false;
        }

        // #802: track whether the plan carries ANY sensitive content (outputs or
        // resource attributes) so the show() outputTo=file path can auto-register
        // the just-written file for scrub+delete, mirroring output()'s #650 handling.
        let sensitive = false;

        // Check for sensitive values in planned_values outputs. maskHasSensitiveLeaf
        // shares its "mask === true at any depth" predicate with the WP-1 redaction
        // core (design §5.2.7) so this detection cannot silently drift from what the
        // structured digest actually redacts.
        const outputs = plan?.planned_values?.outputs;
        if (outputs && typeof outputs === 'object') {
            const sensitiveKeys = Object.entries(outputs)
                .filter(([, v]) => maskHasSensitiveLeaf((v as { sensitive?: unknown }).sensitive))
                .map(([k]) => k);
            if (sensitiveKeys.length > 0) {
                sensitive = true;
                if (tasks.getBoolInput('failOnSensitiveOutputs', false)) {
                    if (filePath) {
                        this.tempFileManager.track(filePath);
                        throw new Error(tasks.loc('ShowSensitiveOutputsStrictFailure', filePath, sensitiveKeys.length, sensitiveKeys.join(', ')));
                    }
                    throw new Error(tasks.loc('ShowSensitiveOutputsConsoleStrictFailure', sensitiveKeys.length, sensitiveKeys.join(', ')));
                }
                if (filePath) {
                    tasks.warning(`Terraform plan output file contains ${sensitiveKeys.length} sensitive output(s): ${sensitiveKeys.join(', ')}. Ensure this file is not published as a pipeline artifact.`);
                } else {
                    tasks.warning(`Terraform show -json output printed to the console contains ${sensitiveKeys.length} sensitive output(s): ${sensitiveKeys.join(', ')}. This build log may be retained and is readable by anyone with pipeline read access.`);
                }
            }
        }

        // Check for sensitive attributes in resource changes. Recursive (via
        // maskHasSensitiveLeaf) so sensitivity nested under an object/array mask is
        // caught too, not just a top-level `{key: true}` entry -- the previous
        // one-level-only scan could miss it.
        const resourceChanges = plan?.resource_changes;
        if (Array.isArray(resourceChanges)) {
            const sensitiveResources = resourceChanges.filter((rc: { change?: { after_sensitive?: unknown } }) =>
                maskHasSensitiveLeaf(rc.change?.after_sensitive)
            );
            if (sensitiveResources.length > 0) {
                sensitive = true;
                if (filePath) {
                    tasks.warning(`Terraform plan contains ${sensitiveResources.length} resource(s) with sensitive attributes. The output file may contain unredacted secrets.`);
                } else {
                    tasks.warning(`Terraform plan contains ${sensitiveResources.length} resource(s) with sensitive attributes. The console output may contain unredacted secrets.`);
                }
            }
        }

        return sensitive;
    }

    /**
     * `terraform output -json` emits every output's real value in cleartext,
     * including ones declared `sensitive = true` in configuration (Terraform
     * only redacts the human-readable console format, not `-json`). Warn
     * loudly when that's the case so the file written by
     * writeCommandOutputFile() -- restrictive permissions and its job-purged
     * Agent.TempDirectory location (#492) notwithstanding -- doesn't get
     * casually published as a build artifact or left for a downstream step to
     * mishandle before the agent purges it at job end. When the opt-in
     * `failOnSensitiveOutputs` input is set and cleanup was NOT requested via
     * `cleanupOutputFile`, the task fails instead (#488) -- the just-written
     * file is registered for end-of-step deletion first so the failure
     * doesn't leave the cleartext values behind. With `cleanupOutputFile` set
     * the file is deleted at step end anyway, so strict mode stays a warning.
     *
     * Returns whether the parsed output contained at least one `sensitive =
     * true` value (and this call did not already throw) -- the caller (the
     * `output()` command) uses this to decide whether to also auto-register
     * the file for normal-completion cleanup via `cleanupOutputFileIfSensitive`
     * (#650), independent of this function's own warn/throw behavior.
     */
    warnIfSensitiveOutputFile(jsonOutput: string, filePath: string): boolean {
        let outputs: unknown;
        try {
            outputs = JSON.parse(jsonOutput);
        } catch (error) {
            // #783: escalate from debug to warning so a failed sensitivity check is
            // visible by default, matching the sibling warnIfSensitiveOutputs /
            // detectDestroyChanges handlers -- an unparseable output means this
            // safety check silently did not run over a file that may hold secrets.
            tasks.warning(`Could not parse terraform output as JSON for sensitive-output detection; the sensitive-value safety warning did not run: ${error}`);
            return false;
        }
        if (!outputs || typeof outputs !== 'object') return false;

        const sensitiveKeys = Object.entries(outputs)
            .filter(([, def]) => (def as { sensitive?: boolean }).sensitive === true)
            .map(([key]) => key);
        if (sensitiveKeys.length === 0) return false;

        if (tasks.getBoolInput('failOnSensitiveOutputs', false) && !tasks.getBoolInput('cleanupOutputFile', false)) {
            this.tempFileManager.track(filePath);
            throw new Error(tasks.loc('OutputSensitiveOutputsStrictFailure', filePath, sensitiveKeys.length, sensitiveKeys.join(', ')));
        }
        // #650: state the actual outcome accurately -- with cleanupOutputFileIfSensitive
        // defaulting to true, this file is normally already slated for deletion, so telling
        // every caller to "set cleanupOutputFile" regardless would be stale/misleading now
        // that cleanup is opt-OUT rather than opt-in for the sensitive case.
        const willAutoCleanup = tasks.getBoolInput('cleanupOutputFile', false) || tasks.getBoolInput('cleanupOutputFileIfSensitive', false);
        tasks.warning(
            `${filePath} contains ${sensitiveKeys.length} sensitive output(s) in cleartext (${sensitiveKeys.join(', ')}). ` +
            `Ensure this file is not published as a pipeline artifact. ` +
            (willAutoCleanup
                ? `This file will be deleted automatically at the end of this step.`
                : `Set 'cleanupOutputFileIfSensitive' (or 'cleanupOutputFile') to remove it automatically at the end of this step if downstream steps don't need to read it from disk.`)
        );
        return true;
    }
}
