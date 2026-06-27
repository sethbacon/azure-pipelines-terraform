import { HttpClient, parseJson, delay, truncateBody } from './http';
import { ModuleCoordinates, PublishResult, RegistryPublisher } from './types';

/** Inputs for publishing to HCP Terraform / Terraform Enterprise. */
export interface HcpOptions extends ModuleCoordinates {
    address: string;
    token: string;
    vcsRepoIdentifier: string;
    vcsBranch: string;
    vcsOauthTokenId: string;
    commitSha: string;
    waitForPublish: boolean;
    timeoutSeconds: number;
}

interface VersionStatus {
    version: string;
    status: string;
}

interface HcpModuleResponse {
    data?: {
        attributes?: {
            'version-statuses'?: VersionStatus[];
        };
    };
}

type HcpModuleRef = ModuleCoordinates & { address: string };

export function moduleUrl(o: HcpModuleRef): string {
    const base = o.address.replace(/\/+$/, '');
    return (
        `${base}/api/v2/organizations/${encodeURIComponent(o.namespace)}/registry-modules/private/` +
        `${encodeURIComponent(o.namespace)}/${encodeURIComponent(o.name)}/${encodeURIComponent(o.provider)}`
    );
}

export function versionsUrl(o: HcpModuleRef): string {
    return `${moduleUrl(o)}/versions`;
}

export function vcsUrl(address: string, namespace: string): string {
    return `${address.replace(/\/+$/, '')}/api/v2/organizations/${encodeURIComponent(namespace)}/registry-modules/vcs`;
}

export function versionStatus(body: string, version: string): string | undefined {
    const parsed = parseJson<HcpModuleResponse>(body);
    const statuses = parsed.data?.attributes?.['version-statuses'] ?? [];
    return statuses.find((s) => s.version === version)?.status;
}

export function vcsModuleBody(o: HcpOptions): string {
    return JSON.stringify({
        data: {
            type: 'registry-modules',
            attributes: {
                'vcs-repo': {
                    identifier: o.vcsRepoIdentifier,
                    'display-identifier': o.vcsRepoIdentifier,
                    'oauth-token-id': o.vcsOauthTokenId,
                    branch: o.vcsBranch,
                },
                'no-code': false,
            },
        },
    });
}

export function versionBody(version: string, commitSha: string): string {
    return JSON.stringify({
        data: {
            type: 'registry-modules-versions',
            attributes: { version, 'commit-sha': commitSha },
        },
    });
}

/**
 * Publishes a module version to HCP Terraform: checks the module, creates a VCS-connected module
 * if it does not exist, creates the version, and (optionally) waits for it to become ready.
 */
export class HcpPublisher implements RegistryPublisher {
    constructor(
        private readonly http: HttpClient,
        private readonly options: HcpOptions,
        private readonly log: (message: string) => void = console.log,
    ) {}

    async publish(): Promise<PublishResult> {
        const o = this.options;
        const headers = {
            Authorization: `Bearer ${o.token}`,
            'Content-Type': 'application/vnd.api+json',
        };

        const check = await this.http('GET', moduleUrl(o), headers);
        if (check.status >= 200 && check.status < 300) {
            if (versionStatus(check.body, o.version) === 'ok') {
                return { published: false, message: `Version ${o.version} already exists and is ready.` };
            }
        } else if (check.status === 404) {
            if (!o.vcsRepoIdentifier || !o.vcsOauthTokenId) {
                throw new Error(
                    'Module does not exist and vcsRepoIdentifier / vcsOauthTokenId were not provided to create it.',
                );
            }
            this.log(`Module not found; creating VCS-connected module ${o.namespace}/${o.name}/${o.provider}.`);
            const created = await this.http('POST', vcsUrl(o.address, o.namespace), headers, vcsModuleBody(o));
            if (created.status < 200 || created.status >= 300) {
                throw new Error(`Failed to create HCP module (HTTP ${created.status}): ${truncateBody(created.body)}`);
            }
        } else {
            this.log(`Could not check existing module (HTTP ${check.status}); attempting to publish version.`);
        }

        const versionResp = await this.http('POST', versionsUrl(o), headers, versionBody(o.version, o.commitSha));
        if (versionResp.status === 422) {
            this.log(`Version ${o.version} already exists.`);
        } else if (versionResp.status < 200 || versionResp.status >= 300) {
            throw new Error(`Failed to create version (HTTP ${versionResp.status}): ${truncateBody(versionResp.body)}`);
        } else {
            this.log(`Version ${o.version} created.`);
        }

        if (o.waitForPublish && !(await this.waitForOk(headers))) {
            throw new Error(`Timed out after ${o.timeoutSeconds}s waiting for version ${o.version} to become ready.`);
        }
        return { published: true, message: `Version ${o.version} published to HCP Terraform.` };
    }

    private async waitForOk(headers: Record<string, string>): Promise<boolean> {
        const deadline = Date.now() + this.options.timeoutSeconds * 1000;
        for (;;) {
            // A single poll failing (e.g. a per-request timeout or transient 5xx)
            // must not abort the wait; keep polling until the wall-clock deadline.
            try {
                const resp = await this.http('GET', moduleUrl(this.options), headers);
                if (
                    resp.status >= 200 &&
                    resp.status < 300 &&
                    versionStatus(resp.body, this.options.version) === 'ok'
                ) {
                    return true;
                }
            } catch (err) {
                this.log(`Polling version status failed, will retry: ${err instanceof Error ? err.message : String(err)}`);
            }
            if (Date.now() >= deadline) {
                return false;
            }
            await delay(3000);
        }
    }
}
