import { HttpClient, parseJson, delay } from './http';
import { ModuleCoordinates, PublishResult, RegistryPublisher } from './types';

/** Inputs for publishing to a private registry (terraform-registry-backend). */
export interface PrivateRegistryOptions extends ModuleCoordinates {
    registryUrl: string;
    apiKey: string;
    waitForPublish: boolean;
    timeoutSeconds: number;
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

export function hasVersion(body: string, version: string): boolean {
    const parsed = parseJson<ModuleResponse>(body);
    return Array.isArray(parsed.versions) && parsed.versions.some((v) => v.version === version);
}

/**
 * Publishes by triggering the registry's SCM tag-sync. The module must already exist and be
 * SCM-linked; the registry imports the freshly-pushed git tag as a new version.
 */
export class PrivateRegistryPublisher implements RegistryPublisher {
    constructor(
        private readonly http: HttpClient,
        private readonly options: PrivateRegistryOptions,
        private readonly log: (message: string) => void = console.log,
    ) {}

    async publish(): Promise<PublishResult> {
        const { registryUrl, apiKey, namespace, name, provider, version } = this.options;
        const authHeader = { Authorization: `Bearer ${apiKey}` };
        const modUrl = moduleUrl(registryUrl, this.options);

        const moduleResp = await this.http('GET', modUrl, authHeader);
        if (moduleResp.status === 404) {
            throw new Error(
                `Module ${namespace}/${name}/${provider} not found in the registry. ` +
                    'Register and SCM-link the module before publishing.',
            );
        }
        if (moduleResp.status < 200 || moduleResp.status >= 300) {
            throw new Error(`Failed to resolve module (HTTP ${moduleResp.status}): ${moduleResp.body}`);
        }
        const moduleId = parseJson<ModuleResponse>(moduleResp.body).id;
        if (!moduleId) {
            throw new Error('Registry response did not include a module id.');
        }

        const syncResp = await this.http('POST', syncUrl(registryUrl, moduleId), authHeader);
        if (syncResp.status !== 202) {
            throw new Error(`Failed to trigger sync (HTTP ${syncResp.status}): ${syncResp.body}`);
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

    private async waitForVersion(modUrl: string, authHeader: Record<string, string>): Promise<boolean> {
        const deadline = Date.now() + this.options.timeoutSeconds * 1000;
        for (;;) {
            const resp = await this.http('GET', modUrl, authHeader);
            if (resp.status >= 200 && resp.status < 300 && hasVersion(resp.body, this.options.version)) {
                return true;
            }
            if (Date.now() >= deadline) {
                return false;
            }
            await delay(3000);
        }
    }
}
