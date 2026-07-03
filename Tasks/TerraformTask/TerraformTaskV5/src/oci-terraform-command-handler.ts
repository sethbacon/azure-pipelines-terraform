import tasks = require('azure-pipelines-task-lib/task');
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import { TerraformAuthorizationCommandInitializer } from './terraform-commands';
import { BaseTerraformCommandHandler } from './base-terraform-command-handler';
import { EnvironmentVariableHelper } from './environment-variables';
import { generateIdToken } from './id-token-generator';
import { exchangeOidcForUpst } from './oci-token-exchange';
import { writeSecretFile } from './secure-temp';
import { normalizePem } from './pem-normalizer';
import { resolveWifTempDir } from './temp-dir';
import path = require('path');
import fs = require('fs');
import crypto = require('crypto');
import { randomUUID as uuidV4 } from 'crypto';

const VALID_AUTH_SCHEMES = ["ServiceConnection", "WorkloadIdentityFederation"] as const;

// Re-exported for backward compatibility: existing tests and any external
// consumers import `resolveWifTempDir` from this module. The implementation
// now lives in `./temp-dir` and is shared with the AWS/GCP handlers, whose
// ephemeral WIF token/credential files follow the same Agent.TempDirectory
// preference.
export { resolveWifTempDir } from './temp-dir';

const OCI_TENANCY_OCID_RE = /^ocid1\.tenancy\.[a-z0-9.-]+$/;
const OCI_REGION_RE = /^[a-z0-9-]+$/;

/**
 * Validates the tenancy OCID before it is interpolated into the synthetic OCI
 * INI config (consumed via OCI_CLI_CONFIG_FILE). Without this, an embedded
 * newline could inject or override config keys (e.g. a crafted tenancy value
 * introducing its own key_file= line). The character set matches the OCID
 * grammar OCI itself uses, so no legitimate tenancy OCID is rejected.
 */
export function validateOciTenancyOcid(value: string): string {
    if (!OCI_TENANCY_OCID_RE.test(value)) {
        throw new Error(`Invalid ociWifTenancyOcid '${value}': must match the tenancy OCID grammar (ocid1.tenancy.<realm>...<unique-id>), with no embedded newlines or special characters.`);
    }
    return value;
}

/** Same INI-injection concern as validateOciTenancyOcid, for the region field. */
export function validateOciRegion(value: string): string {
    if (!OCI_REGION_RE.test(value)) {
        throw new Error(`Invalid ociWifRegion '${value}': must contain only lowercase letters, digits, and hyphens.`);
    }
    return value;
}

export class TerraformCommandHandlerOCI extends BaseTerraformCommandHandler {
    constructor() {
        super();
        this.providerName = "oci";
    }

    private validateAuthScheme(scheme: string, inputName: string): void {
        if (!(VALID_AUTH_SCHEMES as readonly string[]).includes(scheme)) {
            throw new Error(`Unrecognized authorization scheme '${scheme}' for input '${inputName}'. Valid values: ${VALID_AUTH_SCHEMES.join(", ")}`);
        }
    }

    private getPrivateKeyFilePath(privateKey: string) {
        tasks.setSecret(privateKey);
        const normalized = normalizePem(privateKey);
        const privateKeyFilePath = path.join(resolveWifTempDir(), `keyfile-${uuidV4()}.pem`);
        writeSecretFile(privateKeyFilePath, normalized);
        this.tempFiles.push(privateKeyFilePath);
        return privateKeyFilePath;
    }

    private setupBackend(_backendServiceName: string) {
        // Unfortunately this seems not to work with OCI provider for the tf statefile
        // https://developer.hashicorp.com/terraform/language/settings/backends/configuration#command-line-key-value-pairs
        //this.backendConfig.set('address', tasks.getInput("PAR url", true));
        //this.backendConfig.set('path', tasks.getInput("PAR path", true));
        //this.backendConfig.set('scheme', 'https');
        //PAR = OCI Object Storage preauthenticated request (for the statefile bucket)

        // Instead, will create a backend.tf config file for it in-flight when generate option was selected 'yes' (the default setting)
        if (tasks.getInput("backendOCIConfigGenerate", true) === 'yes') {
            tasks.debug('Generating backend tf statefile config.');
            const parUrl = (tasks.getInput("backendOCIPar", true) || '');

            // Validate PAR URL: parse with URL constructor, enforce HTTPS, reject interpolation/template syntax
            let parsedUrl: URL;
            try {
                parsedUrl = new URL(parUrl);
            } catch {
                throw new Error(`OCI PAR URL is not a valid URL: ${parUrl}`);
            }
            if (parsedUrl.protocol !== 'https:') {
                throw new Error("OCI PAR URL must use HTTPS scheme.");
            }
            const forbiddenPatterns = ['${', '%{', '$((', '`'];
            for (const pattern of forbiddenPatterns) {
                if (parUrl.includes(pattern)) {
                    throw new Error(`OCI PAR URL contains forbidden template syntax: '${pattern}' is not allowed.`);
                }
            }

            const escapedParUrl = parUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            let config = "";
            config = config + "terraform {\n backend \"http\" {\n";
            config = config + " address = \"" + escapedParUrl + "\"\n";
            config = config + " update_method = \"PUT\"\n }\n }\n";

            const workingDirectory = tasks.getInput("workingDirectory") || '';
            const tfConfigFilePath = path.resolve(`${workingDirectory}/config-${uuidV4()}.tf`);
            tasks.writeFile(tfConfigFilePath, config, 'utf-8');
            if (fs.existsSync(tfConfigFilePath)) {
                try {
                    fs.chmodSync(tfConfigFilePath, 0o600);
                } catch (err) {
                    if (process.platform !== 'win32') {
                        throw new Error(`Failed to set restrictive permissions on OCI backend config file: ${err instanceof Error ? err.message : err}`);
                    }
                    tasks.debug('Skipping chmod on Windows platform (ACLs apply instead).');
                }
            }
            this.tempFiles.push(tfConfigFilePath);
            tasks.debug('Generating backend tf statefile config done.');
        }
    }

    public async handleBackend(terraformToolRunner: ToolRunner): Promise<void> {
        const backendServiceName = tasks.getInput("backendServiceOCI", true)!;
        this.setupBackend(backendServiceName);
        this.applyBackendConfig(terraformToolRunner);
    }

    /**
     * Cross-cloud path: called instead of `handleBackend` on state-accessing
     * commands (plan/apply/...) when this OCI backend is paired with a
     * *different* cloud's `provider` input. No-op: OCI's http/PAR backend
     * authentication is embedded in the pre-authenticated request URL, which
     * was already generated into a cached backend config file at init — there
     * is no separate cloud-credential identity to (re-)supply on later commands.
     */
    public async configureBackendCredentials(): Promise<void> {
        tasks.debug('OCI backend requires no cross-cloud credential injection (PAR URL is self-authenticating).');
    }

    public async handleProvider(command: TerraformAuthorizationCommandInitializer): Promise<void> {
        const authScheme = tasks.getInput("environmentAuthSchemeOCI", false) || "ServiceConnection";
        this.validateAuthScheme(authScheme, "environmentAuthSchemeOCI");

        if (authScheme === "WorkloadIdentityFederation") {
            await this.handleProviderWIF(command);
        } else {
            if (command.serviceProviderName) {
                const rawPrivateKey = tasks.getEndpointDataParameter(command.serviceProviderName, "privateKey", false);
                if (!rawPrivateKey) {
                    throw new Error("OCI private key not found in service connection. Ensure the 'privateKey' field is configured.");
                }
                const privateKeyFilePath = this.getPrivateKeyFilePath(rawPrivateKey);
                EnvironmentVariableHelper.setEnvironmentVariable("TF_VAR_tenancy_ocid", tasks.getEndpointDataParameter(command.serviceProviderName, "tenancy", false) || '');
                EnvironmentVariableHelper.setEnvironmentVariable("TF_VAR_user_ocid", tasks.getEndpointDataParameter(command.serviceProviderName, "user", false) || '');
                EnvironmentVariableHelper.setEnvironmentVariable("TF_VAR_region", tasks.getEndpointDataParameter(command.serviceProviderName, "region", false) || '');
                EnvironmentVariableHelper.setEnvironmentVariable("TF_VAR_fingerprint", tasks.getEndpointDataParameter(command.serviceProviderName, "fingerprint", false) || '');
                EnvironmentVariableHelper.setEnvironmentVariable("TF_VAR_private_key_path", privateKeyFilePath);
            }
        }
    }

    private async handleProviderWIF(command: TerraformAuthorizationCommandInitializer): Promise<void> {
        // 1. Get OIDC JWT from Azure DevOps
        const oidcToken = await generateIdToken(command.serviceProviderName);
        tasks.setSecret(oidcToken);

        // 2. Generate ephemeral RSA-2048 key pair
        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });
        // Private key is multi-line PEM — not registered as a secret (which
        // rejects newlines unless SYSTEM_UNSAFEALLOWMULTILINESECRET is set).
        // Security relies on writeSecretFile (0o600) and temp-file cleanup.

        // 3. Exchange OIDC JWT for OCI UPST
        const identityDomainUrl = tasks.getInput("ociWifIdentityDomainUrl", true)!;
        const clientId = tasks.getInput("ociWifClientId", true)!;
        const upst = await exchangeOidcForUpst(oidcToken, identityDomainUrl, clientId, publicKey);
        tasks.setSecret(upst);

        // 4. Compute fingerprint of ephemeral public key
        const keyObject = crypto.createPublicKey(publicKey);
        const der = keyObject.export({ type: 'spki', format: 'der' });
        const md5 = crypto.createHash('md5').update(der).digest('hex');
        const fingerprint = md5.match(/.{2}/g)!.join(':');

        // 5. Write ephemeral private key, UPST, and synthetic OCI config to temp files
        const tempDir = resolveWifTempDir();
        const sessionId = uuidV4();

        const privateKeyPath = path.join(tempDir, `oci-wif-key-${sessionId}.pem`);
        writeSecretFile(privateKeyPath, privateKey);
        this.tempFiles.push(privateKeyPath);

        const upstPath = path.join(tempDir, `oci-wif-upst-${sessionId}`);
        writeSecretFile(upstPath, upst);
        this.tempFiles.push(upstPath);

        const tenancyOcid = validateOciTenancyOcid(tasks.getInput("ociWifTenancyOcid", true)!);
        const region = validateOciRegion(tasks.getInput("ociWifRegion", true)!);

        const configContent = [
            '[DEFAULT]',
            `tenancy=${tenancyOcid}`,
            `region=${region}`,
            `key_file=${privateKeyPath}`,
            `fingerprint=${fingerprint}`,
            `security_token_file=${upstPath}`,
        ].join('\n') + '\n';

        const configPath = path.join(tempDir, `oci-wif-config-${sessionId}`);
        writeSecretFile(configPath, configContent);
        this.tempFiles.push(configPath);

        // 6. Set environment variables for the OCI Terraform provider
        EnvironmentVariableHelper.setEnvironmentVariable("OCI_CLI_CONFIG_FILE", configPath);
        EnvironmentVariableHelper.setEnvironmentVariable("OCI_CLI_PROFILE", "DEFAULT");
        EnvironmentVariableHelper.setEnvironmentVariable("OCI_CLI_AUTH", "security_token");

        // Also set TF_VAR_ env vars for users who reference these in their provider block
        EnvironmentVariableHelper.setEnvironmentVariable("TF_VAR_tenancy_ocid", tenancyOcid);
        EnvironmentVariableHelper.setEnvironmentVariable("TF_VAR_region", region);
    }
}
