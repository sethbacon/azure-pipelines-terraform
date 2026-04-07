import { TerraformCommandHandlerAWS } from './../../../src/aws-terraform-command-handler';
import { runCommand } from '../../test-l0-helpers';

runCommand(new TerraformCommandHandlerAWS(), 'validate', 'AWSValidateFailInvalidWorkingDirectoryL0', false);
