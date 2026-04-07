import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner'
import { TerraformBaseCommandInitializer } from './terraform-commands'

export interface ITerraformToolHandler {
    createToolRunner(command?: TerraformBaseCommandInitializer): ToolRunner;
}

export class TerraformToolHandler implements ITerraformToolHandler {
    private readonly tasks: typeof import('azure-pipelines-task-lib/task');

    constructor(tasks: typeof import('azure-pipelines-task-lib/task')) {
        this.tasks = tasks;
    }

    public createToolRunner(command?: TerraformBaseCommandInitializer): ToolRunner {
        let terraformPath;
        try {
            terraformPath = this.tasks.which("terraform", true);
        } catch {
            throw new Error(this.tasks.loc("TerraformToolNotFound"));
        }

        const terraformToolRunner: ToolRunner = this.tasks.tool(terraformPath);
        if (command) {
            terraformToolRunner.arg(command.name);
            if (command.additionalArgs) {
                terraformToolRunner.line(command.additionalArgs);
            }
        }

        return terraformToolRunner;
    }
}
