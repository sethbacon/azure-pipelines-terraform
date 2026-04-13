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
        let toolPath;
        try {
            toolPath = this.tasks.which(binaryName, true);
        } catch {
            throw new Error(this.tasks.loc("TerraformToolNotFound"));
        }

        const toolRunner: ToolRunner = this.tasks.tool(toolPath);
        if (command) {
            toolRunner.arg(command.name);
            if (command.additionalArgs) {
                toolRunner.line(command.additionalArgs);
            }
        }

        return toolRunner;
    }
}
