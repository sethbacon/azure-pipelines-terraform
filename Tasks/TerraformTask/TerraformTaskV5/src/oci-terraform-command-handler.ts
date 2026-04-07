import tasks = require('azure-pipelines-task-lib/task');
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import { TerraformAuthorizationCommandInitializer } from './terraform-commands';
import { BaseTerraformCommandHandler } from './base-terraform-command-handler';
import { EnvironmentVariableHelper } from './environment-variables';
import path = require('path');
import { v4 as uuidV4 } from 'uuid';

export class TerraformCommandHandlerOCI extends BaseTerraformCommandHandler {
    constructor() {
        super();
        this.providerName = "oci";
    }

    private getPrivateKeyFilePath(privateKey: string) {
        tasks.setSecret(privateKey);
        // This is a bit of a hack but spaces need to be converted to line breaks to make it work
        privateKey = privateKey.replace('-----BEGIN PRIVATE KEY-----', '_begin_');
        privateKey = privateKey.replace('-----END PRIVATE KEY-----', '_end_');
        while (privateKey.indexOf(' ') > -1) {
            privateKey = privateKey.replace(' ', '\n');
        }
        privateKey = privateKey.replace('_begin_', '-----BEGIN PRIVATE KEY-----');
        privateKey = privateKey.replace('_end_', '-----END PRIVATE KEY-----');
        const privateKeyFilePath = path.resolve(`keyfile-${uuidV4()}.pem`);
        require('fs').writeFileSync(privateKeyFilePath, privateKey, { mode: 0o600 });
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

            // Validate PAR URL: must be HTTPS and must not contain HCL interpolation sequences
            if (!parUrl.startsWith('https://')) {
                throw new Error("OCI PAR URL must use HTTPS scheme.");
            }
            if (parUrl.includes('${') || parUrl.includes('%{')) {
                throw new Error("OCI PAR URL contains invalid characters ('${' or '%{' are not allowed).");
            }

            const escapedParUrl = parUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            let config = "";
            config = config + "terraform {\n backend \"http\" {\n";
            config = config + " address = \"" + escapedParUrl + "\"\n";
            config = config + " update_method = \"PUT\"\n }\n }\n";

            const workingDirectory = tasks.getInput("workingDirectory") || '';
            const tfConfigFilePath = path.resolve(`${workingDirectory}/config-${uuidV4()}.tf`);
            tasks.writeFile(tfConfigFilePath, config);
            this.tempFiles.push(tfConfigFilePath);
            tasks.debug('Generating backend tf statefile config done.');
        }
    }

    public async handleBackend(terraformToolRunner: ToolRunner): Promise<void> {
        const backendServiceName = tasks.getInput("backendServiceOCI", true)!;
        this.setupBackend(backendServiceName);
        this.applyBackendConfig(terraformToolRunner);
    }

    public async handleProvider(command: TerraformAuthorizationCommandInitializer): Promise<void> {
        if (command.serviceProvidername) {
            const privateKeyFilePath = this.getPrivateKeyFilePath(tasks.getEndpointDataParameter(command.serviceProvidername, "privateKey", false)!);
            EnvironmentVariableHelper.setEnvironmentVariable("TF_VAR_tenancy_ocid", tasks.getEndpointDataParameter(command.serviceProvidername, "tenancy", false) || '');
            EnvironmentVariableHelper.setEnvironmentVariable("TF_VAR_user_ocid", tasks.getEndpointDataParameter(command.serviceProvidername, "user", false) || '');
            EnvironmentVariableHelper.setEnvironmentVariable("TF_VAR_region", tasks.getEndpointDataParameter(command.serviceProvidername, "region", false) || '');
            EnvironmentVariableHelper.setEnvironmentVariable("TF_VAR_fingerprint", tasks.getEndpointDataParameter(command.serviceProvidername, "fingerprint", false) || '');
            EnvironmentVariableHelper.setEnvironmentVariable("TF_VAR_private_key_path", privateKeyFilePath);
        }
    }
}
