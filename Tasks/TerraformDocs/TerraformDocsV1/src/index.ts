import tasks = require('azure-pipelines-task-lib/task');
import { ToolRunner, IExecOptions } from 'azure-pipelines-task-lib/toolrunner';
import fs = require('fs');
import path = require('path');
import { buildTerraformDocsArgs, buildModulePathArgs, sanitizeConfigFile, TerraformDocsConfig } from './args-builder';
import { execWithTimeout, TOOL_EXEC_TIMEOUT_MS } from './exec-timeout';

// Upper bound on terraform-docs stdout+stderr buffered to classify an --output-check
// failure and fold crash detail into the error message (mirrors the #632 / CWE-400
// output caps). terraform-docs' diagnostics are tiny, so a modest cap is ample while
// still refusing to grow one JS string unboundedly on a misbehaving binary.
const MAX_CAPTURED_TOOL_BYTES = 64 * 1024; // 64 KiB

async function run() {
    tasks.setResourcePath(path.join(__dirname, '..', 'task.json'));

    try {
        const config: TerraformDocsConfig = {
            formatter: tasks.getInput('formatter', true)!,
            modulePath: tasks.getPathInput('modulePath', false, false) || '.',
            // Azure Pipelines resolves an unset optional `filePath` input to the agent
            // working directory, so `configFile` must be validated (not trusted) before
            // it is forwarded as `--config`; a resolved directory means "not provided".
            configFile: sanitizeConfigFile(tasks.getPathInput('configFile', false, false), (p) => fs.statSync(p)),
            outputFile: tasks.getInput('outputFile', false),
            outputMode: tasks.getInput('outputMode', false),
            outputCheck: tasks.getBoolInput('outputCheck', false),
            sortBy: tasks.getInput('sortBy', false),
            recursive: tasks.getBoolInput('recursive', false),
            recursivePath: tasks.getInput('recursivePath', false),
        };

        const toolPath = tasks.which('terraform-docs', true);
        const toolRunner: ToolRunner = tasks.tool(toolPath);

        for (const arg of buildTerraformDocsArgs(config)) {
            toolRunner.arg(arg);
        }

        // additionalArgs is interposed here -- before the `--` module-path
        // terminator below -- so any flags it carries are still parsed as
        // flags rather than being swallowed as extra positionals.
        const additionalArgs = tasks.getInput('additionalArgs', false);
        if (additionalArgs) {
            toolRunner.line(additionalArgs);
        }

        for (const arg of buildModulePathArgs(config.modulePath)) {
            toolRunner.arg(arg);
        }

        // ignoreReturnCode lets us surface a precise message. terraform-docs exits
        // non-zero on a genuine error and, with --output-check, when the target file
        // is out of date -- both should fail the task, but they are surfaced with
        // DIFFERENT messages (#726) so a build-summary-only view (e.g. a
        // notification, or the pipeline's Result column) can tell 'the docs are
        // stale, regenerate them' apart from 'terraform-docs crashed' without
        // needing the interleaved raw tool stdout/stderr above in the log.
        //
        // Both outcomes exit non-zero, so the exit code alone cannot tell them apart.
        // Capture stdout+stderr and treat it as 'outdated' ONLY when terraform-docs
        // actually emitted its out-of-date signal; any OTHER non-zero exit is a genuine
        // crash (bad config, unreadable module, a missing --output-file, ...) that must
        // surface AS a failure with the captured detail folded in -- both so an
        // --output-check crash is not mislabeled 'docs are outdated' (#767) and so a
        // plain (non-check) failure carries terraform-docs' own error text rather than
        // just an exit code. Capture is byte-bounded (mirroring the #632 / CWE-400
        // output caps) and the listeners are additive, so the raw tool output is still
        // echoed to the build log above.
        let captured = '';
        let capturedBytes = 0;
        const capture = (data: string | Buffer): void => {
            if (capturedBytes >= MAX_CAPTURED_TOOL_BYTES) return;
            const text = data.toString();
            capturedBytes += Buffer.byteLength(text);
            captured += text;
        };
        toolRunner.on('stdout', capture);
        toolRunner.on('stderr', capture);

        const exitCode = await execWithTimeout(
            toolRunner,
            <IExecOptions>{ ignoreReturnCode: true },
            tasks.loc('TerraformDocsTimedOut', TOOL_EXEC_TIMEOUT_MS),
        );
        if (exitCode !== 0) {
            if (config.outputCheck && /is out of date/i.test(captured)) {
                throw new Error(tasks.loc('TerraformDocsOutdated', config.outputFile || config.modulePath));
            }
            const detail = captured.trim();
            throw new Error(
                detail
                    ? tasks.loc('TerraformDocsFailedDetail', exitCode, detail)
                    : tasks.loc('TerraformDocsFailed', exitCode),
            );
        }

        if (config.outputFile) {
            const generated = path.join(config.modulePath, config.outputFile);
            tasks.setVariable('generatedFilePath', generated, false, true);
            console.log(tasks.loc('GeneratedFile', generated));
        }

        tasks.setResult(tasks.TaskResult.Succeeded, '');
    } catch (error) {
        tasks.setResult(tasks.TaskResult.Failed, error instanceof Error ? error.message : String(error));
    }
}

void run();
