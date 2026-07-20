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
import crypto = require('crypto');
import { randomUUID as uuidV4 } from 'crypto';

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

/**
 * Validates an OCI pre-authenticated request (PAR) URL and returns it escaped for
 * safe interpolation into the generated HCL `backend "http"` block's quoted `address`
 * string (config-<uuid>.tf). The PAR URL embeds a bearer token in its /p/<token>/
 * segment, so the caller MUST tasks.setSecret() it BEFORE calling this — the errors
 * thrown here deliberately never include the URL value. Enforces a parseable https://
 * URL, rejects control characters (CR/LF/TAB and the rest of C0, which new URL()
 * strips for parsing but would otherwise survive into the generated HCL string),
 * and rejects Terraform/shell template syntax (${ %{ $(( `) that could break out
 * of the interpolation; backslashes and double-quotes are backslash-escaped so the
 * value cannot terminate the surrounding HCL string.
 */
export function validateAndEscapeOciParUrl(parUrl: string): string {
    let parsedUrl: URL;
    try {
        parsedUrl = new URL(parUrl);
    } catch {
        // Do not interpolate the PAR URL into the error: it is a bearer credential.
        throw new Error('OCI PAR URL is not a valid URL.');
    }
    if (parsedUrl.protocol !== 'https:') {
        throw new Error("OCI PAR URL must use HTTPS scheme.");
    }
    // Reject control characters outright (#548): new URL() silently strips
    // embedded tabs/newlines for PARSING, but the raw value is what gets
    // interpolated, so an embedded CR/LF would reach the quoted HCL `address`
    // string. Mirrors the anchored newline rejection in
    // validateOciTenancyOcid/validateOciRegion.
    if (/[\u0000-\u001f\u007f]/.test(parUrl)) {
        throw new Error('OCI PAR URL contains a control character (e.g. newline or tab), which is not allowed.');
    }
    const forbiddenPatterns = ['${', '%{', '$((', '`'];
    for (const pattern of forbiddenPatterns) {
        if (parUrl.includes(pattern)) {
            throw new Error(`OCI PAR URL contains forbidden template syntax: '${pattern}' is not allowed.`);
        }
    }
    return parUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export class TerraformCommandHandlerOCI extends BaseTerraformCommandHandler {
    constructor() {
        super();
        this.providerName = "oci";
    }

    private getPrivateKeyFilePath(privateKey: string) {
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

            // The OCI pre-authenticated request (PAR) URL embeds a long secret token in
            // its /p/<token>/ path segment; possession of the whole URL grants read/write
            // to the Terraform state bucket, so it is a bearer credential. Register it as
            // a secret before any validation/interpolation (or error message) so it is
            // masked in build logs, matching how every other credential in this task is
            // handled.
            if (parUrl) {
                tasks.setSecret(parUrl);
            }

            // Validate the PAR URL (https-only, reject template-injection syntax) and
            // escape it for safe interpolation into the generated HCL address string.
            // parUrl was tasks.setSecret()'d above, so validation errors never leak it.
            const escapedParUrl = validateAndEscapeOciParUrl(parUrl);
            let config = "";
            config = config + "terraform {\n backend \"http\" {\n";
            config = config + " address = \"" + escapedParUrl + "\"\n";
            config = config + " update_method = \"PUT\"\n }\n }\n";

            const workingDirectory = tasks.getInput("workingDirectory") || '';
            // The config file must live INSIDE the working directory — terraform
            // init only loads *.tf files from there — so it cannot be relocated to
            // Agent.TempDirectory. Because the embedded PAR URL is a bearer
            // credential, the write goes through the shared writeSecretFile
            // primitive (exclusive O_EXCL create + 0600 on Unix, restrictive DACL
            // on Windows, fail closed) like every other secret file in this task,
            // instead of a plain symlink-following write plus a separate chmod
            // (#545); the uuid filename keeps the exclusive create collision-free.
            const tfConfigFilePath = path.resolve(`${workingDirectory}/config-${uuidV4()}.tf`);
            writeSecretFile(tfConfigFilePath, config);
            this.tempFiles.push(tfConfigFilePath);
            tasks.debug('Generating backend tf statefile config done.');
            this.registerOciBackendCacheForCleanup(workingDirectory);
        }
    }

    /**
     * Opt-in (default off), best-effort scrub of the OCI PAR bearer credential
     * that `terraform init` copies into `<workingDirectory>/.terraform/terraform.tfstate`
     * when this backend is generated (#675). Default off because most
     * pipelines run separate init/plan/apply steps against the *same* working
     * directory and each later step needs this cache to still be present --
     * the 'cleanupOCIBackendCache' input documents that it must only be
     * enabled on the last terraform command touching a given working
     * directory. Registering into `tempFiles` (rather than deleting inline)
     * reuses the existing scrub-then-unlink cleanup path (and its emergency/
     * SIGTERM coverage) uniformly with every other tracked credential file.
     */
    private registerOciBackendCacheForCleanup(workingDirectory: string): void {
        if (!tasks.getBoolInput("cleanupOCIBackendCache", false)) return;
        this.tempFiles.push(path.resolve(`${workingDirectory}/.terraform/terraform.tfstate`));
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
        // Non-init commands (plan/apply/destroy/...) never call setupBackend(),
        // so this is the only place they can register the same opt-in cache
        // scrub for a working directory that was already `init`-ed with an OCI
        // PAR backend in an earlier step (#675) -- e.g. when apply/destroy is
        // the LAST command touching this working directory. Gated only on
        // cleanupOCIBackendCache itself (not also on backendOCIConfigGenerate,
        // unlike setupBackend()'s own registration): that input's group is
        // only visible/defaulted for `command = init` in the classic UI
        // designer, so relying on it resolving to "yes" here for a non-init
        // command would be fragile. An operator who explicitly opts into
        // cleanupOCIBackendCache has already stated their intent; scrubbing
        // the cache is a safe, idempotent no-op (via fs.existsSync in
        // scrubAndUnlink) if no OCI PAR backend was ever actually generated
        // in this working directory.
        this.registerOciBackendCacheForCleanup(tasks.getInput("workingDirectory") || '');

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
        // Mask the ephemeral private key per-line before it is used: ADO's log
        // masker matches per line (not across embedded newlines), so register each
        // non-boundary PEM line as a secret. Defense-in-depth on top of the 0o600
        // temp file + cleanup, in case a future debug/error path ever echoes it.
        for (const keyLine of privateKey.split('\n')) {
            const trimmed = keyLine.trim();
            if (trimmed && !trimmed.startsWith('-----')) {
                tasks.setSecret(trimmed);
            }
        }

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
