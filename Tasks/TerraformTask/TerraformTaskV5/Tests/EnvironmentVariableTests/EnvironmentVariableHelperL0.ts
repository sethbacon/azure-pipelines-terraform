import tl = require('azure-pipelines-task-lib');
import { EnvironmentVariableHelper } from '../../src/environment-variables';

function getEnv(name: string): string | undefined {
    return process.env[name];
}

// Test 1: setEnvironmentVariable sets the env var and tracks it
EnvironmentVariableHelper.setEnvironmentVariable('TEST_VAR_1', 'value1');
if (getEnv('TEST_VAR_1') !== 'value1') {
    tl.setResult(tl.TaskResult.Failed, 'TEST_VAR_1 should be "value1"');
} else {
    // Test 2: re-registration is idempotent (Set-based) — updating value works
    EnvironmentVariableHelper.setEnvironmentVariable('TEST_VAR_1', 'value1_updated');
    if (getEnv('TEST_VAR_1') !== 'value1_updated') {
        tl.setResult(tl.TaskResult.Failed, 'TEST_VAR_1 should be "value1_updated"');
    } else {
        // Test 3: set a second variable
        EnvironmentVariableHelper.setEnvironmentVariable('TEST_VAR_2', 'value2');
        if (getEnv('TEST_VAR_2') !== 'value2') {
            tl.setResult(tl.TaskResult.Failed, 'TEST_VAR_2 should be "value2"');
        } else {
            // Test 4: clearTrackedVariables removes all tracked vars
            EnvironmentVariableHelper.clearTrackedVariables();
            if (getEnv('TEST_VAR_1') !== undefined || getEnv('TEST_VAR_2') !== undefined) {
                tl.setResult(tl.TaskResult.Failed, 'Tracked variables should be cleared');
            } else {
                tl.setResult(tl.TaskResult.Succeeded, 'EnvironmentVariableHelperL0 should have succeeded.');
            }
        }
    }
}
