import { ParentCommandHandler } from '../../src/parent-handler';
import tl = require('azure-pipelines-task-lib');

async function run(): Promise<void> {
    try {
        const handler = new ParentCommandHandler();
        await handler.execute('invalid', 'plan');
        tl.setResult(tl.TaskResult.Failed, 'Should have thrown for unknown provider but did not.');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('Unknown backend/provider type: invalid')) {
            tl.setResult(tl.TaskResult.Failed, 'UnknownProviderL0 should have failed.');
        } else {
            tl.setResult(tl.TaskResult.Failed, `Unexpected error: ${message}`);
        }
    }
}

void run();
