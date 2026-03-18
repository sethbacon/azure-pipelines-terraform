import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

export interface MockTestConfig {
    provider: string;
    command: string;
    workingDirectory?: string;
    commandOptions?: string;
    // additional inputs as key-value
    inputs?: Record<string, string>;
    // environment variables to set
    envVars?: Record<string, string>;
    // exec mock answers - key is command string, value is {code, stdout, stderr?}
    execMocks?: Record<string, { code: number; stdout: string; stderr?: string }>;
    // the L0 handler file to point to (relative path from the mock runner file)
    l0File: string;
}

export function createMockRunner(config: MockTestConfig): tmrm.TaskMockRunner {
    let tr = new tmrm.TaskMockRunner(path.join(__dirname, config.l0File));

    tr.setInput('provider', config.provider);
    tr.setInput('command', config.command);
    tr.setInput('workingDirectory', config.workingDirectory || 'DummyWorkingDirectory');
    if (config.commandOptions !== undefined) {
        tr.setInput('commandOptions', config.commandOptions);
    }

    if (config.inputs) {
        for (const [key, value] of Object.entries(config.inputs)) {
            tr.setInput(key, value);
        }
    }

    if (config.envVars) {
        for (const [key, value] of Object.entries(config.envVars)) {
            process.env[key] = value;
        }
    }

    let answers: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
        "which": { "terraform": "terraform" },
        "checkPath": { "terraform": true },
        "exec": config.execMocks || {}
    };

    tr.setAnswers(answers);
    return tr;
}

/**
 * Standard Azure RM environment variables for mock tests.
 * Use by spreading into envVars: { ...AZURE_ENV_VARS }
 */
export const AZURE_ENV_VARS: Record<string, string> = {
    'ENDPOINT_AUTH_SCHEME_AzureRM': 'ServicePrincipal',
    'ENDPOINT_DATA_AzureRM_SUBSCRIPTIONID': 'DummmySubscriptionId',
    'ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALID': 'DummyServicePrincipalId',
    'ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALKEY': 'DummyServicePrincipalKey',
    'ENDPOINT_AUTH_PARAMETER_AzureRM_TENANTID': 'DummyTenantId'
};
