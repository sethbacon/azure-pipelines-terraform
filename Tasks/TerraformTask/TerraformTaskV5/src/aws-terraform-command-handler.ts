import tasks = require('azure-pipelines-task-lib/task');
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import { TerraformAuthorizationCommandInitializer } from './terraform-commands';
import { BaseTerraformCommandHandler } from './base-terraform-command-handler';
import { EnvironmentVariableHelper } from './environment-variables';
import { generateIdToken } from './id-token-generator';
import { writeSecretFile } from './secure-temp';
import { resolveWifTempDir } from './temp-dir';
import path = require('path');
import { randomUUID as uuidV4 } from 'crypto';

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

    /**
     * Sets the static AWS credential environment variables from a service
     * connection. Environment variables (rather than CLI args) avoid exposing
     * secrets in process listings. Shared by `setupBackend` (init) and
     * `configureBackendCredentials` (cross-cloud injection on later commands).
     */
    private setEnvOnlyAwsCredentials(backendServiceName: string): void {
        const accessKey = tasks.getEndpointAuthorizationParameter(backendServiceName, "username", true)!;
        const secretKey = tasks.getEndpointAuthorizationParameter(backendServiceName, "password", true)!;
        if (secretKey) { tasks.setSecret(secretKey); }

        EnvironmentVariableHelper.setEnvironmentVariable("AWS_ACCESS_KEY_ID", accessKey);
        EnvironmentVariableHelper.setEnvironmentVariable("AWS_SECRET_ACCESS_KEY", secretKey, true);
    }

    private setupBackend(backendServiceName: string) {
        this.backendConfig.set('bucket', tasks.getInput("backendAWSBucketName", true)!);
        this.backendConfig.set('key', tasks.getInput("backendAWSKey", true)!);
        this.backendConfig.set('region', tasks.getEndpointAuthorizationParameter(backendServiceName, "region", true)!);

        this.setEnvOnlyAwsCredentials(backendServiceName);
    }

    /**
     * Generates the OIDC token, writes it to a cleanup-tracked temp file, and sets
     * the AWS web-identity environment variables used by both the backend and the
     * provider. The token-file prefix is passed in so each call site keeps its own
     * stable temp-file name.
     */
    private async applyWifEnvironment(params: {
        serviceConnection: string;
        roleArn: string;
        region: string;
        sessionName: string;
        tokenFilePrefix: string;
    }): Promise<void> {
        const oidcToken = await generateIdToken(params.serviceConnection);
        tasks.setSecret(oidcToken);

        const tokenFilePath = path.join(resolveWifTempDir(), `${params.tokenFilePrefix}-${uuidV4()}.jwt`);
        writeSecretFile(tokenFilePath, oidcToken);
        this.tempFiles.push(tokenFilePath);

        EnvironmentVariableHelper.setEnvironmentVariable("AWS_ROLE_ARN", params.roleArn);
        EnvironmentVariableHelper.setEnvironmentVariable("AWS_WEB_IDENTITY_TOKEN_FILE", tokenFilePath);
        EnvironmentVariableHelper.setEnvironmentVariable("AWS_REGION", params.region);
        EnvironmentVariableHelper.setEnvironmentVariable("AWS_ROLE_SESSION_NAME", params.sessionName);
    }

    private async setupBackendWIF(backendServiceName: string): Promise<void> {
        this.backendConfig.set('bucket', tasks.getInput("backendAWSBucketName", true)!);
        this.backendConfig.set('key', tasks.getInput("backendAWSKey", true)!);

        await this.applyWifEnvironment({
            serviceConnection: backendServiceName,
            roleArn: tasks.getInput("backendAWSRoleArn", true)!,
            region: tasks.getInput("backendAWSRegion", true)!,
            sessionName: tasks.getInput("backendAWSSessionName", false) || "AzureDevOps-Terraform-Backend",
            tokenFilePrefix: "aws-backend-oidc-token",
        });
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

    /**
     * Cross-cloud path: called instead of `handleBackend` on state-accessing
     * commands (plan/apply/...) when this s3 backend is paired with a
     * *different* cloud's `provider` input. Sets the same AWS_* credential
     * environment variables as init; the non-secret bucket/key/region fields
     * were already cached by `terraform init` and need not be resupplied.
     */
    public async configureBackendCredentials(): Promise<void> {
        const backendServiceName = tasks.getInput("backendServiceAWS", true)!;
        const authScheme = tasks.getInput("backendAuthSchemeAWS", false) || "ServiceConnection";
        this.validateAuthScheme(authScheme, "backendAuthSchemeAWS");

        tasks.debug("Configuring cross-cloud s3 backend credentials (environment variables only).");
        if (authScheme === "WorkloadIdentityFederation") {
            await this.applyWifEnvironment({
                serviceConnection: backendServiceName,
                roleArn: tasks.getInput("backendAWSRoleArn", true)!,
                region: tasks.getInput("backendAWSRegion", true)!,
                sessionName: tasks.getInput("backendAWSSessionName", false) || "AzureDevOps-Terraform-Backend",
                tokenFilePrefix: "aws-backend-oidc-token",
            });
        } else {
            this.setEnvOnlyAwsCredentials(backendServiceName);
        }
        tasks.debug("Finished configuring cross-cloud s3 backend credentials.");
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
                EnvironmentVariableHelper.setEnvironmentVariable("AWS_ACCESS_KEY_ID", accessKeyId ?? '');
                EnvironmentVariableHelper.setEnvironmentVariable("AWS_SECRET_ACCESS_KEY", secretAccessKey ?? '', true);
            }
        }
    }

    private async handleProviderWIF(command: TerraformAuthorizationCommandInitializer): Promise<void> {
        await this.applyWifEnvironment({
            serviceConnection: command.serviceProviderName,
            roleArn: tasks.getInput("awsRoleArn", true)!,
            region: tasks.getInput("awsRegion", true)!,
            sessionName: tasks.getInput("awsSessionName", false) || "AzureDevOps-Terraform",
            tokenFilePrefix: "aws-oidc-token",
        });
    }
}
