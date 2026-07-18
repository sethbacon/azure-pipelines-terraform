import tasks = require('azure-pipelines-task-lib/task');
import { ToolRunner, IExecOptions } from 'azure-pipelines-task-lib/toolrunner';
import fs = require('fs');
import path = require('path');
import { buildTerraformDocsArgs, buildModulePathArgs, sanitizeConfigFile, TerraformDocsConfig } from './args-builder';

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
        // is out of date — both should fail the task.
        const exitCode = await toolRunner.execAsync(<IExecOptions>{ ignoreReturnCode: true });
        if (exitCode !== 0) {
            throw new Error(tasks.loc('TerraformDocsFailed', exitCode));
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
