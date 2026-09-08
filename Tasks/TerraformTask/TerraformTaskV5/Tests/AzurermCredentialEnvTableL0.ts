import * as assert from 'assert';
import { ARM_CREDENTIAL_SELECTOR_ENV } from '../src/azure-terraform-command-handler';

/**
 * CLASS TEST for azure-pipelines-terraform#1107 finding 1: the azurerm
 * provider's credential-selecting environment variables, as the provider
 * documents them (provider block argument -> ARM_* environment variable), pinned
 * here as data. Every one of them must be in the wholesale clear the AzureRM
 * handler runs before it applies the service connection's identity, or an
 * inherited value selects an identity the operator never chose.
 *
 * The list is the provider's, not this task's: when azurerm gains a new
 * credential argument, add it HERE first and let the assertion below say
 * whether the handler clears it. The two *_FILE_PATH spellings were the ones
 * missing when this test was written.
 */
const AZURERM_CREDENTIAL_ENV: ReadonlyArray<[argument: string, env: string]> = [
    ['client_id', 'ARM_CLIENT_ID'],
    ['client_id_file_path', 'ARM_CLIENT_ID_FILE_PATH'],
    ['client_secret', 'ARM_CLIENT_SECRET'],
    ['client_secret_file_path', 'ARM_CLIENT_SECRET_FILE_PATH'],
    ['client_certificate', 'ARM_CLIENT_CERTIFICATE'],
    ['client_certificate_path', 'ARM_CLIENT_CERTIFICATE_PATH'],
    ['client_certificate_password', 'ARM_CLIENT_CERTIFICATE_PASSWORD'],
    ['oidc_token', 'ARM_OIDC_TOKEN'],
    ['oidc_token_file_path', 'ARM_OIDC_TOKEN_FILE_PATH'],
    ['oidc_request_token', 'ARM_OIDC_REQUEST_TOKEN'],
    ['oidc_request_url', 'ARM_OIDC_REQUEST_URL'],
    ['ado_pipeline_service_connection_id', 'ARM_ADO_PIPELINE_SERVICE_CONNECTION_ID'],
    ['oidc_azure_service_connection_id', 'ARM_OIDC_AZURE_SERVICE_CONNECTION_ID'],
    ['use_oidc', 'ARM_USE_OIDC'],
    ['use_msi', 'ARM_USE_MSI'],
    ['use_cli', 'ARM_USE_CLI'],
    ['use_aks_workload_identity', 'ARM_USE_AKS_WORKLOAD_IDENTITY'],
    ['tenant_id', 'ARM_TENANT_ID'],
];

/**
 * Provider arguments deliberately NOT in the clear, with the reason. Listed so
 * a reviewer sees the decision rather than an omission.
 */
const DELIBERATELY_NOT_CLEARED: ReadonlyArray<[env: string, why: string]> = [
    ['ARM_SUBSCRIPTION_ID', 'names a target, not an identity; handled separately by the handler'],
    ['ARM_AUXILIARY_TENANT_IDS', 'widens the token audience but cannot change WHO is authenticated'],
    ['ARM_MSI_ENDPOINT', 'the token source for the agent identity itself (Azure Arc agents set it on purpose); it cannot select a different principal than the machine has'],
    ['ARM_ENVIRONMENT', 'cloud selection, not identity'],
    ['ARM_METADATA_HOSTNAME', 'cloud selection, not identity'],
];

describe('azurerm credential-selecting environment (class test, #1107)', () => {
    for (const [argument, env] of AZURERM_CREDENTIAL_ENV) {
        it(`clears ${env} (provider argument ${argument})`, () => {
            assert.ok(
                (ARM_CREDENTIAL_SELECTOR_ENV as readonly string[]).includes(env),
                `${env} selects an azurerm identity but is not in ARM_CREDENTIAL_SELECTOR_ENV`,
            );
        });
    }

    it('lists every clear it performs in the pinned table or the documented exclusions', () => {
        const known = new Set([...AZURERM_CREDENTIAL_ENV.map(([, env]) => env), ...DELIBERATELY_NOT_CLEARED.map(([env]) => env)]);
        for (const env of ARM_CREDENTIAL_SELECTOR_ENV) {
            assert.ok(known.has(env), `${env} is cleared but not accounted for in this table -- add it with its provider argument`);
        }
    });
});
