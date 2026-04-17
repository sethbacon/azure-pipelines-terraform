import tl = require('azure-pipelines-task-lib');
import { EnvironmentVariableHelper } from '../../src/environment-variables';

// Simulate tracked env vars being set during command execution
EnvironmentVariableHelper.setEnvironmentVariable('AWS_ACCESS_KEY_ID', 'test-key');
EnvironmentVariableHelper.setEnvironmentVariable('AWS_SECRET_ACCESS_KEY', 'test-secret');

// Verify vars are set
if (!process.env['AWS_ACCESS_KEY_ID'] || !process.env['AWS_SECRET_ACCESS_KEY']) {
    tl.setResult(tl.TaskResult.Failed, 'Environment variables should be set before cleanup');
} else {
    // Simulate emergency cleanup path — EnvironmentVariableHelper.clearTrackedVariables()
    // is what the uncaughtException/unhandledRejection handlers ultimately call
    EnvironmentVariableHelper.clearTrackedVariables();

    // Verify vars are cleared
    if (process.env['AWS_ACCESS_KEY_ID'] !== undefined || process.env['AWS_SECRET_ACCESS_KEY'] !== undefined) {
        tl.setResult(tl.TaskResult.Failed, 'Emergency cleanup should have cleared tracked variables');
    } else {
        tl.setResult(tl.TaskResult.Succeeded, 'EmergencyCleanupL0 should have succeeded.');
    }
}
