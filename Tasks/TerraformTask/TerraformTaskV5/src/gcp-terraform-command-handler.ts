import tasks = require('azure-pipelines-task-lib/task');
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import { TerraformAuthorizationCommandInitializer } from './terraform-commands';
import { BaseTerraformCommandHandler } from './base-terraform-command-handler';
import { EnvironmentVariableHelper } from './environment-variables';
import { generateIdToken } from './id-token-generator';
import { writeSecretFile } from './secure-temp';
import path = require('path');
import os = require('os');
import { randomUUID as uuidV4 } from 'crypto';

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

        if (!clientEmail || !tokenUri || !privateKey) {
            const missing = ([!clientEmail && "Issuer", !tokenUri && "Audience", !privateKey && "PrivateKey"] as (string | false)[])
                .filter(Boolean).join(", ");
            throw new Error(`GCP service connection is missing required fields: ${missing}`);
        }
        tasks.setSecret(privateKey);

        // Create json string and write it to the file
        const jsonCredsString = JSON.stringify({
            type: "service_account",
            private_key: privateKey,
            client_email: clientEmail,
            token_uri: tokenUri
        });
        writeSecretFile(jsonKeyFilePath, jsonCredsString);
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

    /**
     * Writes the OIDC token file and a GCP external_account credentials file for
     * Workload Identity Federation, registering both for cleanup. Returns the path
     * to the credentials file. The file-name prefixes are passed in so the backend
     * and provider call sites keep their distinct, stable temp-file names.
     */
    private async writeWifCredentials(params: {
        serviceConnection: string;
        projectNumber: string;
        poolId: string;
        providerId: string;
        serviceAccountEmail: string;
        tokenFilePrefix: string;
        credentialsFilePrefix: string;
    }): Promise<string> {
        const oidcToken = await generateIdToken(params.serviceConnection);
        tasks.setSecret(oidcToken);

        const tokenFilePath = path.join(os.tmpdir(), `${params.tokenFilePrefix}-${uuidV4()}.jwt`);
        writeSecretFile(tokenFilePath, oidcToken);
        this.tempFiles.push(tokenFilePath);

        const audience = `//iam.googleapis.com/projects/${params.projectNumber}/locations/global/workloadIdentityPools/${params.poolId}/providers/${params.providerId}`;

        const credentials = {
            type: "external_account",
            audience: audience,
            subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
            token_url: "https://sts.googleapis.com/v1/token",
            credential_source: { file: tokenFilePath },
            service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${params.serviceAccountEmail}:generateAccessToken`
        };

        const credentialsFilePath = path.join(os.tmpdir(), `${params.credentialsFilePrefix}-${uuidV4()}.json`);
        writeSecretFile(credentialsFilePath, JSON.stringify(credentials));
        this.tempFiles.push(credentialsFilePath);

        return credentialsFilePath;
    }

    private async setupBackendWIF(backendServiceName: string): Promise<void> {
        this.backendConfig.set('bucket', tasks.getInput("backendGCPBucketName", true)!);
        const prefix = tasks.getInput("backendGCPPrefix", false);
        if (prefix) {
            this.backendConfig.set('prefix', prefix);
        }

        const credentialsFilePath = await this.writeWifCredentials({
            serviceConnection: backendServiceName,
            projectNumber: tasks.getInput("backendGCPProjectNumber", true)!,
            poolId: tasks.getInput("backendGCPWorkloadIdentityPoolId", true)!,
            providerId: tasks.getInput("backendGCPWorkloadIdentityProviderId", true)!,
            serviceAccountEmail: tasks.getInput("backendGCPServiceAccountEmail", true)!,
            tokenFilePrefix: "gcp-backend-oidc-token",
            credentialsFilePrefix: "gcp-backend-wif-credentials",
        });

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
        const projectNumber = tasks.getInput("gcpProjectNumber", true)!;

        const credentialsFilePath = await this.writeWifCredentials({
            serviceConnection: command.serviceProviderName,
            projectNumber,
            poolId: tasks.getInput("gcpWorkloadIdentityPoolId", true)!,
            providerId: tasks.getInput("gcpWorkloadIdentityProviderId", true)!,
            serviceAccountEmail: tasks.getInput("gcpServiceAccountEmail", true)!,
            tokenFilePrefix: "gcp-oidc-token",
            credentialsFilePrefix: "gcp-wif-credentials",
        });

        EnvironmentVariableHelper.setEnvironmentVariable("GOOGLE_CREDENTIALS", credentialsFilePath);
        EnvironmentVariableHelper.setEnvironmentVariable("GOOGLE_PROJECT", projectNumber);
    }
}
