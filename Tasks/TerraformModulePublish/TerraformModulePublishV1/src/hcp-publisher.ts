import { HttpClient, parseJson, delay, retryHttp, truncateBody } from './http';
import { ModuleCoordinates, PublishResult, RegistryPublisher } from './types';
import tasks = require('azure-pipelines-task-lib/task');

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
    ) { }

    async publish(): Promise<PublishResult> {
        const o = this.options;
        const headers = {
            Authorization: `Bearer ${o.token}`,
            'Content-Type': 'application/vnd.api+json',
        };

        const check = await retryHttp(() => this.http('GET', moduleUrl(o), headers), { log: this.log });
        if (check.status >= 200 && check.status < 300) {
            if (versionStatus(check.body, o.version) === 'ok') {
                return { published: false, message: tasks.loc('HcpVersionAlreadyReady', o.version) };
            }
        } else if (check.status === 404) {
            if (!o.vcsRepoIdentifier || !o.vcsOauthTokenId) {
                throw new Error(tasks.loc('HcpModuleNotFoundNoVcsInputs'));
            }
            this.log(tasks.loc('HcpCreatingVcsModule', o.namespace, o.name, o.provider));
            // The VCS module create is keyed by namespace/name/provider, so a retried
            // POST after a transient 5xx cannot create a duplicate module — safe to
            // wrap in retryHttp like the sibling module-check GET and version create.
            const created = await retryHttp(
                () => this.http('POST', vcsUrl(o.address, o.namespace), headers, vcsModuleBody(o)),
                { log: this.log },
            );
            if (created.status < 200 || created.status >= 300) {
                throw new Error(tasks.loc('HcpCreateModuleFailed', created.status, truncateBody(created.body)));
            }
        } else {
            this.log(tasks.loc('HcpCheckModuleFailed', check.status));
        }

        const versionResp = await retryHttp(
            () => this.http('POST', versionsUrl(o), headers, versionBody(o.version, o.commitSha)),
            { log: this.log },
        );
        if (versionResp.status === 422) {
            this.log(tasks.loc('HcpVersionAlreadyExists', o.version));
        } else if (versionResp.status < 200 || versionResp.status >= 300) {
            throw new Error(tasks.loc('HcpCreateVersionFailed', versionResp.status, truncateBody(versionResp.body)));
        } else {
            this.log(tasks.loc('HcpVersionCreated', o.version));
        }

        if (o.waitForPublish && !(await this.waitForOk(headers))) {
            throw new Error(tasks.loc('HcpWaitTimedOut', o.timeoutSeconds, o.version));
        }
        return { published: true, message: tasks.loc('HcpVersionPublished', o.version) };
    }

    private async waitForOk(headers: Record<string, string>): Promise<boolean> {
        const deadline = Date.now() + this.options.timeoutSeconds * 1000;
        for (; ;) {
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
                this.log(tasks.loc('HcpPollingFailed', err instanceof Error ? err.message : String(err)));
            }
            if (Date.now() >= deadline) {
                return false;
            }
            await delay(3000);
        }
    }
}
