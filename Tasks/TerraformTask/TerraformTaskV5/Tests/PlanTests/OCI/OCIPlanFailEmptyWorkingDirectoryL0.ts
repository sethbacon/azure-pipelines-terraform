import { TerraformCommandHandlerOCI } from './../../../src/oci-terraform-command-handler';
import { runCommand } from '../../test-l0-helpers';

runCommand(new TerraformCommandHandlerOCI(), 'plan', 'OCIPlanFailEmptyWorkingDirectoryL0', false);
