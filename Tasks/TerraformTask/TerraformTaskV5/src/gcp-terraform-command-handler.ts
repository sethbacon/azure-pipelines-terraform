import tasks = require('azure-pipelines-task-lib/task');
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import { TerraformAuthorizationCommandInitializer } from './terraform-commands';
import { BaseTerraformCommandHandler } from './base-terraform-command-handler';
import { EnvironmentVariableHelper } from './environment-variables';
import { generateIdToken } from './id-token-generator';
import { normalizePem } from './pem-normalizer';
import { writeSecretFile } from './secure-temp';
import { resolveWifTempDir } from './temp-dir';
import path = require('path');
import { randomUUID as uuidV4 } from 'crypto';

/**
 * The static-key path writes the service connection's "Audience" field
 * straight into the credentials file as `token_uri` -- the URL the Google SDK
 * POSTs the service-account-signed JWT assertion to. Constrain it to https
 * Google token endpoints (mirroring the WIF path's hardcoded
 * https://sts.googleapis.com/v1/token) so a hostile or mistyped value cannot
 * direct the signed assertion to an arbitrary origin (#494).
 */
function assertGoogleTokenUri(tokenUri: string): void {
    let parsed: URL;
    try {
        parsed = new URL(tokenUri);
    } catch {
        throw new Error(tasks.loc('GcpTokenUriNotAllowed', tokenUri));
    }
    const host = parsed.hostname.toLowerCase();
    const hostAllowed = host === 'oauth2.googleapis.com'
        || (host.endsWith('.googleapis.com') && host.length > '.googleapis.com'.length);
    if (parsed.protocol !== 'https:' || !hostAllowed) {
        throw new Error(tasks.loc('GcpTokenUriNotAllowed', tokenUri));
    }
}

export class TerraformCommandHandlerGCP extends BaseTerraformCommandHandler {
    constructor() {
        super();
        this.providerName = "gcp";
    }

    private getJsonKeyFilePath(serviceName: string) {
        // Get credentials for json file
        const jsonKeyFilePath = path.join(resolveWifTempDir(), `credentials-${uuidV4()}.json`);

        const clientEmail = tasks.getEndpointAuthorizationParameter(serviceName, "Issuer", false);
        const tokenUri = tasks.getEndpointAuthorizationParameter(serviceName, "Audience", false);
        const privateKey = tasks.getEndpointAuthorizationParameter(serviceName, "PrivateKey", false);

        if (!clientEmail || !tokenUri || !privateKey) {
            const missing = ([!clientEmail && "Issuer", !tokenUri && "Audience", !privateKey && "PrivateKey"] as (string | false)[])
                .filter(Boolean).join(", ");
            throw new Error(`GCP service connection is missing required fields: ${missing}`);
        }
        assertGoogleTokenUri(tokenUri);
        // Mask the raw value first: a service connection may deliver the key
        // flattened to a single line (which itself starts with "-----BEGIN"),
        // so no boundary-line filtering here.
        for (const line of privateKey.split('\n')) {
            const trimmed = line.trim();
            if (trimmed) tasks.setSecret(trimmed);
        }
        const normalized = normalizePem(privateKey);
        // ADO's log masker matches per line, not across embedded newlines, so
        // the normalized (always multi-line) form needs its own per-line
        // masking too -- registering the raw string alone would never match
        // this byte-different on-disk form if it were ever echoed to a log.
        for (const line of normalized.split('\n')) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('-----')) tasks.setSecret(trimmed);
        }

        // Create json string and write it to the file
        const jsonCredsString = JSON.stringify({
            type: "service_account",
            private_key: normalized,
            client_email: clientEmail,
            token_uri: tokenUri
        });
        writeSecretFile(jsonKeyFilePath, jsonCredsString);
        this.tempFiles.push(jsonKeyFilePath);

        return jsonKeyFilePath;
    }

    /**
     * Points the gcs backend at a credentials file via the `GOOGLE_BACKEND_CREDENTIALS`
     * environment variable — NEVER via `-backend-config=credentials=<path>`. A
     * cached backend-config `credentials` path is written in plain text into
     * `.terraform/terraform.tfstate` *and* any saved plan file, and (per
     * HashiCorp's own precedence rules) OVERRIDES the environment variable —
     * so it also goes stale the moment this task's temp file is cleaned up,
     * breaking any later command (plan/apply) that reuses the cached backend
     * config, even within the same gcp+gcs pipeline. `bucket`/`prefix` are
     * non-secret location fields and stay as backend-config.
     * See https://developer.hashicorp.com/terraform/language/backend#credentials-and-sensitive-data
     */
    private applyBackendCredentialFile(credentialsFilePath: string): void {
        EnvironmentVariableHelper.setEnvironmentVariable("GOOGLE_BACKEND_CREDENTIALS", credentialsFilePath);
    }

    private setupBackend(backendServiceName: string) {
        this.backendConfig.set('bucket', tasks.getInput("backendGCPBucketName", true)!);
        const prefix = tasks.getInput("backendGCPPrefix", false);
        if (prefix) {
            this.backendConfig.set('prefix', prefix);
        }

        this.applyBackendCredentialFile(this.getJsonKeyFilePath(backendServiceName));
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

        const tokenFilePath = path.join(resolveWifTempDir(), `${params.tokenFilePrefix}-${uuidV4()}.jwt`);
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

        const credentialsFilePath = path.join(resolveWifTempDir(), `${params.credentialsFilePrefix}-${uuidV4()}.json`);
        writeSecretFile(credentialsFilePath, JSON.stringify(credentials));
        this.tempFiles.push(credentialsFilePath);

        return credentialsFilePath;
    }

    /** Shared by `setupBackendWIF` (init) and `configureBackendCredentials` (cross-cloud). */
    private async writeBackendWifCredentials(backendServiceName: string): Promise<string> {
        return this.writeWifCredentials({
            serviceConnection: backendServiceName,
            projectNumber: tasks.getInput("backendGCPProjectNumber", true)!,
            poolId: tasks.getInput("backendGCPWorkloadIdentityPoolId", true)!,
            providerId: tasks.getInput("backendGCPWorkloadIdentityProviderId", true)!,
            serviceAccountEmail: tasks.getInput("backendGCPServiceAccountEmail", true)!,
            tokenFilePrefix: "gcp-backend-oidc-token",
            credentialsFilePrefix: "gcp-backend-wif-credentials",
        });
    }

    private async setupBackendWIF(backendServiceName: string): Promise<void> {
        this.backendConfig.set('bucket', tasks.getInput("backendGCPBucketName", true)!);
        const prefix = tasks.getInput("backendGCPPrefix", false);
        if (prefix) {
            this.backendConfig.set('prefix', prefix);
        }

        this.applyBackendCredentialFile(await this.writeBackendWifCredentials(backendServiceName));
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

    /**
     * Cross-cloud path: called instead of `handleBackend` on state-accessing
     * commands (plan/apply/...) when this gcs backend is paired with a
     * *different* cloud's `provider` input. Writes a fresh credentials file
     * and points GOOGLE_BACKEND_CREDENTIALS at it; `bucket`/`prefix` were
     * already cached by `terraform init` and need not be resupplied.
     */
    public async configureBackendCredentials(): Promise<void> {
        tasks.debug('Configuring cross-cloud gcs backend credentials (environment variable only).');
        const backendServiceName = tasks.getInput("backendServiceGCP", true)!;
        const authScheme = tasks.getInput("backendAuthSchemeGCP", false) || "ServiceConnection";
        this.validateAuthScheme(authScheme, "backendAuthSchemeGCP");

        if (authScheme === "WorkloadIdentityFederation") {
            this.applyBackendCredentialFile(await this.writeBackendWifCredentials(backendServiceName));
        } else {
            this.applyBackendCredentialFile(this.getJsonKeyFilePath(backendServiceName));
        }
        tasks.debug('Finished configuring cross-cloud gcs backend credentials.');
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

