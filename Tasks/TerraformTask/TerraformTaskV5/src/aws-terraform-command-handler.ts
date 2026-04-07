import tasks = require('azure-pipelines-task-lib/task');
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import { TerraformAuthorizationCommandInitializer } from './terraform-commands';
import { BaseTerraformCommandHandler } from './base-terraform-command-handler';
import { EnvironmentVariableHelper } from './environment-variables';
import { generateIdToken } from './id-token-generator';
import path = require('path');
import * as uuidV4 from 'uuid/v4';

export class TerraformCommandHandlerAWS extends BaseTerraformCommandHandler {
    constructor() {
        super();
        this.providerName = "aws";
    }

    private setupBackend(backendServiceName: string) {
        this.backendConfig.set('bucket', tasks.getInput("backendAWSBucketName", true)!);
        this.backendConfig.set('key', tasks.getInput("backendAWSKey", true)!);
        this.backendConfig.set('region', tasks.getEndpointAuthorizationParameter(backendServiceName, "region", true)!);

        const accessKey = tasks.getEndpointAuthorizationParameter(backendServiceName, "username", true)!;
        const secretKey = tasks.getEndpointAuthorizationParameter(backendServiceName, "password", true)!;
        if (accessKey) { tasks.setSecret(accessKey); }
        if (secretKey) { tasks.setSecret(secretKey); }
        this.backendConfig.set('access_key', accessKey);
        this.backendConfig.set('secret_key', secretKey);
    }

    public async handleBackend(terraformToolRunner: ToolRunner): Promise<void> {
        let backendServiceName = tasks.getInput("backendServiceAWS", true)!;
        this.setupBackend(backendServiceName);

        for (let [key, value] of this.backendConfig.entries()) {
            terraformToolRunner.arg(`-backend-config=${key}=${value}`);
        }
    }

    public async handleProvider(command: TerraformAuthorizationCommandInitializer): Promise<void> {
        const authScheme = tasks.getInput("environmentAuthSchemeAWS", false) || "ServiceConnection";

        if (authScheme === "WorkloadIdentityFederation") {
            await this.handleProviderWIF(command);
        } else {
            if (command.serviceProvidername) {
                const accessKeyId = tasks.getEndpointAuthorizationParameter(command.serviceProvidername, "username", false);
                const secretAccessKey = tasks.getEndpointAuthorizationParameter(command.serviceProvidername, "password", false);
                if (secretAccessKey) { tasks.setSecret(secretAccessKey); }
                EnvironmentVariableHelper.setEnvironmentVariable("AWS_ACCESS_KEY_ID", accessKeyId!);
                EnvironmentVariableHelper.setEnvironmentVariable("AWS_SECRET_ACCESS_KEY", secretAccessKey!);
            }
        }
    }

    private async handleProviderWIF(command: TerraformAuthorizationCommandInitializer): Promise<void> {
        const oidcToken = await generateIdToken(command.serviceProvidername);
        tasks.setSecret(oidcToken);

        const tokenFilePath = path.resolve(`aws-oidc-token-${uuidV4()}.jwt`);
        tasks.writeFile(tokenFilePath, oidcToken);
        this.tempFiles.push(tokenFilePath);

        EnvironmentVariableHelper.setEnvironmentVariable("AWS_ROLE_ARN", tasks.getInput("awsRoleArn", true)!);
        EnvironmentVariableHelper.setEnvironmentVariable("AWS_WEB_IDENTITY_TOKEN_FILE", tokenFilePath);
        EnvironmentVariableHelper.setEnvironmentVariable("AWS_REGION", tasks.getInput("awsRegion", true)!);

        const sessionName = tasks.getInput("awsSessionName", false) || "AzureDevOps-Terraform";
        EnvironmentVariableHelper.setEnvironmentVariable("AWS_ROLE_SESSION_NAME", sessionName);
    }
}
