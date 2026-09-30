import { HttpClient, HttpResponse, parseJson, delay, retryAfterMs, retryHttp, truncateBody } from './http';
import { ModuleCoordinates, PublishResult, RegistryPublisher } from './types';
import { RETRY_AFTER_CAP_MS } from '@4cloudguru/pipeline-task-core';
import tasks = require('azure-pipelines-task-lib/task');

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

/**
 * Shape-check for the registry's module id before it is trusted enough to
 * interpolate into an admin API URL path segment. terraform-registry-backend
 * generates this id as a database primary key (module_repository.go issues
 * `INSERT INTO modules (...) RETURNING id`), typically a UUID, but this check
 * intentionally accepts any bounded alphanumeric/dash/underscore token rather
 * than pinning to the UUID shape specifically — it exists to reject
 * path-traversal and URL-metacharacter payloads (`/`, `..`, `?`, `#`,
 * whitespace, control characters), not to police the backend's id format.
 * Mirrors the isValidSysId belt-and-suspenders discipline already used for
 * ServiceNow sys_ids (image-rewrite.ts, #606): validated once where it is
 * parsed out of an untrusted registry response and again at the point of
 * interpolation, so a compromised or misbehaving registry cannot smuggle a
 * path segment or query string into an admin endpoint (#768).
 */
export function isValidModuleId(id: string): boolean {
    return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

export function moduleUrl(base: string, c: ModuleCoordinates): string {
    return (
        `${trimTrailingSlash(base)}/api/v1/modules/` +
        `${encodeURIComponent(c.namespace)}/${encodeURIComponent(c.name)}/${encodeURIComponent(c.provider)}`
    );
}

export function syncUrl(base: string, moduleId: string): string {
    if (!isValidModuleId(moduleId)) {
        throw new Error(tasks.loc('PrivateModuleIdInvalid', moduleId));
    }
    return `${trimTrailingSlash(base)}/api/v1/admin/modules/${encodeURIComponent(moduleId)}/scm/sync`;
}

/** Admin endpoint that creates (or returns) a module record without a version file. */
export function createUrl(base: string): string {
    return `${trimTrailingSlash(base)}/api/v1/admin/modules/create`;
}

/** Admin endpoint that links a module to its SCM source repository. */
export function linkUrl(base: string, moduleId: string): string {
    if (!isValidModuleId(moduleId)) {
        throw new Error(tasks.loc('PrivateModuleIdInvalid', moduleId));
    }
    return `${trimTrailingSlash(base)}/api/v1/admin/modules/${encodeURIComponent(moduleId)}/scm`;
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

function listsVersion(module: ModuleResponse, version: string): boolean {
    return Array.isArray(module.versions) && module.versions.some((v) => v.version === version);
}

export function hasVersion(body: string, version: string): boolean {
    return listsVersion(parseJson<ModuleResponse>(body), version);
}

/** Time source for the wait-for-publish poll loop, injectable so tests need not really sleep. */
export interface PollClock {
    now(): number;
    sleep(ms: number): Promise<void>;
    random(): number;
}

const systemClock: PollClock = { now: () => Date.now(), sleep: delay, random: Math.random };

/** First wait-for-publish poll interval; each later one doubles, up to POLL_MAX_MS. */
const POLL_INITIAL_MS = 3000;
/** Poll interval ceiling -- the same cap applied to a server-supplied Retry-After. */
const POLL_MAX_MS = RETRY_AFTER_CAP_MS;

/**
 * The wait after poll `pollIndex`: capped exponential backoff with equal jitter,
 * i.e. a value in the upper half of min(POLL_MAX_MS, POLL_INITIAL_MS * 2^pollIndex).
 * The status poll shares the sync's rate-limited API key, so a fixed 3s interval
 * across a burst of concurrent publishes was the largest load on that bucket;
 * the jitter keeps publishers started together from polling in lockstep.
 */
function pollBackoffMs(pollIndex: number, random: number): number {
    const ceiling = Math.min(POLL_MAX_MS, POLL_INITIAL_MS * 2 ** pollIndex);
    return Math.round(ceiling / 2 + random * (ceiling / 2));
}

/**
 * Publishes by triggering the registry's SCM tag-sync; the registry imports the freshly-pushed
 * git tag as a new version. When the module does not yet exist and the SCM registration inputs
 * (scmProviderId, repositoryOwner, repositoryName) are provided, it is created and SCM-linked
 * first; otherwise a missing module is a hard error. A version the registry already lists is
 * reported as already published without triggering a sync.
 */
export class PrivateRegistryPublisher implements RegistryPublisher {
    constructor(
        private readonly http: HttpClient,
        private readonly options: PrivateRegistryOptions,
        private readonly log: (message: string) => void = console.log,
        private readonly clock: PollClock = systemClock,
    ) { }

    async publish(): Promise<PublishResult> {
        const { registryUrl, apiKey, namespace, name, provider, version } = this.options;
        const authHeader = { Authorization: `Bearer ${apiKey}` };
        const modUrl = moduleUrl(registryUrl, this.options);

        const moduleResp = await retryHttp(() => this.http('GET', modUrl, authHeader), { log: this.log });
        let moduleId: string | undefined;
        let linkedThisRun = false;
        if (moduleResp.status === 404) {
            // Brand-new module: auto-create + SCM-link when the caller supplied the
            // registration inputs; otherwise preserve the original hard error.
            moduleId = await this.createAndLinkModule(authHeader);
            linkedThisRun = true;
        } else if (moduleResp.status < 200 || moduleResp.status >= 300) {
            throw new Error(tasks.loc('PrivateResolveModuleFailed', moduleResp.status, truncateBody(moduleResp.body)));
        } else {
            const moduleRecord = parseJson<ModuleResponse>(moduleResp.body);
            if (listsVersion(moduleRecord, version)) {
                // Nothing to import, so no admin call and no polling: a re-run after a
                // partially-failed burst of releases costs one GET per module.
                return {
                    published: false,
                    message: tasks.loc('PrivateVersionAlreadyPublished', version, namespace, name, provider),
                };
            }
            moduleId = moduleRecord.id;
        }
        if (!moduleId) {
            throw new Error(tasks.loc('PrivateNoModuleId'));
        }
        if (!isValidModuleId(moduleId)) {
            throw new Error(tasks.loc('PrivateModuleIdInvalid', moduleId));
        }

        let syncResp = await this.triggerSync(moduleId, authHeader);
        if (syncResp.status === 404 && !linkedThisRun && this.hasScmInputs()) {
            // The sync endpoint's only 404 (no `tag` is sent) is "module is not linked
            // to a repository": an earlier run created the record but its link call
            // failed. Link it now (409 = already linked) and retry the sync once. A
            // module this run just linked is excluded -- re-linking could not change
            // the answer.
            this.log(tasks.loc('PrivateSyncModuleNotLinked', namespace, name, provider));
            await this.linkModule(moduleId, authHeader);
            syncResp = await this.triggerSync(moduleId, authHeader);
        }
        if (syncResp.status !== 202) {
            throw new Error(tasks.loc('PrivateTriggerSyncFailed', syncResp.status, truncateBody(syncResp.body)));
        }
        this.log(tasks.loc('PrivateSyncTriggered', namespace, name, provider));

        if (!this.options.waitForPublish) {
            return { published: true, message: tasks.loc('PrivateSyncTriggeredVersion', version) };
        }

        if (!(await this.waitForVersion(modUrl, authHeader))) {
            throw new Error(tasks.loc('PrivateWaitTimedOut', this.options.timeoutSeconds, version));
        }
        return { published: true, message: tasks.loc('PrivateVersionAvailable', version) };
    }

    /**
     * Triggers the registry's SCM tag-sync. Wrapped in retryHttp (429 honoring a
     * capped Retry-After, 5xx, transport errors) because a repeated sync cannot
     * duplicate anything: terraform-registry-backend's rate limiter rejects a 429
     * before the handler runs, and a sync that did run skips every version that
     * already exists and guards a tag being imported concurrently
     * (services/scm_publisher.go).
     */
    private triggerSync(moduleId: string, authHeader: Record<string, string>): Promise<HttpResponse> {
        return retryHttp(
            () => this.http('POST', syncUrl(this.options.registryUrl, moduleId), authHeader),
            { log: this.log },
        );
    }

    private hasScmInputs(): boolean {
        const { scmProviderId, repositoryOwner, repositoryName } = this.options;
        return Boolean(scmProviderId && repositoryOwner && repositoryName);
    }

    /**
     * Creates and SCM-links a module that does not yet exist, returning its id.
     * Requires scmProviderId, repositoryOwner, and repositoryName; without them a
     * missing module is a hard error, exactly as before. The create call is a
     * get-or-create (idempotent) and the link call tolerates 409 (already linked),
     * so both are safe to wrap in retryHttp against a transient 5xx / lost response.
     */
    private async createAndLinkModule(authHeader: Record<string, string>): Promise<string> {
        const { registryUrl, namespace, name, provider } = this.options;
        if (!this.hasScmInputs()) {
            throw new Error(tasks.loc('PrivateModuleNotFoundNoScmInputs', namespace, name, provider));
        }
        const jsonHeaders = { ...authHeader, 'Content-Type': 'application/json' };

        // Get-or-create the module record (200 if it already exists, 201 if created).
        const createResp = await retryHttp(
            () => this.http('POST', createUrl(registryUrl), jsonHeaders, createBody(this.options)),
            { log: this.log },
        );
        if (createResp.status < 200 || createResp.status >= 300) {
            throw new Error(tasks.loc('PrivateCreateModuleFailed', createResp.status, truncateBody(createResp.body)));
        }
        const moduleId = parseJson<ModuleResponse>(createResp.body).id;
        if (!moduleId) {
            throw new Error(tasks.loc('PrivateCreateResponseNoModuleId'));
        }
        if (!isValidModuleId(moduleId)) {
            throw new Error(tasks.loc('PrivateModuleIdInvalid', moduleId));
        }
        this.log(tasks.loc('PrivateModuleRecordCreated', namespace, name, provider));

        await this.linkModule(moduleId, authHeader);
        return moduleId;
    }

    /** Links a module to its SCM repository. A 409 means it is already linked — treat as success. */
    private async linkModule(moduleId: string, authHeader: Record<string, string>): Promise<void> {
        const { registryUrl, namespace, name, provider, repositoryOwner, repositoryName } = this.options;
        const jsonHeaders = { ...authHeader, 'Content-Type': 'application/json' };
        const linkResp = await retryHttp(
            () => this.http('POST', linkUrl(registryUrl, moduleId), jsonHeaders, linkBody(this.options)),
            { log: this.log },
        );
        if (linkResp.status === 409) {
            this.log(tasks.loc('PrivateModuleAlreadyLinked', namespace, name, provider));
        } else if (linkResp.status < 200 || linkResp.status >= 300) {
            throw new Error(tasks.loc('PrivateScmLinkFailed', linkResp.status, truncateBody(linkResp.body)));
        } else {
            this.log(tasks.loc('PrivateScmLinked', namespace, name, provider, repositoryOwner, repositoryName));
        }
    }

    /**
     * Polls until the version appears or timeoutSeconds elapses. Every poll spends
     * the same rate-limited API key as the sync, so the interval backs off
     * (pollBackoffMs) and a 429's Retry-After is honored; the last wait is clamped
     * so the final poll lands on the deadline instead of overshooting it.
     */
    private async waitForVersion(modUrl: string, authHeader: Record<string, string>): Promise<boolean> {
        const deadline = this.clock.now() + this.options.timeoutSeconds * 1000;
        for (let pollIndex = 0; ; pollIndex++) {
            let resp: HttpResponse | undefined;
            // A single poll failing (e.g. a per-request timeout or transient 5xx)
            // must not abort the wait; keep polling until the wall-clock deadline.
            try {
                resp = await this.http('GET', modUrl, authHeader);
                if (resp.status >= 200 && resp.status < 300 && hasVersion(resp.body, this.options.version)) {
                    return true;
                }
            } catch (err) {
                this.log(tasks.loc('PrivatePollingFailed', err instanceof Error ? err.message : String(err)));
            }
            const remainingMs = deadline - this.clock.now();
            if (remainingMs <= 0) {
                return false;
            }
            let waitMs = pollBackoffMs(pollIndex, this.clock.random());
            if (resp?.status === 429) {
                waitMs = Math.max(waitMs, retryAfterMs(resp) ?? 0);
            }
            waitMs = Math.min(waitMs, remainingMs);
            if (resp && (resp.status < 200 || resp.status >= 300)) {
                this.log(tasks.loc('PrivatePollNonSuccess', resp.status, Math.ceil(waitMs / 1000)));
            }
            await this.clock.sleep(waitMs);
        }
    }
}
