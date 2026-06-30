import fs = require('fs');
import path = require('path');
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner'
import { TerraformBaseCommandInitializer } from './terraform-commands'

const ALLOWED_BINARY_NAMES = ["terraform", "tofu", "terragrunt"];

export function getBinaryName(tasks: typeof import('azure-pipelines-task-lib/task')): string {
    const name = tasks.getInput("binaryName", false) || "terraform";
    if (!ALLOWED_BINARY_NAMES.includes(name)) {
        throw new Error(`Invalid binaryName '${name}'. Allowed values: ${ALLOWED_BINARY_NAMES.join(', ')}`);
    }
    return name;
}

/**
 * Resolves the binary to invoke, preferring the path PipelineTerraformInstaller
 * recorded in terraformLocation over a bare PATH lookup. terraformLocation is
 * job-scoped the same way PATH itself is (set via tasks.setVariable, not an
 * output variable), so this is same-job defense-in-depth — it helps when a PATH
 * lookup would otherwise fail (e.g. tools.prependPath not honored on some
 * agent/container configuration) while the installer's own variable is still
 * intact, not a cross-job handoff. The recorded path is only trusted when its
 * filename matches the requested binary, so installing tofu in one step can't
 * make a `terraform` command silently run the tofu binary.
 */
export function resolveToolPath(tasks: typeof import('azure-pipelines-task-lib/task'), binaryName: string): string {
    const installerLocation = tasks.getVariable('terraformLocation');
    if (installerLocation
        && fs.existsSync(installerLocation)
        && path.basename(installerLocation).toLowerCase().startsWith(binaryName.toLowerCase())) {
        return installerLocation;
    }
    try {
        return tasks.which(binaryName, true);
    } catch {
        throw new Error(tasks.loc("TerraformToolNotFound"));
    }
}

export interface ITerraformToolHandler {
    createToolRunner(command?: TerraformBaseCommandInitializer): ToolRunner;
}

export class TerraformToolHandler implements ITerraformToolHandler {
    private readonly tasks: typeof import('azure-pipelines-task-lib/task');

    constructor(tasks: typeof import('azure-pipelines-task-lib/task')) {
        this.tasks = tasks;
    }

    public createToolRunner(command?: TerraformBaseCommandInitializer): ToolRunner {
        const binaryName = getBinaryName(this.tasks);
        const toolPath = resolveToolPath(this.tasks, binaryName);

        const toolRunner: ToolRunner = this.tasks.tool(toolPath);
        if (command) {
            toolRunner.arg(command.name);
            if (command.additionalArgs) {
                // BY DESIGN: additionalArgs is split into argv with the task-lib's own
                // word-splitting (toolRunner.line), not handed to a shell. There is no
                // shell interpolation, glob expansion, or command chaining here — terraform
                // receives a literal argv. The string is author-controlled pipeline YAML
                // (commandOptions), the same trust level as the rest of the task inputs, so
                // passing extra terraform flags through verbatim is the intended behavior.
                toolRunner.line(command.additionalArgs);
            }
        }

        return toolRunner;
    }
}
