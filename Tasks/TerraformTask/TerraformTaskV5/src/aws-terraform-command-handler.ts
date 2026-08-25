import tasks = require('azure-pipelines-task-lib/task');
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import { TerraformAuthorizationCommandInitializer } from './terraform-commands';
import { BaseTerraformCommandHandler } from './base-terraform-command-handler';
import { EnvironmentVariableHelper } from '@4cloudguru/pipeline-task-ado';
import { generateIdToken } from './id-token-generator';
import { writeSecretFile } from './secure-temp';
import { resolveWifTempDir } from './temp-dir';
import {
    assertIdentityValue,
    neutralizeEnvironmentVariables,
    requireIdentityField,
    requireSecretField,
    resolveRoleSessionName,
} from './credential-guards';

/**
 * Environment variables the AWS SDK's default credential chain matches BEFORE
 * the web-identity token file (`resolveCredentials()` in
 * aws/session/credentials.go; same ordering in aws-sdk-go-v2's
 * `resolveCredentialChain`). Any of these left set by a self-hosted agent or a
 * pipeline variable wins outright over a freshly minted federated assertion, so
 * the WIF path clears them before injecting (#187).
 */
const AWS_STATIC_CREDENTIAL_ENV = [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'AWS_SHARED_CREDENTIALS_FILE',
] as const;

/** The mirror set: web-identity/role selectors the static-key path must clear. */
const AWS_FEDERATED_CREDENTIAL_ENV = [
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_ROLE_ARN',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'AWS_SHARED_CREDENTIALS_FILE',
] as const;
import path = require('path');
import { randomUUID as uuidV4 } from 'crypto';

export class TerraformCommandHandlerAWS extends BaseTerraformCommandHandler {
    constructor() {
        super();
        this.providerName = "aws";
    }

    /**
     * Sets the static AWS credential environment variables from a service
     * connection. Environment variables (rather than CLI args) avoid exposing
     * secrets in process listings. Shared by `setupBackend` (init) and
     * `configureBackendCredentials` (cross-cloud injection on later commands).
     */
    private setEnvOnlyAwsCredentials(backendServiceName: string): void {
        // Both fields were read with optional=true behind a `!`: an absent access
        // key or secret produced `undefined`, which setEnvironmentVariable skips
        // with a warning, so the s3 backend silently fell through to the agent's
        // instance-profile/ambient credentials -- the same fail-open shape as #97
        // and exactly what the provider path already refused to do.
        const accessKey = requireIdentityField(backendServiceName, "username");
        const secretKey = requireSecretField(backendServiceName, "password");
        EnvironmentVariableHelper.registerSecret(secretKey);

        neutralizeEnvironmentVariables(AWS_FEDERATED_CREDENTIAL_ENV, "AWS static backend");
        EnvironmentVariableHelper.setEnvironmentVariable("AWS_ACCESS_KEY_ID", accessKey);
        EnvironmentVariableHelper.setEnvironmentVariable("AWS_SECRET_ACCESS_KEY", secretKey, true);
    }

    private setupBackend(backendServiceName: string) {
        this.backendConfig.set('bucket', tasks.getInput("backendAWSBucketName", true)!);
        this.backendConfig.set('key', tasks.getInput("backendAWSKey", true)!);
        this.backendConfig.set('region', requireIdentityField(backendServiceName, "region"));

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
        EnvironmentVariableHelper.registerSecret(oidcToken);

        const tokenFilePath = path.join(resolveWifTempDir(), `${params.tokenFilePrefix}-${uuidV4()}.jwt`);
        writeSecretFile(tokenFilePath, oidcToken);
        this.trackTempFile(tokenFilePath);

        // Clear the static keys FIRST: the SDK matches them before the
        // web-identity token file, so an inherited pair would silently discard
        // the assertion just written above (#187).
        neutralizeEnvironmentVariables(AWS_STATIC_CREDENTIAL_ENV, "AWS Workload Identity Federation");
        EnvironmentVariableHelper.setEnvironmentVariable("AWS_ROLE_ARN", params.roleArn);
        EnvironmentVariableHelper.setEnvironmentVariable("AWS_WEB_IDENTITY_TOKEN_FILE", tokenFilePath);
        EnvironmentVariableHelper.setEnvironmentVariable("AWS_REGION", params.region);
        EnvironmentVariableHelper.setEnvironmentVariable("AWS_ROLE_SESSION_NAME", params.sessionName);
    }

    /**
     * The backend's Workload Identity Federation parameter block, shared by
     * `setupBackendWIF` (init) and `configureBackendCredentials` (cross-cloud).
     * These were two verbatim copies, and the #197 session-name fix landing in
     * only one of them would have been this batch's own defect class in
     * miniature: one branch guarded, its sibling not.
     */
    private async applyBackendWifEnvironment(backendServiceName: string): Promise<void> {
        await this.applyWifEnvironment({
            serviceConnection: backendServiceName,
            roleArn: assertIdentityValue(tasks.getInput("backendAWSRoleArn", true), "Input 'backendAWSRoleArn'"),
            region: assertIdentityValue(tasks.getInput("backendAWSRegion", true), "Input 'backendAWSRegion'"),
            sessionName: resolveRoleSessionName("backendAWSSessionName", "ado-tf-backend"),
            tokenFilePrefix: "aws-backend-oidc-token",
        });
    }

    private async setupBackendWIF(backendServiceName: string): Promise<void> {
        this.backendConfig.set('bucket', tasks.getInput("backendAWSBucketName", true)!);
        this.backendConfig.set('key', tasks.getInput("backendAWSKey", true)!);

        await this.applyBackendWifEnvironment(backendServiceName);
    }

    public async handleBackend(terraformToolRunner: ToolRunner): Promise<void> {
        const backendServiceName = tasks.getInput("backendServiceAWS", true)!;
        const authScheme = this.resolveAuthScheme("backendAuthSchemeAWS");

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
        const authScheme = this.resolveAuthScheme("backendAuthSchemeAWS");

        tasks.debug("Configuring cross-cloud s3 backend credentials (environment variables only).");
        if (authScheme === "WorkloadIdentityFederation") {
            await this.applyBackendWifEnvironment(backendServiceName);
        } else {
            this.setEnvOnlyAwsCredentials(backendServiceName);
        }
        tasks.debug("Finished configuring cross-cloud s3 backend credentials.");
    }

    public async handleProvider(command: TerraformAuthorizationCommandInitializer): Promise<void> {
        const authScheme = this.resolveAuthScheme("environmentAuthSchemeAWS");

        if (authScheme === "WorkloadIdentityFederation") {
            await this.handleProviderWIF(command);
        } else {
            if (command.serviceProviderName) {
                // `?? ''` made an absent field a silently skipped environment
                // variable, which the AWS SDK reads as "not set" and answers from
                // the instance profile instead. Both now fail closed.
                const accessKeyId = requireIdentityField(command.serviceProviderName, "username");
                const secretAccessKey = requireSecretField(command.serviceProviderName, "password");
                EnvironmentVariableHelper.registerSecret(secretAccessKey);
                neutralizeEnvironmentVariables(AWS_FEDERATED_CREDENTIAL_ENV, "AWS static");
                EnvironmentVariableHelper.setEnvironmentVariable("AWS_ACCESS_KEY_ID", accessKeyId);
                EnvironmentVariableHelper.setEnvironmentVariable("AWS_SECRET_ACCESS_KEY", secretAccessKey, true);
            } else {
                // Silently injecting nothing leaves terraform to authenticate from
                // whatever ambient credentials the agent carries -- the defect this
                // whole matrix exists to remove.
                throw new Error("An AWS service connection is required for this command. Set environmentServiceNameAWS.");
            }
        }
    }

    private async handleProviderWIF(command: TerraformAuthorizationCommandInitializer): Promise<void> {
        if (!command.serviceProviderName) {
            // Fail closed like the static path: an empty service connection would
            // otherwise POST to the ADO OIDC endpoint with an empty id and surface
            // a cryptic downstream error instead of a clear misconfiguration.
            throw new Error("An AWS service connection is required for Workload Identity Federation. Set environmentServiceNameAWS.");
        }
        await this.applyWifEnvironment({
            serviceConnection: command.serviceProviderName,
            roleArn: assertIdentityValue(tasks.getInput("awsRoleArn", true), "Input 'awsRoleArn'"),
            region: assertIdentityValue(tasks.getInput("awsRegion", true), "Input 'awsRegion'"),
            sessionName: resolveRoleSessionName("awsSessionName", "ado-tf"),
            tokenFilePrefix: "aws-oidc-token",
        });
    }
}
