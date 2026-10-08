import { HttpClient, parseJson, delay, retryHttp, truncateBody } from './http';
import { createModuleArchive } from './archive';
import { HcpExistingVersion, HcpModuleMode, HcpPublishMode, ModuleCoordinates, PublishResult, RegistryPublisher } from './types';
import { extractUrlTokenSecrets, scrubSecretsFromMessage } from '@4cloudguru/pipeline-task-core';
import tasks = require('azure-pipelines-task-lib/task');

/** Inputs for publishing to HCP Terraform / Terraform Enterprise. */
export interface HcpOptions extends ModuleCoordinates {
    address: string;
    token: string;
    publishMode: HcpPublishMode;
    vcsRepoIdentifier: string;
    vcsBranch: string;
    vcsOauthTokenId: string;
    commitSha: string;
    /** Directory archived and uploaded for an `upload`-mode module. */
    moduleDirectory: string;
    /** Paths under moduleDirectory left out of the archive, on top of `.git` and `.terraform`. */
    moduleExclude?: string[];
    /** `fail` stops the task when the version is already ready instead of skipping it. */
    existingVersion?: HcpExistingVersion;
    /** Reads the module and reports what a publish would do, without creating, deleting or uploading. */
    checkOnly?: boolean;
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
            'vcs-repo'?: { branch?: string | null } | null;
        };
    };
}

interface HcpVersionResponse {
    data?: {
        links?: { upload?: string };
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

/** Create-module endpoint for a module with no VCS connection. */
export function modulesUrl(address: string, namespace: string): string {
    return `${address.replace(/\/+$/, '')}/api/v2/organizations/${encodeURIComponent(namespace)}/registry-modules`;
}

/**
 * HCP stores `v1.0.0` as `1.0.0`, so a status lookup by the raw input would
 * never match a `v`-prefixed version.
 */
function normalizeVersion(version: string): string {
    return version.replace(/^v/i, '');
}

/**
 * `Array.isArray` rather than a nullish fallback: a module with a single
 * version has been seen to surface `version-statuses` as a bare object.
 */
function versionStatuses(parsed: HcpModuleResponse): VersionStatus[] {
    const statuses = parsed.data?.attributes?.['version-statuses'];
    return Array.isArray(statuses) ? statuses : [];
}

export function versionStatus(body: string, version: string): string | undefined {
    const wanted = normalizeVersion(version);
    return versionStatuses(parseJson<HcpModuleResponse>(body)).find((s) => normalizeVersion(s.version) === wanted)
        ?.status;
}

/**
 * Derives the publishing mode of an existing module from its documented
 * attributes: no `vcs-repo` means no VCS; a non-empty `vcs-repo.branch` means
 * branch-based; otherwise tag-based. Checked against HCP's own
 * `publishing-mechanism` on every module of a real organisation with no
 * disagreement.
 */
export function moduleMode(body: string): HcpModuleMode {
    const repo = parseJson<HcpModuleResponse>(body).data?.attributes?.['vcs-repo'];
    if (!repo) {
        return 'upload';
    }
    return repo.branch ? 'vcsBranch' : 'vcsTag';
}

/** `reg_ingress_failed` and any other `*_failed` status is terminal: HCP will not retry it. */
function isFailedStatus(status: string): boolean {
    return /_failed$/.test(status);
}

/**
 * Body for creating a VCS-connected module. A branch-based module sends `branch`;
 * a tag-based one omits it, which is how HCP tells the two apart.
 */
export function vcsModuleBody(o: HcpOptions, tagBased = false): string {
    return JSON.stringify({
        data: {
            type: 'registry-modules',
            attributes: {
                'vcs-repo': {
                    identifier: o.vcsRepoIdentifier,
                    'display-identifier': o.vcsRepoIdentifier,
                    'oauth-token-id': o.vcsOauthTokenId,
                    ...(tagBased ? {} : { branch: o.vcsBranch }),
                },
                'no-code': false,
            },
        },
    });
}

/**
 * Body for creating a module with no VCS connection. `namespace` is deliberately
 * not sent: HCP rejects it (422) for a private module, where the organisation is
 * already in the URL.
 */
export function noVcsModuleBody(o: HcpModuleRef): string {
    return JSON.stringify({
        data: {
            type: 'registry-modules',
            attributes: {
                name: o.name,
                provider: o.provider,
                'registry-name': 'private',
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

/** The `links.upload` URL from a create-version response, if HCP returned one. */
function uploadLink(body: string): string | undefined {
    try {
        const link = (JSON.parse(body) as HcpVersionResponse).data?.links?.upload;
        return typeof link === 'string' && link ? link : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Publishes a module version to HCP Terraform through whichever path the module
 * uses: it finds (or creates) the module, then either creates the version and
 * uploads the module archive (no-VCS), creates the version from a commit
 * (VCS branch), or observes the version a pushed tag produces (VCS tag).
 */
export class HcpPublisher implements RegistryPublisher {
    constructor(
        private readonly http: HttpClient,
        private readonly options: HcpOptions,
        private readonly log: (message: string) => void = console.log,
        private readonly buildArchive: (directory: string, exclude?: string[]) => Promise<Uint8Array> = createModuleArchive,
    ) { }

    private build(): Promise<Uint8Array> {
        return this.buildArchive(this.options.moduleDirectory, this.options.moduleExclude);
    }

    async publish(): Promise<PublishResult> {
        const o = this.options;
        const headers = {
            Authorization: `Bearer ${o.token}`,
            'Content-Type': 'application/vnd.api+json',
        };

        let mode: HcpModuleMode | undefined;
        let status: string | undefined;
        let archive: Uint8Array | undefined;

        const check = await retryHttp(() => this.http('GET', moduleUrl(o), headers), { log: this.log });
        if (check.status >= 200 && check.status < 300) {
            mode = moduleMode(check.body);
            if (o.publishMode !== 'auto' && o.publishMode !== mode) {
                throw new Error(tasks.loc('HcpPublishModeMismatch', o.publishMode, o.namespace, o.name, o.provider, mode));
            }
            status = versionStatus(check.body, o.version);
            if (status === 'ok') {
                return this.versionAlreadyReady();
            }
        } else if (check.status === 404) {
            if (o.checkOnly) {
                await this.assertRegistryReadable(headers);
            }
            mode = this.resolveCreateMode();
            if (mode === 'upload') {
                // Built BEFORE anything is created, so a bad moduleDirectory fails the
                // task without leaving an empty module behind.
                archive = await this.build();
            }
            if (o.checkOnly) {
                return { published: false, message: tasks.loc('HcpCheckOnlyModuleMissing', o.namespace, o.name, o.provider, mode) };
            }
            await this.createModule(mode, headers);
        } else {
            if (o.checkOnly) {
                throw new Error(tasks.loc('HcpCheckOnlyFailed', check.status));
            }
            this.log(tasks.loc('HcpCheckModuleFailed', check.status));
            mode = o.publishMode === 'auto' ? undefined : o.publishMode;
        }

        if (o.checkOnly) {
            if (mode === 'upload' && !archive) {
                archive = await this.build();
            }
            return { published: false, message: tasks.loc('HcpCheckOnlyVersionAbsent', o.version, mode) };
        }
        if (mode === 'vcsTag') {
            return this.observeTagVersion(headers);
        }
        if (mode === 'upload' && !archive) {
            archive = await this.build();
        }

        const created = await this.createVersion(headers, mode, status);
        if (created.done) {
            return created.done;
        }
        if (created.created) {
            if (mode === 'vcsBranch') {
                // HCP also returns an upload link for a branch module, but its version is
                // ingested from the commit; archiving moduleDirectory would be pointless.
                this.log(tasks.loc('HcpNoUploadLinkWaiting', o.version));
            } else if (created.uploadUrl) {
                await this.uploadArchive(created.uploadUrl, archive ?? (await this.build()));
            } else if (mode === 'upload') {
                throw new Error(tasks.loc('HcpNoUploadLink', o.version));
            } else {
                this.log(tasks.loc('HcpNoUploadLinkWaiting', o.version));
            }
        }

        if (o.waitForPublish) {
            await this.waitForOk(headers);
        }
        return { published: true, message: tasks.loc('HcpVersionPublished', o.version) };
    }

    /** HCP answers 404 for a wrong organisation or a token without access, so a module 404 alone proves nothing. */
    private async assertRegistryReadable(headers: Record<string, string>): Promise<void> {
        const o = this.options;
        const url = `${modulesUrl(o.address, o.namespace)}?page%5Bsize%5D=1`;
        const res = await retryHttp(() => this.http('GET', url, headers), { log: this.log });
        if (res.status < 200 || res.status >= 300) {
            throw new Error(tasks.loc('HcpCheckOnlyRegistryUnreadable', o.namespace, res.status));
        }
    }

    /** A version that is already ready is skipped, or a failure when the pipeline asked for one. */
    private versionAlreadyReady(): PublishResult {
        const o = this.options;
        if (o.existingVersion === 'fail') {
            throw new Error(tasks.loc('HcpVersionAlreadyReadyFail', o.version));
        }
        return { published: false, message: tasks.loc('HcpVersionAlreadyReady', o.version) };
    }

    /** Decides which kind of module to create when it does not exist yet. */
    private resolveCreateMode(): HcpModuleMode {
        const o = this.options;
        const hasRepo = !!o.vcsRepoIdentifier;
        const hasOauth = !!o.vcsOauthTokenId;
        switch (o.publishMode) {
            case 'upload':
                if (hasRepo || hasOauth) {
                    this.log(tasks.loc('HcpVcsInputsIgnored'));
                }
                return 'upload';
            case 'vcsBranch':
            case 'vcsTag':
                if (!hasRepo || !hasOauth) {
                    throw new Error(tasks.loc('HcpVcsModeNeedsInputs', o.publishMode));
                }
                if (o.publishMode === 'vcsBranch' && !o.vcsBranch) {
                    throw new Error(tasks.loc('HcpVcsBranchRequired'));
                }
                return o.publishMode;
            default:
                if (hasRepo && hasOauth) {
                    return o.vcsBranch ? 'vcsBranch' : 'vcsTag';
                }
                if (!hasRepo && !hasOauth) {
                    return 'upload';
                }
                throw new Error(tasks.loc('HcpVcsInputsIncomplete', hasRepo ? 'vcsOauthTokenId' : 'vcsRepoIdentifier'));
        }
    }

    // HCP names a VCS module from its repo (terraform-<provider>-<name>) and ignores name/provider,
    // so a mismatch would silently create an orphan module and a webhook (verified live).
    private assertRepoNamesModule(): void {
        const o = this.options;
        const repoName = o.vcsRepoIdentifier.split('/').pop() ?? '';
        const match = /^terraform-([^-]+)-(.+)$/i.exec(repoName);
        if (!match) {
            return;
        }
        const [, provider, name] = match;
        if (provider.toLowerCase() !== o.provider.toLowerCase() || name.toLowerCase() !== o.name.toLowerCase()) {
            throw new Error(tasks.loc('HcpVcsRepoNameMismatch', o.vcsRepoIdentifier, name, provider, o.name, o.provider));
        }
    }

    private async createModule(mode: HcpModuleMode, headers: Record<string, string>): Promise<void> {
        const o = this.options;
        let url: string;
        let body: string;
        if (mode === 'upload') {
            this.log(tasks.loc('HcpCreatingNoVcsModule', o.namespace, o.name, o.provider));
            url = modulesUrl(o.address, o.namespace);
            body = noVcsModuleBody(o);
        } else {
            this.assertRepoNamesModule();
            this.log(tasks.loc('HcpCreatingVcsModule', o.namespace, o.name, o.provider));
            url = vcsUrl(o.address, o.namespace);
            body = vcsModuleBody(o, mode === 'vcsTag');
        }
        // A module create is keyed by namespace/name/provider, so a retried POST
        // after a transient 5xx cannot create a duplicate: HCP answers 422
        // "Provider must be unique", which is handled below.
        const created = await retryHttp(() => this.http('POST', url, headers, body), { log: this.log });
        if (created.status >= 200 && created.status < 300) {
            return;
        }
        // The create may have succeeded on an earlier attempt whose response was lost, or
        // a concurrent run may have created it. Converge on the module that exists, as
        // long as it is the kind this run intended; otherwise report the create's own error.
        const recheck = await retryHttp(() => this.http('GET', moduleUrl(o), headers), { log: this.log });
        if (recheck.status >= 200 && recheck.status < 300 && moduleMode(recheck.body) === mode) {
            this.log(tasks.loc('HcpModuleCreatedConcurrently', created.status));
            return;
        }
        throw new Error(tasks.loc('HcpCreateModuleFailed', created.status, truncateBody(created.body)));
    }

    /**
     * A tag-based module takes its versions from git tags, so there is nothing to
     * create: observe the version (optionally waiting for the tag import) and report.
     */
    private async observeTagVersion(headers: Record<string, string>): Promise<PublishResult> {
        const o = this.options;
        this.log(tasks.loc('HcpTagBasedObserveOnly', o.namespace, o.name, o.provider, o.version));
        if (!o.waitForPublish) {
            return { published: false, message: tasks.loc('HcpTagVersionNotPresent', o.version) };
        }
        await this.waitForOk(headers);
        return { published: true, message: tasks.loc('HcpVersionPublished', o.version) };
    }

    private async createVersion(
        headers: Record<string, string>,
        mode: HcpModuleMode | undefined,
        existingStatus: string | undefined,
    ): Promise<{ created: boolean; uploadUrl?: string; done?: PublishResult }> {
        const o = this.options;
        let status = existingStatus;

        // A failed version can never become ok, and a pending no-VCS version has no
        // content (an upload moves it on within a second), so both would otherwise wedge
        // every pipeline retry behind "version already exists". Delete and recreate.
        if (status && (isFailedStatus(status) || (status === 'pending' && mode === 'upload'))) {
            this.log(tasks.loc('HcpRecreatingVersion', o.version, status));
            await this.deleteVersion(headers);
            status = undefined;
        }
        if (status) {
            this.log(tasks.loc('HcpVersionInProgress', o.version, status));
            return { created: false };
        }

        const resp = await retryHttp(
            () => this.http('POST', versionsUrl(o), headers, versionBody(o.version, o.commitSha)),
            { log: this.log },
        );
        if (resp.status === 422) {
            // 422 covers "already taken" but also a malformed version, so it is never
            // assumed to mean "exists": look at the module to see whether it does.
            const recheck = await retryHttp(() => this.http('GET', moduleUrl(o), headers), { log: this.log });
            const current =
                recheck.status >= 200 && recheck.status < 300 ? versionStatus(recheck.body, o.version) : undefined;
            if (current === 'ok') {
                return { created: false, done: this.versionAlreadyReady() };
            }
            if (current) {
                this.log(tasks.loc('HcpVersionAlreadyExists', o.version));
                return { created: false };
            }
            throw new Error(tasks.loc('HcpCreateVersionFailed', resp.status, truncateBody(resp.body)));
        }
        if (resp.status < 200 || resp.status >= 300) {
            throw new Error(tasks.loc('HcpCreateVersionFailed', resp.status, truncateBody(resp.body)));
        }
        this.log(tasks.loc('HcpVersionCreated', o.version));
        return { created: true, uploadUrl: uploadLink(resp.body) };
    }

    private async deleteVersion(headers: Record<string, string>): Promise<void> {
        const o = this.options;
        // The delete endpoint takes the version directly after the provider; there is no
        // `/versions/` segment (that path 404s, which would read as "already gone").
        const url = `${moduleUrl(o)}/${encodeURIComponent(normalizeVersion(o.version))}`;
        const resp = await this.http('DELETE', url, headers);
        if ((resp.status < 200 || resp.status >= 300) && resp.status !== 404) {
            throw new Error(tasks.loc('HcpDeleteVersionFailed', resp.status, truncateBody(resp.body)));
        }
    }

    /**
     * Uploads the archive to the version's upload link. The link is a capability URL
     * (its path alone authorises the write), so it is registered with the log masker
     * before any request, and no HCP bearer token is sent to it.
     */
    private async uploadArchive(link: string, archive: Uint8Array): Promise<void> {
        let parsed: URL;
        try {
            parsed = new URL(link);
        } catch {
            throw new Error(tasks.loc('HcpUploadUrlInvalid'));
        }
        if (parsed.protocol !== 'https:') {
            throw new Error(tasks.loc('HcpUploadUrlInvalid'));
        }
        const secrets = [link, ...extractUrlTokenSecrets(link)];
        for (const secret of secrets) {
            tasks.setSecret(secret);
        }
        const scrub = (message: string): string => scrubSecretsFromMessage(message, link, secrets);

        this.log(tasks.loc('HcpUploadingArchive', archive.byteLength, this.options.version));
        let resp;
        try {
            // Re-PUTting the same upload link is safe (it overwrites), so the transient
            // retry applies.
            resp = await retryHttp(
                () => this.http('PUT', link, { 'Content-Type': 'application/octet-stream' }, archive),
                { log: (message) => this.log(scrub(message)) },
            );
        } catch (err) {
            throw new Error(tasks.loc('HcpUploadRequestFailed', scrub(err instanceof Error ? err.message : String(err))));
        }
        if (resp.status < 200 || resp.status >= 300) {
            throw new Error(tasks.loc('HcpUploadFailed', resp.status, scrub(truncateBody(resp.body))));
        }
    }

    /** Polls until the version is `ok`; throws if it fails ingestion or the deadline passes. */
    private async waitForOk(headers: Record<string, string>): Promise<void> {
        const o = this.options;
        const deadline = Date.now() + o.timeoutSeconds * 1000;
        for (; ;) {
            let status: string | undefined;
            // A single poll failing (e.g. a per-request timeout or transient 5xx)
            // must not abort the wait; keep polling until the wall-clock deadline.
            try {
                const resp = await this.http('GET', moduleUrl(o), headers);
                if (resp.status >= 200 && resp.status < 300) {
                    status = versionStatus(resp.body, o.version);
                }
            } catch (err) {
                this.log(tasks.loc('HcpPollingFailed', err instanceof Error ? err.message : String(err)));
            }
            if (status === 'ok') {
                return;
            }
            // Outside the try: this must propagate rather than be swallowed as a poll failure.
            if (status && isFailedStatus(status)) {
                throw new Error(tasks.loc('HcpVersionIngestFailed', o.version, status));
            }
            if (Date.now() >= deadline) {
                throw new Error(tasks.loc('HcpWaitTimedOut', o.timeoutSeconds, o.version));
            }
            await delay(3000);
        }
    }
}
