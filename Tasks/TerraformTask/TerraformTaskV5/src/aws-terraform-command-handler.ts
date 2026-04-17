import tasks = require('azure-pipelines-task-lib/task');
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import { TerraformAuthorizationCommandInitializer } from './terraform-commands';
import { BaseTerraformCommandHandler } from './base-terraform-command-handler';
import { EnvironmentVariableHelper } from './environment-variables';
import { generateIdToken } from './id-token-generator';
import path = require('path');
import os = require('os');
import fs = require('fs');
import { v4 as uuidV4 } from 'uuid';

const VALID_AUTH_SCHEMES = ["ServiceConnection", "WorkloadIdentityFederation"] as const;

export class TerraformCommandHandlerAWS extends BaseTerraformCommandHandler {
    constructor() {
        super();
        this.providerName = "aws";
    }

    private validateAuthScheme(scheme: string, inputName: string): void {
        if (!(VALID_AUTH_SCHEMES as readonly string[]).includes(scheme)) {
            throw new Error(`Unrecognized authorization scheme '${scheme}' for input '${inputName}'. Valid values: ${VALID_AUTH_SCHEMES.join(", ")}`);
        }
    }

    private setupBackend(backendServiceName: string) {
        this.backendConfig.set('bucket', tasks.getInput("backendAWSBucketName", true)!);
        this.backendConfig.set('key', tasks.getInput("backendAWSKey", true)!);
        this.backendConfig.set('region', tasks.getEndpointAuthorizationParameter(backendServiceName, "region", true)!);

        const accessKey = tasks.getEndpointAuthorizationParameter(backendServiceName, "username", true)!;
        const secretKey = tasks.getEndpointAuthorizationParameter(backendServiceName, "password", true)!;
        if (secretKey) { tasks.setSecret(secretKey); }

        // Use environment variables instead of CLI args to avoid exposing secrets in process listings
        EnvironmentVariableHelper.setEnvironmentVariable("AWS_ACCESS_KEY_ID", accessKey);
        EnvironmentVariableHelper.setEnvironmentVariable("AWS_SECRET_ACCESS_KEY", secretKey, true);
    }

    private async setupBackendWIF(backendServiceName: string): Promise<void> {
        this.backendConfig.set('bucket', tasks.getInput("backendAWSBucketName", true)!);
        this.backendConfig.set('key', tasks.getInput("backendAWSKey", true)!);

        const oidcToken = await generateIdToken(backendServiceName);
        tasks.setSecret(oidcToken);

        const tokenFilePath = path.join(os.tmpdir(), `aws-backend-oidc-token-${uuidV4()}.jwt`);
        fs.writeFileSync(tokenFilePath, oidcToken, { mode: 0o600 });
        this.tempFiles.push(tokenFilePath);

        EnvironmentVariableHelper.setEnvironmentVariable("AWS_ROLE_ARN", tasks.getInput("backendAWSRoleArn", true)!);
        EnvironmentVariableHelper.setEnvironmentVariable("AWS_WEB_IDENTITY_TOKEN_FILE", tokenFilePath);
        EnvironmentVariableHelper.setEnvironmentVariable("AWS_REGION", tasks.getInput("backendAWSRegion", true)!);

        const sessionName = tasks.getInput("backendAWSSessionName", false) || "AzureDevOps-Terraform-Backend";
        EnvironmentVariableHelper.setEnvironmentVariable("AWS_ROLE_SESSION_NAME", sessionName);
    }

    public async handleBackend(terraformToolRunner: ToolRunner): Promise<void> {
        const backendServiceName = tasks.getInput("backendServiceAWS", true)!;
        const authScheme = tasks.getInput("backendAuthSchemeAWS", false) || "ServiceConnection";
        this.validateAuthScheme(authScheme, "backendAuthSchemeAWS");

        if (authScheme === "WorkloadIdentityFederation") {
            await this.setupBackendWIF(backendServiceName);
        } else {
            this.setupBackend(backendServiceName);
        }
        this.applyBackendConfig(terraformToolRunner);
    }

    public async handleProvider(command: TerraformAuthorizationCommandInitializer): Promise<void> {
        const authScheme = tasks.getInput("environmentAuthSchemeAWS", false) || "ServiceConnection";
        this.validateAuthScheme(authScheme, "environmentAuthSchemeAWS");

        if (authScheme === "WorkloadIdentityFederation") {
            await this.handleProviderWIF(command);
        } else {
            if (command.serviceProviderName) {
                const accessKeyId = tasks.getEndpointAuthorizationParameter(command.serviceProviderName, "username", false);
                const secretAccessKey = tasks.getEndpointAuthorizationParameter(command.serviceProviderName, "password", false);
                if (secretAccessKey) { tasks.setSecret(secretAccessKey); }
                EnvironmentVariableHelper.setEnvironmentVariable("AWS_ACCESS_KEY_ID", accessKeyId!);
                EnvironmentVariableHelper.setEnvironmentVariable("AWS_SECRET_ACCESS_KEY", secretAccessKey!, true);
            }
        }
    }

    private async handleProviderWIF(command: TerraformAuthorizationCommandInitializer): Promise<void> {
        const oidcToken = await generateIdToken(command.serviceProviderName);
        tasks.setSecret(oidcToken);

        const tokenFilePath = path.join(os.tmpdir(), `aws-oidc-token-${uuidV4()}.jwt`);
        fs.writeFileSync(tokenFilePath, oidcToken, { mode: 0o600 });
        this.tempFiles.push(tokenFilePath);

        EnvironmentVariableHelper.setEnvironmentVariable("AWS_ROLE_ARN", tasks.getInput("awsRoleArn", true)!);
        EnvironmentVariableHelper.setEnvironmentVariable("AWS_WEB_IDENTITY_TOKEN_FILE", tokenFilePath);
        EnvironmentVariableHelper.setEnvironmentVariable("AWS_REGION", tasks.getInput("awsRegion", true)!);

        const sessionName = tasks.getInput("awsSessionName", false) || "AzureDevOps-Terraform";
        EnvironmentVariableHelper.setEnvironmentVariable("AWS_ROLE_SESSION_NAME", sessionName);
    }
}
