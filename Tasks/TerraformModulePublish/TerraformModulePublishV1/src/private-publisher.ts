import { HttpClient, parseJson, delay, retryHttp, truncateBody } from './http';
import { ModuleCoordinates, PublishResult, RegistryPublisher } from './types';

/** Inputs for publishing to a private registry (terraform-registry-backend). */
export interface PrivateRegistryOptions extends ModuleCoordinates {
    registryUrl: string;
    apiKey: string;
    waitForPublish: boolean;
    timeoutSeconds: number;
    /**
     * Optional SCM auto-registration inputs. When all three of scmProviderId,
     * repositoryOwner, and repositoryName are provided, a module that does not yet
     * exist is created and SCM-linked automatically instead of failing. If any is
     * absent, a missing module remains a hard error (unchanged behavior).
     */
    scmProviderId?: string;
    repositoryOwner?: string;
    repositoryName?: string;
    defaultBranch?: string;
    tagPattern?: string;
}

interface ModuleVersionEntry {
    version: string;
}

interface ModuleResponse {
    id?: string;
    versions?: ModuleVersionEntry[];
}

export function trimTrailingSlash(url: string): string {
    return url.replace(/\/+$/, '');
}

export function moduleUrl(base: string, c: ModuleCoordinates): string {
    return (
        `${trimTrailingSlash(base)}/api/v1/modules/` +
        `${encodeURIComponent(c.namespace)}/${encodeURIComponent(c.name)}/${encodeURIComponent(c.provider)}`
    );
}

export function syncUrl(base: string, moduleId: string): string {
    return `${trimTrailingSlash(base)}/api/v1/admin/modules/${moduleId}/scm/sync`;
}

/** Admin endpoint that creates (or returns) a module record without a version file. */
export function createUrl(base: string): string {
    return `${trimTrailingSlash(base)}/api/v1/admin/modules/create`;
}

/** Admin endpoint that links a module to its SCM source repository. */
export function linkUrl(base: string, moduleId: string): string {
    return `${trimTrailingSlash(base)}/api/v1/admin/modules/${moduleId}/scm`;
}

/** Body for the create-module-record call. The registry's `system` is our `provider`. */
export function createBody(c: ModuleCoordinates): string {
    return JSON.stringify({ namespace: c.namespace, name: c.name, system: c.provider });
}

/** Body for the SCM-link call. repository_owner/name are the registry's repo coordinates. */
export function linkBody(o: PrivateRegistryOptions): string {
    return JSON.stringify({
        provider_id: o.scmProviderId,
        repository_owner: o.repositoryOwner,
        repository_name: o.repositoryName,
        default_branch: o.defaultBranch || 'main',
        tag_pattern: o.tagPattern || 'v*',
    });
}

export function hasVersion(body: string, version: string): boolean {
    const parsed = parseJson<ModuleResponse>(body);
    return Array.isArray(parsed.versions) && parsed.versions.some((v) => v.version === version);
}

/**
 * Publishes by triggering the registry's SCM tag-sync; the registry imports the freshly-pushed
 * git tag as a new version. When the module does not yet exist and the SCM registration inputs
 * (scmProviderId, repositoryOwner, repositoryName) are provided, it is created and SCM-linked
 * first; otherwise a missing module is a hard error.
 */
export class PrivateRegistryPublisher implements RegistryPublisher {
    constructor(
        private readonly http: HttpClient,
        private readonly options: PrivateRegistryOptions,
        private readonly log: (message: string) => void = console.log,
    ) { }

    async publish(): Promise<PublishResult> {
        const { registryUrl, apiKey, namespace, name, provider, version } = this.options;
        const authHeader = { Authorization: `Bearer ${apiKey}` };
        const modUrl = moduleUrl(registryUrl, this.options);

        const moduleResp = await retryHttp(() => this.http('GET', modUrl, authHeader), { log: this.log });
        let moduleId: string | undefined;
        if (moduleResp.status === 404) {
            // Brand-new module: auto-create + SCM-link when the caller supplied the
            // registration inputs; otherwise preserve the original hard error.
            moduleId = await this.createAndLinkModule(authHeader);
        } else if (moduleResp.status < 200 || moduleResp.status >= 300) {
            throw new Error(`Failed to resolve module (HTTP ${moduleResp.status}): ${truncateBody(moduleResp.body)}`);
        } else {
            moduleId = parseJson<ModuleResponse>(moduleResp.body).id;
        }
        if (!moduleId) {
            throw new Error('Registry response did not include a module id.');
        }

        const syncResp = await this.http('POST', syncUrl(registryUrl, moduleId), authHeader);
        if (syncResp.status !== 202) {
            throw new Error(`Failed to trigger sync (HTTP ${syncResp.status}): ${truncateBody(syncResp.body)}`);
        }
        this.log(`Sync triggered for ${namespace}/${name}/${provider}.`);

        if (!this.options.waitForPublish) {
            return { published: true, message: `Sync triggered for version ${version}.` };
        }

        if (!(await this.waitForVersion(modUrl, authHeader))) {
            throw new Error(
                `Timed out after ${this.options.timeoutSeconds}s waiting for version ${version} to appear in the registry.`,
            );
        }
        return { published: true, message: `Version ${version} is available in the registry.` };
    }

    /**
     * Creates and SCM-links a module that does not yet exist, returning its id.
     * Requires scmProviderId, repositoryOwner, and repositoryName; without them a
     * missing module is a hard error, exactly as before. The create call is a
     * get-or-create (idempotent) and the link call tolerates 409 (already linked),
     * so both are safe to wrap in retryHttp against a transient 5xx / lost response.
     */
    private async createAndLinkModule(authHeader: Record<string, string>): Promise<string> {
        const { registryUrl, namespace, name, provider, scmProviderId, repositoryOwner, repositoryName } = this.options;
        if (!scmProviderId || !repositoryOwner || !repositoryName) {
            throw new Error(
                `Module ${namespace}/${name}/${provider} not found in the registry. ` +
                'Register and SCM-link the module before publishing, or set scmProviderId, ' +
                'repositoryOwner, and repositoryName to auto-create it.',
            );
        }
        const jsonHeaders = { ...authHeader, 'Content-Type': 'application/json' };

        // Get-or-create the module record (200 if it already exists, 201 if created).
        const createResp = await retryHttp(
            () => this.http('POST', createUrl(registryUrl), jsonHeaders, createBody(this.options)),
            { log: this.log },
        );
        if (createResp.status < 200 || createResp.status >= 300) {
            throw new Error(`Failed to create module (HTTP ${createResp.status}): ${truncateBody(createResp.body)}`);
        }
        const moduleId = parseJson<ModuleResponse>(createResp.body).id;
        if (!moduleId) {
            throw new Error('Registry create response did not include a module id.');
        }
        this.log(`Created module record ${namespace}/${name}/${provider}.`);

        // Link it to its SCM repository. A 409 means it is already linked — treat as success.
        const linkResp = await retryHttp(
            () => this.http('POST', linkUrl(registryUrl, moduleId), jsonHeaders, linkBody(this.options)),
            { log: this.log },
        );
        if (linkResp.status === 409) {
            this.log(`Module ${namespace}/${name}/${provider} is already SCM-linked.`);
        } else if (linkResp.status < 200 || linkResp.status >= 300) {
            throw new Error(`Failed to SCM-link module (HTTP ${linkResp.status}): ${truncateBody(linkResp.body)}`);
        } else {
            this.log(`SCM-linked ${namespace}/${name}/${provider} to ${repositoryOwner}/${repositoryName}.`);
        }
        return moduleId;
    }

    private async waitForVersion(modUrl: string, authHeader: Record<string, string>): Promise<boolean> {
        const deadline = Date.now() + this.options.timeoutSeconds * 1000;
        for (; ;) {
            // A single poll failing (e.g. a per-request timeout or transient 5xx)
            // must not abort the wait; keep polling until the wall-clock deadline.
            try {
                const resp = await this.http('GET', modUrl, authHeader);
                if (resp.status >= 200 && resp.status < 300 && hasVersion(resp.body, this.options.version)) {
                    return true;
                }
            } catch (err) {
                this.log(`Polling registry failed, will retry: ${err instanceof Error ? err.message : String(err)}`);
            }
            if (Date.now() >= deadline) {
                return false;
            }
            await delay(3000);
        }
    }
}
