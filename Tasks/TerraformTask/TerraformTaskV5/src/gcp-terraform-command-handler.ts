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

export class TerraformCommandHandlerGCP extends BaseTerraformCommandHandler {
    constructor() {
        super();
        this.providerName = "gcp";
    }

    private validateAuthScheme(scheme: string, inputName: string): void {
        if (!(VALID_AUTH_SCHEMES as readonly string[]).includes(scheme)) {
            throw new Error(`Unrecognized authorization scheme '${scheme}' for input '${inputName}'. Valid values: ${VALID_AUTH_SCHEMES.join(", ")}`);
        }
    }

    private getJsonKeyFilePath(serviceName: string) {
        // Get credentials for json file
        const jsonKeyFilePath = path.join(os.tmpdir(), `credentials-${uuidV4()}.json`);

        const clientEmail = tasks.getEndpointAuthorizationParameter(serviceName, "Issuer", false);
        const tokenUri = tasks.getEndpointAuthorizationParameter(serviceName, "Audience", false);
        const privateKey = tasks.getEndpointAuthorizationParameter(serviceName, "PrivateKey", false);
        if (privateKey) { tasks.setSecret(privateKey); }

        // Create json string and write it to the file
        const jsonCredsString = JSON.stringify({
            type: "service_account",
            private_key: privateKey,
            client_email: clientEmail,
            token_uri: tokenUri
        });
        fs.writeFileSync(jsonKeyFilePath, jsonCredsString, { mode: 0o600 });
        this.tempFiles.push(jsonKeyFilePath);

        return jsonKeyFilePath;
    }

    private setupBackend(backendServiceName: string) {
        this.backendConfig.set('bucket', tasks.getInput("backendGCPBucketName", true)!);
        const prefix = tasks.getInput("backendGCPPrefix", false);
        if (prefix) {
            this.backendConfig.set('prefix', prefix);
        }

        const jsonKeyFilePath = this.getJsonKeyFilePath(backendServiceName);

        this.backendConfig.set('credentials', jsonKeyFilePath);
    }

    private async setupBackendWIF(backendServiceName: string): Promise<void> {
        this.backendConfig.set('bucket', tasks.getInput("backendGCPBucketName", true)!);
        const prefix = tasks.getInput("backendGCPPrefix", false);
        if (prefix) {
            this.backendConfig.set('prefix', prefix);
        }

        const oidcToken = await generateIdToken(backendServiceName);
        tasks.setSecret(oidcToken);

        const tokenFilePath = path.join(os.tmpdir(), `gcp-backend-oidc-token-${uuidV4()}.jwt`);
        fs.writeFileSync(tokenFilePath, oidcToken, { mode: 0o600 });
        this.tempFiles.push(tokenFilePath);

        const projectNumber = tasks.getInput("backendGCPProjectNumber", true)!;
        const poolId = tasks.getInput("backendGCPWorkloadIdentityPoolId", true)!;
        const providerId = tasks.getInput("backendGCPWorkloadIdentityProviderId", true)!;
        const serviceAccountEmail = tasks.getInput("backendGCPServiceAccountEmail", true)!;

        const audience = `//iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`;

        const credentials = {
            type: "external_account",
            audience: audience,
            subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
            token_url: "https://sts.googleapis.com/v1/token",
            credential_source: { file: tokenFilePath },
            service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccountEmail}:generateAccessToken`
        };

        const credentialsFilePath = path.join(os.tmpdir(), `gcp-backend-wif-credentials-${uuidV4()}.json`);
        fs.writeFileSync(credentialsFilePath, JSON.stringify(credentials), { mode: 0o600 });
        this.tempFiles.push(credentialsFilePath);

        this.backendConfig.set('credentials', credentialsFilePath);
    }

    public async handleBackend(terraformToolRunner: ToolRunner): Promise<void> {
        tasks.debug('Setting up backend GCP.');
        const backendServiceName = tasks.getInput("backendServiceGCP", true)!;
        const authScheme = tasks.getInput("backendAuthSchemeGCP", false) || "ServiceConnection";
        this.validateAuthScheme(authScheme, "backendAuthSchemeGCP");

        if (authScheme === "WorkloadIdentityFederation") {
            await this.setupBackendWIF(backendServiceName);
        } else {
            this.setupBackend(backendServiceName);
        }
        this.applyBackendConfig(terraformToolRunner);
        tasks.debug('Finished setting up backend GCP.');
    }

    public async handleProvider(command: TerraformAuthorizationCommandInitializer): Promise<void> {
        const authScheme = tasks.getInput("environmentAuthSchemeGCP", false) || "ServiceConnection";
        this.validateAuthScheme(authScheme, "environmentAuthSchemeGCP");

        if (authScheme === "WorkloadIdentityFederation") {
            await this.handleProviderWIF(command);
        } else {
            if (command.serviceProviderName) {
                const jsonKeyFilePath = this.getJsonKeyFilePath(command.serviceProviderName);

                EnvironmentVariableHelper.setEnvironmentVariable("GOOGLE_CREDENTIALS", jsonKeyFilePath);
                EnvironmentVariableHelper.setEnvironmentVariable("GOOGLE_PROJECT", tasks.getEndpointDataParameter(command.serviceProviderName, "project", false) || '');
            }
        }
    }

    private async handleProviderWIF(command: TerraformAuthorizationCommandInitializer): Promise<void> {
        const oidcToken = await generateIdToken(command.serviceProviderName);
        tasks.setSecret(oidcToken);

        const tokenFilePath = path.join(os.tmpdir(), `gcp-oidc-token-${uuidV4()}.jwt`);
        fs.writeFileSync(tokenFilePath, oidcToken, { mode: 0o600 });
        this.tempFiles.push(tokenFilePath);

        const projectNumber = tasks.getInput("gcpProjectNumber", true)!;
        const poolId = tasks.getInput("gcpWorkloadIdentityPoolId", true)!;
        const providerId = tasks.getInput("gcpWorkloadIdentityProviderId", true)!;
        const serviceAccountEmail = tasks.getInput("gcpServiceAccountEmail", true)!;

        const audience = `//iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`;

        const credentials = {
            type: "external_account",
            audience: audience,
            subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
            token_url: "https://sts.googleapis.com/v1/token",
            credential_source: { file: tokenFilePath },
            service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccountEmail}:generateAccessToken`
        };

        const credentialsFilePath = path.join(os.tmpdir(), `gcp-wif-credentials-${uuidV4()}.json`);
        fs.writeFileSync(credentialsFilePath, JSON.stringify(credentials), { mode: 0o600 });
        this.tempFiles.push(credentialsFilePath);

        EnvironmentVariableHelper.setEnvironmentVariable("GOOGLE_CREDENTIALS", credentialsFilePath);
        EnvironmentVariableHelper.setEnvironmentVariable("GOOGLE_PROJECT", projectNumber);
    }
}
