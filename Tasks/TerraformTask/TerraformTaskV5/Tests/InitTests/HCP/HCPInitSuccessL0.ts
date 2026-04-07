import { TerraformCommandHandlerHCP } from './../../../src/hcp-terraform-command-handler';
import { runCommand } from '../../test-l0-helpers';

runCommand(new TerraformCommandHandlerHCP(), 'init', 'HCPInitSuccessL0');
