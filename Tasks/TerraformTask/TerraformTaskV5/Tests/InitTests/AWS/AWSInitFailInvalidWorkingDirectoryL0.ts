import { TerraformCommandHandlerAWS } from './../../../src/aws-terraform-command-handler';
import { runCommand } from '../../test-l0-helpers';

runCommand(new TerraformCommandHandlerAWS(), 'init', 'AWSInitFailInvalidWorkingDirectoryL0', false);
