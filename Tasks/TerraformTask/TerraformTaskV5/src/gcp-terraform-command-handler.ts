import tasks = require('azure-pipelines-task-lib/task');
import {ToolRunner} from 'azure-pipelines-task-lib/toolrunner';
import {TerraformAuthorizationCommandInitializer} from './terraform-commands';
import {BaseTerraformCommandHandler} from './base-terraform-command-handler';
import {EnvironmentVariableHelper} from './environment-variables';
import {generateIdToken} from './id-token-generator';
import path = require('path');
import * as uuidV4 from 'uuid/v4';

export class TerraformCommandHandlerGCP extends BaseTerraformCommandHandler {
    constructor() {
        super();
        this.providerName = "gcp";
    }

    private getJsonKeyFilePath(serviceName: string) {
        // Get credentials for json file
        const jsonKeyFilePath = path.resolve(`credentials-${uuidV4()}.json`);

        let clientEmail = tasks.getEndpointAuthorizationParameter(serviceName, "Issuer", false);
        let tokenUri = tasks.getEndpointAuthorizationParameter(serviceName, "Audience", false);
        let privateKey = tasks.getEndpointAuthorizationParameter(serviceName, "PrivateKey", false);

        // Create json string and write it to the file
        let jsonCredsString = `{"type": "service_account", "private_key": "${privateKey}", "client_email": "${clientEmail}", "token_uri": "${tokenUri}"}`
        tasks.writeFile(jsonKeyFilePath, jsonCredsString);

        return jsonKeyFilePath;
    }

    private setupBackend(backendServiceName: string) {
        this.backendConfig.set('bucket', tasks.getInput("backendGCPBucketName", true));
        this.backendConfig.set('prefix', tasks.getInput("backendGCPPrefix", false));

        let jsonKeyFilePath = this.getJsonKeyFilePath(backendServiceName);

        this.backendConfig.set('credentials', jsonKeyFilePath);
    }

    public async handleBackend(terraformToolRunner: ToolRunner) : Promise<void> {
        tasks.debug('Setting up backend GCP.');
        let backendServiceName = tasks.getInput("backendServiceGCP", true);
        this.setupBackend(backendServiceName);

        for (let [key, value] of this.backendConfig.entries()) {
            terraformToolRunner.arg(`-backend-config=${key}=${value}`);
        }
        tasks.debug('Finished setting up backend GCP.');
    }

    public async handleProvider(command: TerraformAuthorizationCommandInitializer) : Promise<void> {
        const authScheme = tasks.getInput("environmentAuthSchemeGCP", false) || "ServiceConnection";

        if (authScheme === "WorkloadIdentityFederation") {
            await this.handleProviderWIF(command);
        } else {
            if (command.serviceProvidername) {
                let jsonKeyFilePath = this.getJsonKeyFilePath(command.serviceProvidername);

                process.env['GOOGLE_CREDENTIALS']  = `${jsonKeyFilePath}`;
                process.env['GOOGLE_PROJECT']  = tasks.getEndpointDataParameter(command.serviceProvidername, "project", false);
            }
        }
    }

    private async handleProviderWIF(command: TerraformAuthorizationCommandInitializer) : Promise<void> {
        const oidcToken = await generateIdToken(command.serviceProvidername);
        tasks.setSecret(oidcToken);

        const tokenFilePath = path.resolve(`gcp-oidc-token-${uuidV4()}.jwt`);
        tasks.writeFile(tokenFilePath, oidcToken);

        const projectNumber = tasks.getInput("gcpProjectNumber", true);
        const poolId = tasks.getInput("gcpWorkloadIdentityPoolId", true);
        const providerId = tasks.getInput("gcpWorkloadIdentityProviderId", true);
        const serviceAccountEmail = tasks.getInput("gcpServiceAccountEmail", true);

        const audience = `//iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`;

        const credentials = {
            type: "external_account",
            audience: audience,
            subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
            token_url: "https://sts.googleapis.com/v1/token",
            credential_source: { file: tokenFilePath },
            service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccountEmail}:generateAccessToken`
        };

        const credentialsFilePath = path.resolve(`gcp-wif-credentials-${uuidV4()}.json`);
        tasks.writeFile(credentialsFilePath, JSON.stringify(credentials));

        EnvironmentVariableHelper.setEnvironmentVariable("GOOGLE_CREDENTIALS", credentialsFilePath);
        EnvironmentVariableHelper.setEnvironmentVariable("GOOGLE_PROJECT", projectNumber);
    }
}