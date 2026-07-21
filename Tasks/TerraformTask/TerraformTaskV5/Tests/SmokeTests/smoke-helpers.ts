import fs = require('fs');
import os = require('os');
import path = require('path');
import { execFileSync } from 'child_process';

/**
 * Copies the shared local-backend `terraform_data` fixture into a fresh
 * scratch directory (under os.tmpdir()) and returns its path. Each scenario
 * gets its own directory so parallel/sequential scenarios never collide over
 * `.terraform/`, state, or lock files -- and a fresh `terraform init` (fully
 * offline: the fixture declares no provider) is required per scratch dir.
 */
export function prepareScratchFixture(): string {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-smoke-'));
    const fixtureSrc = path.join(__dirname, 'fixtures', 'local-data', 'main.tf');
    fs.copyFileSync(fixtureSrc, path.join(scratchDir, 'main.tf'));
    return scratchDir;
}

/** Best-effort recursive removal of a scratch directory created by {@link prepareScratchFixture}. */
export function cleanupScratchFixture(scratchDir: string): void {
    try {
        fs.rmSync(scratchDir, { recursive: true, force: true });
    } catch {
        // best-effort -- os.tmpdir() is periodically reaped by the OS/agent anyway.
    }
}

/**
 * Runs a real, direct `terraform init` in workingDirectory -- deliberately
 * NOT via the task's own `handler.init()`, which unconditionally calls
 * handleBackend() and requires a `backendServiceArm`/equivalent input
 * regardless of what backend block the .tf actually declares (it builds
 * `-backend-config=` args assuming a cloud remote backend). This harness's
 * fixture uses `backend "local" {}`, and #719/the argv-injection bugs this
 * harness targets (#612/#613) live entirely in plan/apply/destroy/show, not
 * init/backend-credential wiring -- so bypassing the task's init path here
 * keeps the harness focused on the argv surface in scope, without needing to
 * fake cloud backend credentials that would only be rejected by a local
 * backend's own arg validation anyway.
 */
export function realTerraformInit(workingDirectory: string): void {
    execFileSync('terraform', ['init', '-no-color'], { cwd: workingDirectory, stdio: 'pipe' });
}

/**
 * Sets the fake Azure ServicePrincipal service-connection env vars every
 * scenario needs for handleProvider() to complete without a real network call
 * (setCommonVariables() only WRITES ARM_* environment variables from these --
 * it never validates or calls out anywhere). The fixture's main.tf declares no
 * `azurerm` provider block, so terraform never reads/consumes the resulting
 * ARM_* variables either -- this is what makes the whole scenario network-free.
 */
export function setFakeAzureServiceConnectionEnv(): void {
    process.env['ENDPOINT_AUTH_SCHEME_AzureRM'] = 'ServicePrincipal';
    process.env['ENDPOINT_DATA_AzureRM_SUBSCRIPTIONID'] = '00000000-0000-0000-0000-000000000000';
    process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALID'] = 'DummyServicePrincipalId';
    process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALKEY'] = 'DummyServicePrincipalKey';
    process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_TENANTID'] = '00000000-0000-0000-0000-000000000000';
}

