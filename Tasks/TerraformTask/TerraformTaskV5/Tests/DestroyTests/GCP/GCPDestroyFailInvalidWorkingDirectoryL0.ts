import { TerraformCommandHandlerGCP } from './../../../src/gcp-terraform-command-handler';
import { runCommand } from '../../test-l0-helpers';

runCommand(new TerraformCommandHandlerGCP(), 'destroy', 'GCPDestroyFailInvalidWorkingDirectoryL0', false);
