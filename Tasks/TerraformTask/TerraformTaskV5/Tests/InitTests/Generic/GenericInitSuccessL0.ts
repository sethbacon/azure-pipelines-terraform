import { TerraformCommandHandlerGeneric } from './../../../src/generic-terraform-command-handler';
import { runCommand } from '../../test-l0-helpers';

runCommand(new TerraformCommandHandlerGeneric(), 'init', 'GenericInitSuccessL0');
