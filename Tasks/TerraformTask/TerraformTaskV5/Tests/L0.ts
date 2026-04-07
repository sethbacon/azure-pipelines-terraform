import * as assert from 'assert';
import * as ttm from 'azure-pipelines-task-lib/mock-test';
import * as path from 'path';

describe('Terraform Test Suite', function () {

    before(() => {
        //NOTE: This is here because when debugging in VSCode this is populated and the spawn() method in the testing framework which starts a new NodeJS process does not handle the path with spaces that is set in it.
        delete process.env.NODE_OPTIONS
    });

    after(() => { });

    /* terraform init tests */

    function runValidations(validator: () => void, tr: ttm.MockTestRunner) {
        try {
            validator();
        }
        catch (error) {
            console.log("STDERR", tr.stderr);
            console.log("STDOUT", tr.stdout);
            throw error;
        }
    }

    it('azure init should succeed with no additional args', async () => {
        let tp = path.join(__dirname, './InitTests/Azure/AzureInitSuccessNoAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 1, 'should have 1 warning');
            assert(tr.stdOutContained('AzureInitSuccessNoAdditionalArgsL0 should have succeeded.'), 'Should have printed: AzureInitSuccessNoAdditionalArgsL0 should have succeeded.');
        }, tr)
    });

    it('azure init should succeed with no additional args and default settings', async () => {
        let tp = path.join(__dirname, './InitTests/Azure/AzureInitSuccessNoAdditionalArgsAndDefaultSettings.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 1, 'should have 1 warning');
            assert(tr.stdOutContained('AzureInitSuccessNoAdditionalArgsAndDefaultSettingsL0 should have succeeded.'), 'Should have printed: AzureInitSuccessNoAdditionalArgsL0 should have succeeded.');
        }, tr)
    });

    it('azure init should succeed with lower case authentication scheme', async () => {
        let tp = path.join(__dirname, './InitTests/Azure/AzureInitSuccessLowerCaseAuthenticationScheme.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 1, 'should have 1 warning');
            assert(tr.stdOutContained('AzureInitSuccessLowerCaseAuthenticationSchemeL0 should have succeeded.'), 'Should have printed: AzureInitSuccessLowerCaseAuthenticationSchemeL0 should have succeeded.');
        }, tr)

    });

    it('azure init should succeed with missing authentication scheme', async () => {
        let tp = path.join(__dirname, './InitTests/Azure/AzureInitSuccessMissingAuthenticationScheme.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 1, 'should have 1 warning');
            assert(tr.stdOutContained('AzureInitSuccessMissingAuthenticationSchemeL0 should have succeeded.'), 'Should have printed: AzureInitSuccessMissingAuthenticationSchemeL0 should have succeeded.');
        }, tr);
    });


    it('azure init should succeed with malformed authentication scheme', async () => {
        let tp = path.join(__dirname, './InitTests/Azure/AzureInitSuccessMalformedAuthenticationScheme.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 1, 'should have 1 warning');
            assert(tr.stdOutContained('AzureInitSuccessMalformedAuthenticationSchemeL0 should have succeeded.'), 'Should have printed: AzureInitSuccessMalformedAuthenticationSchemeL0 should have succeeded.');
        }, tr);
    });

    it('azure init should succeed with authentication scheme ManagedServiceIdentity', async () => {
        let tp = path.join(__dirname, './InitTests/Azure/AzureInitSuccessAuthenticationSchemeManagedServiceIdentity.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('AzureInitSuccessAuthenticationSchemeManagedServiceIdentityL0 should have succeeded.'), 'Should have printed: AzureInitSuccessAuthenticationSchemeManagedServiceIdentityL0 should have succeeded.');
        }, tr);
    });

    it('azure init should succeed with authentication scheme ManagedServiceIdentity and DefaultSettings', async () => {
        let tp = path.join(__dirname, './InitTests/Azure/AzureInitSuccessAuthenticationSchemeManagedServiceIdentityAndDefaultSettings.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('AzureInitSuccessAuthenticationSchemeManagedServiceIdentityAndDefaultSettingsL0 should have succeeded.'), 'Should have printed: AzureInitSuccessAuthenticationSchemeManagedServiceIdentityAndDefaultSettingsL0 should have succeeded.');
        }, tr);
    });

    it('azure init should succeed with authentication scheme WorkloadIdentityFederation', async () => {
        let tp = path.join(__dirname, './InitTests/Azure/AzureInitSuccessAuthenticationSchemeWorkloadIdentityFederation.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('AzureInitSuccessAuthenticationSchemeWorkloadIdentityFederationL0 should have succeeded.'), 'Should have printed: AzureInitSuccessAuthenticationSchemeWorkloadIdentityFederationL0 should have succeeded.');
        }, tr);
    });

    it('azure init should succeed with authentication scheme WorkloadIdentityFederation and default settings', async () => {
        let tp = path.join(__dirname, './InitTests/Azure/AzureInitSuccessAuthenticationSchemeWorkloadIdentityFederationAndDefaultSettings.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('AzureInitSuccessAuthenticationSchemeWorkloadIdentityFederationAndDefaultSettingsL0 should have succeeded.'), 'Should have printed: AzureInitSuccessAuthenticationSchemeWorkloadIdentityFederationAndDefaultSettingsL0 should have succeeded.');
        }, tr);
    });

    it('azure init should succeed with authentication scheme WorkloadIdentityFederation and id token fallback', async () => {
        let tp = path.join(__dirname, './InitTests/Azure/AzureInitSuccessAuthenticationSchemeWorkloadIdentityFederationAndIDTokenFallback.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('AzureInitSuccessAuthenticationSchemeWorkloadIdentityFederationAndIDTokenFallbackL0 should have succeeded.'), 'Should have printed: AzureInitSuccessAuthenticationSchemeWorkloadIdentityFederationAndIDTokenFallbackL0 should have succeeded.');
        }, tr);
    });

    it('azure init should succeed with authentication scheme WorkloadIdentityFederation and cli flags', async () => {
        let tp = path.join(__dirname, './InitTests/Azure/AzureInitSuccessAuthenticationSchemeWorkloadIdentityFederationAndCLIFlags.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('AzureInitSuccessAuthenticationSchemeWorkloadIdentityFederationAndCLIFlagsL0 should have succeeded.'), 'Should have printed: AzureInitSuccessAuthenticationSchemeWorkloadIdentityFederationAndCLIFlagsL0 should have succeeded.');
        }, tr);
    });

    it('azure init should succeed with additional args', async () => {
        let tp = path.join(__dirname, './InitTests/Azure/AzureInitSuccessAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 1, 'should have 1 warning');
            assert(tr.stdOutContained('AzureInitSuccessAdditionalArgsL0 should have succeeded.'), 'Should have printed: AzureInitSuccessAdditionalArgsL0 should have succeeded.');
        }, tr);
    });

    it('azure init should succeed with empty working directory', async () => {
        let tp = path.join(__dirname, './InitTests/Azure/AzureInitSuccessEmptyWorkingDir.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 1, 'should have 1 warning');
            assert(tr.stdOutContained('AzureInitSuccessEmptyWorkingDirL0 should have succeeded.'), 'Should have printed: AzureInitSuccessEmptyWorkingDirL0 should have succeeded.');
        }, tr);
    });

    it('azure init should fail with invalid working directory', async () => {
        let tp = path.join(__dirname, './InitTests/Azure/AzureInitFailInvalidWorkingDirectory.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 1, 'should have one error');
            assert(tr.warningIssues.length === 1, 'should have 1 warning');
            assert(tr.stdOutContained('There are some problems with the configuration, described below.\n\nThe Terraform configuration must be valid before initialization so that Terraform can determine which modules and providers need to be installed.'), 'Should have shown error message');
        }, tr);
    });

    it('aws init should succeed with no additional args', async () => {
        let tp = path.join(__dirname, './InitTests/AWS/AWSInitSuccessNoAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('AWSInitSuccessNoAdditionalArgsL0 should have succeeded.'), 'Should have printed: AWSInitSuccessNoAdditionalArgsL0 should have succeeded.');
        }, tr);
    });

    it('aws init should succeed with additional args', async () => {
        let tp = path.join(__dirname, './InitTests/AWS/AWSInitSuccessAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('AWSInitSuccessAdditionalArgsL0 should have succeeded.'), 'Should have printed: AWSInitSuccessAdditionalArgsL0 should have succeeded.');
        }, tr);
    });

    it('aws init should succeed with empty working directory', async () => {
        let tp = path.join(__dirname, './InitTests/AWS/AWSInitSuccessEmptyWorkingDir.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('AWSInitSuccessEmptyWorkingDirL0 should have succeeded.'), 'Should have printed: AWSInitSuccessEmptyWorkingDirL0 should have succeeded.');
        }, tr);
    });

    it('aws init should fail with invalid working directory', async () => {
        let tp = path.join(__dirname, './InitTests/AWS/AWSInitFailInvalidWorkingDirectory.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 1, 'should have one error');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('There are some problems with the configuration, described below.\n\nThe Terraform configuration must be valid before initialization so that Terraform can determine which modules and providers need to be installed.'), 'Should have shown error message');
        }, tr);
    });

    it('gcp init should succeed with no additional args', async () => {
        let tp = path.join(__dirname, './InitTests/GCP/GCPInitSuccessNoAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('GCPInitSuccessNoAdditionalArgsL0 should have succeeded.'), 'Should have printed: GCPInitSuccessNoAdditionalArgsL0 should have succeeded.');
        }, tr);
    });

    it('gcp init should succeed with additional args', async () => {
        let tp = path.join(__dirname, './InitTests/GCP/GCPInitSuccessAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('GCPInitSuccessAdditionalArgsL0 should have succeeded.'), 'Should have printed: GCPInitSuccessAdditionalArgsL0 should have succeeded.');
        }, tr);
    });

    it('gcp init should succeed with empty working directory', async () => {
        let tp = path.join(__dirname, './InitTests/GCP/GCPInitSuccessEmptyWorkingDir.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('GCPInitSuccessEmptyWorkingDirL0 should have succeeded.'), 'Should have printed: GCPInitSuccessEmptyWorkingDirL0 should have succeeded.');
        }, tr);
    });

    it('gcp init should fail with invalid working directory', async () => {
        let tp = path.join(__dirname, './InitTests/GCP/GCPInitFailInvalidWorkingDirectory.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 1, 'should have one error');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('There are some problems with the configuration, described below.\n\nThe Terraform configuration must be valid before initialization so that Terraform can determine which modules and providers need to be installed.'), 'Should have shown error message');
        }, tr);
    });

    /* terraform validate tests */

    it('azure validate should succeed with no additional args', async () => {
        let tp = path.join(__dirname, './ValidateTests/Azure/AzureValidateSuccessNoAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('AzureValidateSuccessNoAdditionalArgsL0 should have succeeded.'), 'Should have printed: AzureValidateSuccessNoAdditionalArgsL0 should have succeeded.');
        }, tr);
    });

    it('azure validate should succeed with additional args', async () => {
        let tp = path.join(__dirname, './ValidateTests/Azure/AzureValidateSuccessAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('AzureValidateSuccessAdditionalArgsL0 should have succeeded.'), 'Should have printed: AzureValidateSuccessAdditionalArgsL0 should have succeeded.');
        }, tr);
    });

    it('azure validate should succeed with empty working directory', async () => {
        let tp = path.join(__dirname, './ValidateTests/Azure/AzureValidateSuccessEmptyWorkingDir.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('AzureValidateSuccessEmptyWorkingDirL0 should have succeeded.'), 'Should have printed: AzureValidateSuccessEmptyWorkingDirL0 should have succeeded.');
        }, tr);
    });

    it('azure validate should fail with invalid working directory', async () => {
        let tp = path.join(__dirname, './ValidateTests/Azure/AzureValidateFailInvalidWorkingDirectory.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 1, 'should have one errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('Execution failed: invalid config files'), 'Should have shown error message');
        }, tr);
    });

    it('aws validate should succeed with no additional args', async () => {
        let tp = path.join(__dirname, './ValidateTests/AWS/AWSValidateSuccessNoAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('AWSValidateSuccessNoAdditionalArgsL0 should have succeeded.'), 'Should have printed: AWSValidateSuccessNoAdditionalArgsL0 should have succeeded.');
        }, tr);
    });

    it('aws validate should succeed with additional args', async () => {
        let tp = path.join(__dirname, './ValidateTests/AWS/AWSValidateSuccessAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('AWSValidateSuccessAdditionalArgsL0 should have succeeded.'), 'Should have printed: AWSValidateSuccessAdditionalArgsL0 should have succeeded.');
        }, tr);
    });

    it('aws validate should succeed with empty working directory', async () => {
        let tp = path.join(__dirname, './ValidateTests/AWS/AWSValidateSuccessEmptyWorkingDir.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('AWSValidateSuccessEmptyWorkingDirL0 should have succeeded.'), 'Should have printed: AWSValidateSuccessEmptyWorkingDirL0 should have succeeded.');
        }, tr);
    });

    it('aws validate should fail with invalid working directory', async () => {
        let tp = path.join(__dirname, './ValidateTests/AWS/AWSValidateFailInvalidWorkingDirectory.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 1, 'should have one error');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('Execution failed: invalid config files'), 'Should have shown error message');
        }, tr);
    });

    it('gcp validate should succeed with no additional args', async () => {
        let tp = path.join(__dirname, './ValidateTests/GCP/GCPValidateSuccessNoAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('GCPValidateSuccessNoAdditionalArgsL0 should have succeeded.'), 'Should have printed: GCPValidateSuccessNoAdditionalArgsL0 should have succeeded.');
        }, tr);
    });

    it('gcp validate should succeed with additional args', async () => {
        let tp = path.join(__dirname, './ValidateTests/GCP/GCPValidateSuccessAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('GCPValidateSuccessAdditionalArgsL0 should have succeeded.'), 'Should have printed: GCPValidateSuccessAdditionalArgsL0 should have succeeded.');
        }, tr);
    });

    it('gcp validate should succeed with empty working directory', async () => {
        let tp = path.join(__dirname, './ValidateTests/GCP/GCPValidateSuccessEmptyWorkingDir.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('GCPValidateSuccessEmptyWorkingDirL0 should have succeeded.'), 'Should have printed: GCPValidateSuccessEmptyWorkingDirL0 should have succeeded.');
        }, tr);
    });

    it('gcp validate should fail with invalid working directory', async () => {
        let tp = path.join(__dirname, './ValidateTests/GCP/GCPValidateFailInvalidWorkingDirectory.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 1, 'should have one error');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('Execution failed: invalid config files'), 'Should have shown error message');
        }, tr);
    });

    /* terraform plan tests */

    it('azure plan should succeed with no additional args', async () => {
        let tp = path.join(__dirname, './PlanTests/Azure/AzurePlanSuccessNoAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 1, 'should have 1 warning');
            assert(tr.stdOutContained('AzurePlanSuccessNoAdditionalArgsL0 should have succeeded.'), 'Should have printed: AzurePlanSuccessNoAdditionalArgsL0 should have succeeded.');
        }, tr);
    });

    it('azure plan should succeed with additional args', async () => {
        let tp = path.join(__dirname, './PlanTests/Azure/AzurePlanSuccessAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 1, 'should have 1 warning');
            assert(tr.stdOutContained('AzurePlanSuccessAdditionalArgsL0 should have succeeded.'), 'Should have printed: AzurePlanSuccessAdditionalArgsL0 should have succeeded.');
        }, tr);
    });

    it('azure plan should fail with invalid working directory', async () => {
        let tp = path.join(__dirname, './PlanTests/Azure/AzurePlanFailInvalidWorkingDirectory.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 1, 'should have one error');
            assert(tr.warningIssues.length === 1, 'should have 1 warning');
            assert(tr.stdOutContained('Execution failed: invalid config files'), 'Should have shown error message');
        }, tr);
    });

    it('azure plan should fail with empty working directory', async () => {
        let tp = path.join(__dirname, './PlanTests/Azure/AzurePlanFailEmptyWorkingDirectory.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 1, 'should have one error');
            assert(tr.warningIssues.length === 1, 'should have 1 warning');
            assert(tr.stdOutContained('Error: No configuration files'), 'Should have shown error message');
        }, tr);
    });

    it('aws plan should succeed with no additional args', async () => {
        let tp = path.join(__dirname, './PlanTests/AWS/AWSPlanSuccessNoAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('AWSPlanSuccessNoAdditionalArgsL0 should have succeeded.'), 'Should have printed: AWSPlanSuccessNoAdditionalArgsL0 should have succeeded.');
        }, tr);
    });

    it('aws plan should succeed with additional args', async () => {
        let tp = path.join(__dirname, './PlanTests/AWS/AWSPlanSuccessAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('AWSPlanSuccessAdditionalArgsL0 should have succeeded.'), 'Should have printed: AWSPlanSuccessAdditionalArgsL0 should have succeeded.');
        }, tr);
    });

    it('aws plan should fail with invalid working directory', async () => {
        let tp = path.join(__dirname, './PlanTests/AWS/AWSPlanFailInvalidWorkingDirectory.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 1, 'should have one error');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('Execution failed: invalid config files'), 'Should have shown error message');
        }, tr);
    });

    it('aws plan should fail with empty working directory', async () => {
        let tp = path.join(__dirname, './PlanTests/AWS/AWSPlanFailEmptyWorkingDirectory.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 1, 'should have one error');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('Error: No configuration files'), 'Should have shown error message');
        }, tr);
    });

    it('gcp plan should succeed with no additional args', async () => {
        let tp = path.join(__dirname, './PlanTests/GCP/GCPPlanSuccessNoAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('GCPPlanSuccessNoAdditionalArgsL0 should have succeeded.'), 'Should have printed: GCPPlanSuccessNoAdditionalArgsL0 should have succeeded.');
        }, tr);
    });

    it('gcp plan should succeed with additional args', async () => {
        let tp = path.join(__dirname, './PlanTests/GCP/GCPPlanSuccessAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('GCPPlanSuccessAdditionalArgsL0 should have succeeded.'), 'Should have printed: GCPPlanSuccessAdditionalArgsL0 should have succeeded.');
        }, tr);
    });

    it('gcp plan should fail with invalid working directory', async () => {
        let tp = path.join(__dirname, './PlanTests/GCP/GCPPlanFailInvalidWorkingDirectory.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 1, 'should have one error');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('Execution failed: invalid config files'), 'Should have shown error message');
        }, tr);
    });

    it('gcp plan should fail with empty working directory', async () => {
        let tp = path.join(__dirname, './PlanTests/GCP/GCPPlanFailEmptyWorkingDirectory.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 1, 'should have one error');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('Error: No configuration files'), 'Should have shown error message');
        }, tr);
    });

    /* terraform apply tests */

    it('azure apply should succeed with no additional args', async () => {
        let tp = path.join(__dirname, './ApplyTests/Azure/AzureApplySuccessNoAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 1, 'should have 1 warnings');
            assert(tr.stdOutContained('AzureApplySuccessNoAdditionalArgsL0 should have succeeded.'), 'Should have printed: AzureApplySuccessNoAdditionalArgsL0 should have succeeded.');
        }, tr);
    });

    it('azure apply should succeed with authentication scheme ManagedServiceIdentity', async () => {
        let tp = path.join(__dirname, './ApplyTests/Azure/AzureApplySuccessAuthenticationSchemeManagedServiceIdentity.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('AzureApplySuccessAuthenticationSchemeManagedServiceIdentityL0 should have succeeded.'), 'Should have printed: AzureApplySuccessAuthenticationSchemeManagedServiceIdentityL0 should have succeeded.');
        }, tr);
    });

    it('azure apply should succeed with authentication scheme WorkloadIdentityFederation', async () => {
        let tp = path.join(__dirname, './ApplyTests/Azure/AzureApplySuccessAuthenticationSchemeWorkloadIdentityFederation.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('AzureApplySuccessAuthenticationSchemeWorkloadIdentityFederationL0 should have succeeded.'), 'Should have printed: AzureApplySuccessAuthenticationSchemeWorkloadIdentityFederationL0 should have succeeded.');
        }, tr);
    });

    it('azure apply should succeed with additional args with -auto-approve', async () => {
        let tp = path.join(__dirname, './ApplyTests/Azure/AzureApplySuccessAdditionalArgsWithAutoApprove.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 1, 'should have 1 warning');
            assert(tr.stdOutContained('AzureApplySuccessAdditionalArgsWithAutoApproveL0 should have succeeded.'), 'Should have printed: AzureApplySuccessAdditionalArgsWithAutoApproveL0 should have succeeded.');
        }, tr);
    });

    it('azure apply should succeed with additional args without -auto-approve', async () => {
        let tp = path.join(__dirname, './ApplyTests/Azure/AzureApplySuccessAdditionalArgsWithoutAutoApprove.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 1, 'should have 1 warning');
            assert(tr.stdOutContained('AzureApplySuccessAdditionalArgsWithoutAutoApproveL0 should have succeeded.'), 'Should have printed: AzureApplySuccessAdditionalArgsWithoutAutoApproveL0 should have succeeded.');
        }, tr);
    });

    it('azure apply should fail with invalid working directory', async () => {
        let tp = path.join(__dirname, './ApplyTests/Azure/AzureApplyFailInvalidWorkingDirectory.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 1, 'should have one error');
            assert(tr.warningIssues.length === 1, 'should have 1 warning');
            assert(tr.stdOutContained('Execution failed: invalid config files'), 'Should have shown error message');
        }, tr);
    });

    it('azure apply should fail with empty working directory', async () => {
        let tp = path.join(__dirname, './ApplyTests/Azure/AzureApplyFailEmptyWorkingDirectory.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 1, 'should have one error');
            assert(tr.warningIssues.length === 1, 'should have 1 warning');
            assert(tr.stdOutContained('Error: No configuration files'), 'Should have shown error message');
        }, tr);
    });

    it('aws apply should succeed with no additional args', async () => {
        let tp = path.join(__dirname, './ApplyTests/AWS/AWSApplySuccessNoAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('AWSApplySuccessNoAdditionalArgsL0 should have succeeded.'), 'Should have printed: AWSApplySuccessNoAdditionalArgsL0 should have succeeded.');
        }, tr);
    });

    it('aws apply should succeed with additional args with -auto-approve', async () => {
        let tp = path.join(__dirname, './ApplyTests/AWS/AWSApplySuccessAdditionalArgsWithAutoApprove.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('AWSApplySuccessAdditionalArgsWithAutoApproveL0 should have succeeded.'), 'Should have printed: AWSApplySuccessAdditionalArgsWithAutoApproveL0 should have succeeded.');
        }, tr);
    });

    it('aws apply should succeed with additional args without -auto-approve', async () => {
        let tp = path.join(__dirname, './ApplyTests/AWS/AWSApplySuccessAdditionalArgsWithoutAutoApprove.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('AWSApplySuccessAdditionalArgsWithoutAutoApproveL0 should have succeeded.'), 'Should have printed: AWSApplySuccessAdditionalArgsWithoutAutoApproveL0 should have succeeded.');
        }, tr);
    });

    it('aws apply should fail with invalid working directory', async () => {
        let tp = path.join(__dirname, './ApplyTests/AWS/AWSApplyFailInvalidWorkingDirectory.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 1, 'should have one error');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('Execution failed: invalid config files'), 'Should have shown error message');
        }, tr);
    });

    it('aws apply should fail with empty working directory', async () => {
        let tp = path.join(__dirname, './ApplyTests/AWS/AWSApplyFailEmptyWorkingDirectory.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 1, 'should have one error');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('Error: No configuration files'), 'Should have shown error message');
        }, tr);
    });

    it('gcp apply should succeed with no additional args', async () => {
        let tp = path.join(__dirname, './ApplyTests/GCP/GCPApplySuccessNoAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('GCPApplySuccessNoAdditionalArgsL0 should have succeeded.'), 'Should have printed: GCPApplySuccessNoAdditionalArgsL0 should have succeeded.');
        }, tr);
    });

    it('gcp apply should succeed with additional args with -auto-approve', async () => {
        let tp = path.join(__dirname, './ApplyTests/GCP/GCPApplySuccessAdditionalArgsWithAutoApprove.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('GCPApplySuccessAdditionalArgsWithAutoApproveL0 should have succeeded.'), 'Should have printed: GCPApplySuccessAdditionalArgsWithAutoApproveL0 should have succeeded.');
        }, tr);
    });

    it('gcp apply should succeed with additional args without -auto-approve', async () => {
        let tp = path.join(__dirname, './ApplyTests/GCP/GCPApplySuccessAdditionalArgsWithoutAutoApprove.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('GCPApplySuccessAdditionalArgsWithoutAutoApproveL0 should have succeeded.'), 'Should have printed: GCPApplySuccessAdditionalArgsWithoutAutoApproveL0 should have succeeded.');
        }, tr);
    });

    it('gcp apply should fail with invalid working directory', async () => {
        let tp = path.join(__dirname, './ApplyTests/GCP/GCPApplyFailInvalidWorkingDirectory.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 1, 'should have one error');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('Execution failed: invalid config files'), 'Should have shown error message');
        }, tr);
    });

    it('gcp apply should fail with empty working directory', async () => {
        let tp = path.join(__dirname, './ApplyTests/GCP/GCPApplyFailEmptyWorkingDirectory.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 1, 'should have one error');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('Error: No configuration files'), 'Should have shown error message');
        }, tr);
    });

    /* terraform destroy tests */

    it('azure destroy should succeed with no additional args', async () => {
        let tp = path.join(__dirname, './DestroyTests/Azure/AzureDestroySuccessNoAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 1, 'should have 1 warning');
            assert(tr.stdOutContained('AzureDestroySuccessNoAdditionalArgsL0 should have succeeded.'), 'Should have printed: AzureDestroySuccessNoAdditionalArgsL0 should have succeeded.');
        }, tr);
    });

    it('azure destroy should succeed with additional args with -auto-approve', async () => {
        let tp = path.join(__dirname, './DestroyTests/Azure/AzureDestroySuccessAdditionalArgsWithAutoApprove.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 1, 'should have 1 warning');
            assert(tr.stdOutContained('AzureDestroySuccessAdditionalArgsWithAutoApproveL0 should have succeeded.'), 'Should have printed: AzureDestroySuccessAdditionalArgsWithAutoApproveL0 should have succeeded.');
        }, tr);
    });

    it('azure destroy should succeed with additional args without -auto-approve', async () => {
        let tp = path.join(__dirname, './DestroyTests/Azure/AzureDestroySuccessAdditionalArgsWithoutAutoApprove.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 1, 'should have 1 warning');
            assert(tr.stdOutContained('AzureDestroySuccessAdditionalArgsWithoutAutoApproveL0 should have succeeded.'), 'Should have printed: AzureDestroySuccessAdditionalArgsWithoutAutoApproveL0 should have succeeded.');
        }, tr);
    });

    it('azure destroy should fail with invalid working directory', async () => {
        let tp = path.join(__dirname, './DestroyTests/Azure/AzureDestroyFailInvalidWorkingDirectory.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 1, 'should have one error');
            assert(tr.warningIssues.length === 1, 'should have 1 warning');
            assert(tr.stdOutContained('Execution failed: invalid config files'), 'Should have shown error message');
        }, tr);
    });

    it('aws destroy should succeed with no additional args', async () => {
        let tp = path.join(__dirname, './DestroyTests/AWS/AWSDestroySuccessNoAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('AWSDestroySuccessNoAdditionalArgsL0 should have succeeded.'), 'Should have printed: AWSDestroySuccessNoAdditionalArgsL0 should have succeeded.');
        }, tr);
    });

    it('aws destroy should succeed with additional args with -auto-approve', async () => {
        let tp = path.join(__dirname, './DestroyTests/AWS/AWSDestroySuccessAdditionalArgsWithAutoApprove.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('AWSDestroySuccessAdditionalArgsWithAutoApproveL0 should have succeeded.'), 'Should have printed: AWSDestroySuccessAdditionalArgsWithAutoApproveL0 should have succeeded.');
        }, tr);
    });

    it('aws destroy should succeed with additional args without -auto-approve', async () => {
        let tp = path.join(__dirname, './DestroyTests/AWS/AWSDestroySuccessAdditionalArgsWithoutAutoApprove.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('AWSDestroySuccessAdditionalArgsWithoutAutoApproveL0 should have succeeded.'), 'Should have printed: AWSDestroySuccessAdditionalArgsWithoutAutoApproveL0 should have succeeded.');
        }, tr);
    });

    it('aws destroy should fail with invalid working directory', async () => {
        let tp = path.join(__dirname, './DestroyTests/AWS/AWSDestroyFailInvalidWorkingDirectory.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 1, 'should have one error');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('Execution failed: invalid config files'), 'Should have shown error message');
        }, tr);
    });

    it('gcp destroy should succeed with no additional args', async () => {
        let tp = path.join(__dirname, './DestroyTests/GCP/GCPDestroySuccessNoAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('GCPDestroySuccessNoAdditionalArgsL0 should have succeeded.'), 'Should have printed: GCPDestroySuccessNoAdditionalArgsL0 should have succeeded.');
        }, tr);
    });

    it('gcp destroy should succeed with additional args with -auto-approve', async () => {
        let tp = path.join(__dirname, './DestroyTests/GCP/GCPDestroySuccessAdditionalArgsWithAutoApprove.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('GCPDestroySuccessAdditionalArgsWithAutoApproveL0 should have succeeded.'), 'Should have printed: GCPDestroySuccessAdditionalArgsWithAutoApproveL0 should have succeeded.');
        }, tr);
    });

    it('gcp destroy should succeed with additional args without -auto-approve', async () => {
        let tp = path.join(__dirname, './DestroyTests/GCP/GCPDestroySuccessAdditionalArgsWithoutAutoApprove.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('GCPDestroySuccessAdditionalArgsWithoutAutoApproveL0 should have succeeded.'), 'Should have printed: GCPDestroySuccessAdditionalArgsWithoutAutoApproveL0 should have succeeded.');
        }, tr);
    });

    it('gcp destroy should fail with invalid working directory', async () => {
        let tp = path.join(__dirname, './DestroyTests/GCP/GCPDestroyFailInvalidWorkingDirectory.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 1, 'should have one error');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('Execution failed: invalid config files'), 'Should have shown error message');
        }, tr);
    });

    /* OCI provider tests */

    it('oci init should succeed with no additional args', async () => {
        let tp = path.join(__dirname, './InitTests/OCI/OCIInitSuccessNoAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();
        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('OCIInitSuccessNoAdditionalArgsL0 should have succeeded.'));
        }, tr);
    });

    it('oci plan should succeed with no additional args', async () => {
        let tp = path.join(__dirname, './PlanTests/OCI/OCIPlanSuccessNoAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();
        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('OCIPlanSuccessNoAdditionalArgsL0 should have succeeded.'));
        }, tr);
    });

    it('oci apply should succeed with no additional args', async () => {
        let tp = path.join(__dirname, './ApplyTests/OCI/OCIApplySuccessNoAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();
        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('OCIApplySuccessNoAdditionalArgsL0 should have succeeded.'));
        }, tr);
    });

    it('oci destroy should succeed with no additional args', async () => {
        let tp = path.join(__dirname, './DestroyTests/OCI/OCIDestroySuccessNoAdditionalArgs.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();
        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('OCIDestroySuccessNoAdditionalArgsL0 should have succeeded.'));
        }, tr);
    });

    /* test for multiple providers */

    it('warnIfMultipleProviders should not warn for single provider', async () => {
        let tp = path.join(__dirname, './MultipleProviderTests/SingleProviderNoWarning.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'should have invoked tool one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
        }, tr);
    });

    it('warnIfMultipleProviders should warn correctly for multiple providers', async () => {
        let tp = path.join(__dirname, './MultipleProviderTests/MultipleProviderWarning.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'should have invoked tool one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 1, 'should have one warning');
            assert(tr.createdWarningIssue('Multiple provider blocks specified in the .tf files in the current working directory.'), 'Should have created warning: Multiple provider blocks specified in the .tf files in the current working drectory.');
        }, tr);
    });

    /* terraform workspace tests */

    it('workspace select should succeed', async () => {
        let tp = path.join(__dirname, './WorkspaceTests/WorkspaceSelectSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('WorkspaceSelectSuccessL0 should have succeeded.'), 'Should have printed: WorkspaceSelectSuccessL0 should have succeeded.');
        }, tr);
    });

    it('workspace list should succeed', async () => {
        let tp = path.join(__dirname, './WorkspaceTests/WorkspaceListSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('WorkspaceListSuccessL0 should have succeeded.'), 'Should have printed: WorkspaceListSuccessL0 should have succeeded.');
        }, tr);
    });

    it('workspace select should fail for nonexistent workspace', async () => {
        let tp = path.join(__dirname, './WorkspaceTests/WorkspaceFail.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
        }, tr);
    });

    it('workspace new should succeed', async () => {
        let tp = path.join(__dirname, './WorkspaceTests/WorkspaceNewSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('WorkspaceNewSuccessL0 should have succeeded.'), 'Should have printed: WorkspaceNewSuccessL0 should have succeeded.');
        }, tr);
    });

    it('workspace delete should succeed', async () => {
        let tp = path.join(__dirname, './WorkspaceTests/WorkspaceDeleteSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('WorkspaceDeleteSuccessL0 should have succeeded.'), 'Should have printed: WorkspaceDeleteSuccessL0 should have succeeded.');
        }, tr);
    });

    it('workspace show should succeed', async () => {
        let tp = path.join(__dirname, './WorkspaceTests/WorkspaceShowSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('WorkspaceShowSuccessL0 should have succeeded.'), 'Should have printed: WorkspaceShowSuccessL0 should have succeeded.');
        }, tr);
    });

    /* terraform state tests */

    it('state list should succeed', async () => {
        let tp = path.join(__dirname, './StateTests/StateListSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('StateListSuccessL0 should have succeeded.'), 'Should have printed: StateListSuccessL0 should have succeeded.');
        }, tr);
    });

    it('state push should succeed and emit warning', async () => {
        let tp = path.join(__dirname, './StateTests/StatePushWarning.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length >= 1, 'should have at least one warning');
        }, tr);
    });

    it('state show should succeed', async () => {
        let tp = path.join(__dirname, './StateTests/StateShowSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('StateShowSuccessL0 should have succeeded.'), 'Should have printed: StateShowSuccessL0 should have succeeded.');
        }, tr);
    });

    it('state mv should succeed', async () => {
        let tp = path.join(__dirname, './StateTests/StateMvSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('StateMvSuccessL0 should have succeeded.'), 'Should have printed: StateMvSuccessL0 should have succeeded.');
        }, tr);
    });

    it('state rm should succeed', async () => {
        let tp = path.join(__dirname, './StateTests/StateRmSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('StateRmSuccessL0 should have succeeded.'), 'Should have printed: StateRmSuccessL0 should have succeeded.');
        }, tr);
    });

    it('state pull should succeed', async () => {
        let tp = path.join(__dirname, './StateTests/StatePullSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('StatePullSuccessL0 should have succeeded.'), 'Should have printed: StatePullSuccessL0 should have succeeded.');
        }, tr);
    });

    /* terraform fmt tests */

    it('fmt check should succeed when all files are formatted', async () => {
        let tp = path.join(__dirname, './FmtTests/FmtCheckSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('FmtCheckSuccessL0 should have succeeded.'), 'Should have printed: FmtCheckSuccessL0 should have succeeded.');
        }, tr);
    });

    it('fmt check should fail when files need formatting', async () => {
        let tp = path.join(__dirname, './FmtTests/FmtFail.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
        }, tr);
    });

    /* terraform get tests */

    it('get should succeed', async () => {
        let tp = path.join(__dirname, './GetTests/GetSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.warningIssues.length === 0, 'should have no warnings');
            assert(tr.stdOutContained('GetSuccessL0 should have succeeded.'), 'Should have printed: GetSuccessL0 should have succeeded.');
        }, tr);
    });

    it('get should fail when module download fails', async () => {
        let tp = path.join(__dirname, './GetTests/GetFail.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
        }, tr);
    });

    /* generic backend init tests */

    it('generic backend init should succeed with key=value config args', async () => {
        let tp = path.join(__dirname, './InitTests/Generic/GenericInitSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('GenericInitSuccessL0 should have succeeded.'), 'Should have printed: GenericInitSuccessL0 should have succeeded.');
        }, tr);
    });

    /* hcp backend init tests */

    it('hcp backend init should succeed with token, organization, and workspace', async () => {
        let tp = path.join(__dirname, './InitTests/HCP/HCPInitSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('HCPInitSuccessL0 should have succeeded.'), 'Should have printed: HCPInitSuccessL0 should have succeeded.');
        }, tr);
    });

    /* aws workload identity federation tests */

    it('aws plan should succeed with workload identity federation', async () => {
        let tp = path.join(__dirname, './PlanTests/AWS/AWSPlanWIFSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('AWSPlanWIFSuccessL0 should have succeeded.'), 'Should have printed: AWSPlanWIFSuccessL0 should have succeeded.');
        }, tr);
    });

    /* gcp workload identity federation tests */

    it('gcp plan should succeed with workload identity federation', async () => {
        let tp = path.join(__dirname, './PlanTests/GCP/GCPPlanWIFSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('GCPPlanWIFSuccessL0 should have succeeded.'), 'Should have printed: GCPPlanWIFSuccessL0 should have succeeded.');
        }, tr);
    });

    /* terraform plan/apply -replace flag tests */

    it('azure plan should succeed with -replace flag', async () => {
        let tp = path.join(__dirname, './PlanTests/Azure/AzurePlanWithReplaceAddress.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('AzurePlanWithReplaceAddressL0 should have succeeded.'), 'Should have printed: AzurePlanWithReplaceAddressL0 should have succeeded.');
        }, tr);
    });

    it('azure apply should succeed with -replace flag', async () => {
        let tp = path.join(__dirname, './ApplyTests/Azure/AzureApplyWithReplaceAddress.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('AzureApplyWithReplaceAddressL0 should have succeeded.'), 'Should have printed: AzureApplyWithReplaceAddressL0 should have succeeded.');
        }, tr);
    });

    /* aws/gcp workload identity federation apply tests */

    it('aws apply should succeed with workload identity federation', async () => {
        let tp = path.join(__dirname, './ApplyTests/AWS/AWSApplyWIFSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('AWSApplyWIFSuccessL0 should have succeeded.'), 'Should have printed: AWSApplyWIFSuccessL0 should have succeeded.');
        }, tr);
    });

    it('gcp apply should succeed with workload identity federation', async () => {
        let tp = path.join(__dirname, './ApplyTests/GCP/GCPApplyWIFSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('GCPApplyWIFSuccessL0 should have succeeded.'), 'Should have printed: GCPApplyWIFSuccessL0 should have succeeded.');
        }, tr);
    });

    /* aws/gcp workload identity federation destroy tests */

    it('aws destroy should succeed with workload identity federation', async () => {
        let tp = path.join(__dirname, './DestroyTests/AWS/AWSDestroyWIFSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('AWSDestroyWIFSuccessL0 should have succeeded.'), 'Should have printed: AWSDestroyWIFSuccessL0 should have succeeded.');
        }, tr);
    });

    it('gcp destroy should succeed with workload identity federation', async () => {
        let tp = path.join(__dirname, './DestroyTests/GCP/GCPDestroyWIFSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 2, 'tool should have been invoked two times. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('GCPDestroyWIFSuccessL0 should have succeeded.'), 'Should have printed: GCPDestroyWIFSuccessL0 should have succeeded.');
        }, tr);
    });

    /* terraform show tests */

    it('azure show to console should succeed', async () => {
        let tp = path.join(__dirname, './ShowTests/AzureShowConsoleSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('AzureShowConsoleSuccessL0 should have succeeded.'), 'Should have printed: AzureShowConsoleSuccessL0 should have succeeded.');
        }, tr);
    });

    it('azure show to file should succeed', async () => {
        let tp = path.join(__dirname, './ShowTests/AzureShowFileSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('AzureShowFileSuccessL0 should have succeeded.'), 'Should have printed: AzureShowFileSuccessL0 should have succeeded.');
        }, tr);
    });

    it('aws show to console should succeed', async () => {
        let tp = path.join(__dirname, './ShowTests/AWSShowConsoleSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('AWSShowConsoleSuccessL0 should have succeeded.'), 'Should have printed: AWSShowConsoleSuccessL0 should have succeeded.');
        }, tr);
    });

    it('gcp show to console should succeed', async () => {
        let tp = path.join(__dirname, './ShowTests/GCPShowConsoleSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('GCPShowConsoleSuccessL0 should have succeeded.'), 'Should have printed: GCPShowConsoleSuccessL0 should have succeeded.');
        }, tr);
    });

    /* terraform output tests */

    it('azure output should succeed', async () => {
        let tp = path.join(__dirname, './OutputTests/AzureOutputSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('AzureOutputSuccessL0 should have succeeded.'), 'Should have printed: AzureOutputSuccessL0 should have succeeded.');
        }, tr);
    });

    it('aws output should succeed', async () => {
        let tp = path.join(__dirname, './OutputTests/AWSOutputSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('AWSOutputSuccessL0 should have succeeded.'), 'Should have printed: AWSOutputSuccessL0 should have succeeded.');
        }, tr);
    });

    it('gcp output should succeed', async () => {
        let tp = path.join(__dirname, './OutputTests/GCPOutputSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('GCPOutputSuccessL0 should have succeeded.'), 'Should have printed: GCPOutputSuccessL0 should have succeeded.');
        }, tr);
    });

    /* terraform custom tests */

    it('azure custom command to console should succeed', async () => {
        let tp = path.join(__dirname, './CustomTests/AzureCustomConsoleSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('AzureCustomConsoleSuccessL0 should have succeeded.'), 'Should have printed: AzureCustomConsoleSuccessL0 should have succeeded.');
        }, tr);
    });

    it('aws custom command to console should succeed', async () => {
        let tp = path.join(__dirname, './CustomTests/AWSCustomConsoleSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('AWSCustomConsoleSuccessL0 should have succeeded.'), 'Should have printed: AWSCustomConsoleSuccessL0 should have succeeded.');
        }, tr);
    });

    /* terraform test command tests */

    it('azure test command should succeed', async () => {
        let tp = path.join(__dirname, './TestCommandTests/AzureTestSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('AzureTestSuccessL0 should have succeeded.'), 'Should have printed: AzureTestSuccessL0 should have succeeded.');
        }, tr);
    });

    it('aws test command should succeed', async () => {
        let tp = path.join(__dirname, './TestCommandTests/AWSTestSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('AWSTestSuccessL0 should have succeeded.'), 'Should have printed: AWSTestSuccessL0 should have succeeded.');
        }, tr);
    });

    it('gcp test command should succeed', async () => {
        let tp = path.join(__dirname, './TestCommandTests/GCPTestSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('GCPTestSuccessL0 should have succeeded.'), 'Should have printed: GCPTestSuccessL0 should have succeeded.');
        }, tr);
    });

    it('oci test command should succeed', async () => {
        let tp = path.join(__dirname, './TestCommandTests/OCITestSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);

        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('OCITestSuccessL0 should have succeeded.'), 'Should have printed: OCITestSuccessL0 should have succeeded.');
        }, tr);
    });

    /* backend type decoupling tests */

    it('init with s3 backend and azurerm provider should succeed', async () => {
        let tp = path.join(__dirname, './InitTests/BackendDecoupling/S3BackendAzureProviderInitSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();
        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('S3BackendAzureProviderInitSuccessL0 should have succeeded.'));
        }, tr);
    });

    /* OCI expanded coverage tests */

    it('oci validate should succeed', async () => {
        let tp = path.join(__dirname, './ValidateTests/OCI/OCIValidateSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();
        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('OCIValidateSuccessL0 should have succeeded.'));
        }, tr);
    });

    it('oci show to console should succeed', async () => {
        let tp = path.join(__dirname, './ShowTests/OCIShowConsoleSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();
        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('OCIShowConsoleSuccessL0 should have succeeded.'));
        }, tr);
    });

    it('oci output should succeed', async () => {
        let tp = path.join(__dirname, './OutputTests/OCIOutputSuccess.js');
        let tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();
        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.invokedToolCount === 1, 'tool should have been invoked one time. actual: ' + tr.invokedToolCount);
            assert(tr.errorIssues.length === 0, 'should have no errors');
            assert(tr.stdOutContained('OCIOutputSuccessL0 should have succeeded.'));
        }, tr);
    });

});