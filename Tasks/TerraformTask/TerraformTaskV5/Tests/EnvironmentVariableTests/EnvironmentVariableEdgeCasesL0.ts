import tl = require('azure-pipelines-task-lib');
import { EnvironmentVariableHelper } from '../../src/environment-variables';

// Test: setEnvironmentVariable with empty name should skip
EnvironmentVariableHelper.setEnvironmentVariable('', 'value');

// Test: setEnvironmentVariable with empty value should warn but not crash
EnvironmentVariableHelper.setEnvironmentVariable('EMPTY_VALUE_TEST', '');

// Neither should be tracked
EnvironmentVariableHelper.clearTrackedVariables();

tl.setResult(tl.TaskResult.Succeeded, 'EnvironmentVariableEdgeCasesL0 should have succeeded.');
