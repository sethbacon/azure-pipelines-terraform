import tasks = require('azure-pipelines-task-lib/task');
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import { TerraformAuthorizationCommandInitializer } from './terraform-commands';
import { BaseTerraformCommandHandler } from './base-terraform-command-handler';
import { EnvironmentVariableHelper } from '@4cloudguru/pipeline-task-ado';
import { generateIdToken } from '@4cloudguru/pipeline-task-ado';
import { normalizePem } from '@4cloudguru/pipeline-task-core';
import { writeSecretFile } from '@4cloudguru/pipeline-task-ado';
import { resolveWifTempDir } from './temp-dir';
import {
    assertIdentityValue,
    neutralizeEnvironmentVariables,
    requireIdentityField,
    requireSecretField,
} from './credential-guards';

/**
 * Google credential sources that resolve AHEAD of, or instead of, the
 * credentials file this handler writes (an inherited GOOGLE_CREDENTIALS /
 * GOOGLE_APPLICATION_CREDENTIALS / gcloud ADC override on a self-hosted agent).
 * Cleared on both provider branches so the run cannot authenticate as an
 * identity the service connection never named (#187).
 */
const GOOGLE_COMPETING_CREDENTIAL_ENV = [
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_OAUTH_ACCESS_TOKEN',
    'GOOGLE_GHA_CREDS_PATH',
    'CLOUDSDK_AUTH_ACCESS_TOKEN',
    'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
] as const;
import path = require('path');
import { randomUUID as uuidV4 } from 'crypto';

/** The only two Google token endpoints this task ever actually POSTs an assertion to. */
const ALLOWED_GOOGLE_TOKEN_URI_HOSTS = ['oauth2.googleapis.com', 'sts.googleapis.com'];

/**
 * The static-key path writes the service connection's "Audience" field
 * straight into the credentials file as `token_uri` -- the URL the Google SDK
 * POSTs the service-account-signed JWT assertion to. Constrain it to exactly
 * the https Google token endpoints this task uses (oauth2.googleapis.com,
 * plus sts.googleapis.com -- the WIF path's hardcoded
 * https://sts.googleapis.com/v1/token) rather than the whole *.googleapis.com
 * namespace, so a hostile or mistyped value cannot direct the signed
 * assertion to an arbitrary origin (#494), nor to some other unrelated
 * Google API host that happens to share the domain suffix (#594 --
 * deliberate narrowing endorsed by the audit; all googleapis.com hosts are
 * Google-owned so the prior wildcard was low-risk, but offered no benefit
 * over naming the exact endpoints in use).
 */
function assertGoogleTokenUri(tokenUri: string): void {
    let parsed: URL;
    try {
        parsed = new URL(tokenUri);
    } catch {
        throw new Error(tasks.loc('GcpTokenUriNotAllowed', tokenUri));
    }
    const host = parsed.hostname.toLowerCase();
    const hostAllowed = ALLOWED_GOOGLE_TOKEN_URI_HOSTS.includes(host);
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

        const clientEmail = requireIdentityField(serviceName, "Issuer");
        const tokenUri = requireIdentityField(serviceName, "Audience");
        const privateKey = requireSecretField(serviceName, "PrivateKey");
        assertGoogleTokenUri(tokenUri);
        // Mask the raw value first: a service connection may deliver the key
        // flattened to a single line (which itself starts with "-----BEGIN"),
        // so no boundary-line filtering here.
        for (const line of privateKey.split('\n')) {
            const trimmed = line.trim();
            if (trimmed) EnvironmentVariableHelper.registerSecret(trimmed);
        }
        const normalized = normalizePem(privateKey);
        // ADO's log masker matches per line, not across embedded newlines, so
        // the normalized (always multi-line) form needs its own per-line
        // masking too -- registering the raw string alone would never match
        // this byte-different on-disk form if it were ever echoed to a log.
        for (const line of normalized.split('\n')) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('-----')) EnvironmentVariableHelper.registerSecret(trimmed);
        }

        // Create json string and write it to the file
        const jsonCredsString = JSON.stringify({
            type: "service_account",
            private_key: normalized,
            client_email: clientEmail,
            token_uri: tokenUri
        });
        writeSecretFile(jsonKeyFilePath, jsonCredsString);
        this.trackTempFile(jsonKeyFilePath);

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
        // @credential-exempt: GOOGLE_BACKEND_CREDENTIALS takes precedence over
        // GOOGLE_CREDENTIALS / GOOGLE_APPLICATION_CREDENTIALS / ADC in the gcs
        // backend's own resolution order, so an inherited value cannot out-rank
        // it. Clearing the lower-precedence names here would be actively WRONG in
        // a cross-cloud run: `handleProvider` sets GOOGLE_CREDENTIALS for the
        // PROVIDER, and the backend path can run after it in the same process.
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
        EnvironmentVariableHelper.registerSecret(oidcToken);

        const tokenFilePath = path.join(resolveWifTempDir(), `${params.tokenFilePrefix}-${uuidV4()}.jwt`);
        writeSecretFile(tokenFilePath, oidcToken);
        this.trackTempFile(tokenFilePath);

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
        this.trackTempFile(credentialsFilePath);

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
        const authScheme = this.resolveAuthScheme("backendAuthSchemeGCP");

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
        const authScheme = this.resolveAuthScheme("backendAuthSchemeGCP");

        if (authScheme === "WorkloadIdentityFederation") {
            this.applyBackendCredentialFile(await this.writeBackendWifCredentials(backendServiceName));
        } else {
            this.applyBackendCredentialFile(this.getJsonKeyFilePath(backendServiceName));
        }
        tasks.debug('Finished configuring cross-cloud gcs backend credentials.');
    }

    public async handleProvider(command: TerraformAuthorizationCommandInitializer): Promise<void> {
        const authScheme = this.resolveAuthScheme("environmentAuthSchemeGCP");

        if (authScheme === "WorkloadIdentityFederation") {
            await this.handleProviderWIF(command);
        } else {
            if (command.serviceProviderName) {
                const jsonKeyFilePath = this.getJsonKeyFilePath(command.serviceProviderName);
                // optional=false already throws for an absent project, so the
                // `|| ''` tail was unreachable (#194); the project id is also
                // charset-validated before it becomes GOOGLE_PROJECT (#199).
                const project = requireIdentityField(command.serviceProviderName, "project", { source: 'data' });

                neutralizeEnvironmentVariables(GOOGLE_COMPETING_CREDENTIAL_ENV, "GCP service account key");
                EnvironmentVariableHelper.setEnvironmentVariable("GOOGLE_CREDENTIALS", jsonKeyFilePath);
                EnvironmentVariableHelper.setEnvironmentVariable("GOOGLE_PROJECT", project);
            } else {
                // Silently injecting nothing leaves terraform to authenticate from
                // whatever ambient credentials the agent carries.
                throw new Error("A GCP service connection is required for this command. Set environmentServiceNameGCP.");
            }
        }
    }

    private async handleProviderWIF(command: TerraformAuthorizationCommandInitializer): Promise<void> {
        if (!command.serviceProviderName) {
            // Fail closed rather than requesting an OIDC token for an empty
            // service connection id.
            throw new Error("A GCP service connection is required for Workload Identity Federation. Set environmentServiceNameGCP.");
        }
        // Every one of these is interpolated into the audience / impersonation
        // URLs written to the credentials file, so each is charset-validated
        // rather than trusted as free text (#199).
        const projectNumber = assertIdentityValue(tasks.getInput("gcpProjectNumber", true), "Input 'gcpProjectNumber'");

        const credentialsFilePath = await this.writeWifCredentials({
            serviceConnection: command.serviceProviderName,
            projectNumber,
            poolId: assertIdentityValue(tasks.getInput("gcpWorkloadIdentityPoolId", true), "Input 'gcpWorkloadIdentityPoolId'"),
            providerId: assertIdentityValue(tasks.getInput("gcpWorkloadIdentityProviderId", true), "Input 'gcpWorkloadIdentityProviderId'"),
            serviceAccountEmail: assertIdentityValue(tasks.getInput("gcpServiceAccountEmail", true), "Input 'gcpServiceAccountEmail'"),
            tokenFilePrefix: "gcp-oidc-token",
            credentialsFilePrefix: "gcp-wif-credentials",
        });

        neutralizeEnvironmentVariables(GOOGLE_COMPETING_CREDENTIAL_ENV, "GCP Workload Identity Federation");
        EnvironmentVariableHelper.setEnvironmentVariable("GOOGLE_CREDENTIALS", credentialsFilePath);
        EnvironmentVariableHelper.setEnvironmentVariable("GOOGLE_PROJECT", projectNumber);
    }
}

