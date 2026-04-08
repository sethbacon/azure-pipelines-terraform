import { TerraformCommandHandlerAzureRM } from './../../../src/azure-terraform-command-handler';
import { runCommand } from '../../test-l0-helpers';

runCommand(new TerraformCommandHandlerAzureRM(), 'import', 'AzureImportSuccessL0');
