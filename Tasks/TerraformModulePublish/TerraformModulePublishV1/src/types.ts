/** Supported registry platforms. */
export type RegistryType = 'hcp' | 'private';

/**
 * How a module's versions get into HCP Terraform. These mirror HCP's own
 * `publishing-mechanism` values (`branch`, `git_tag`, `non_vcs`).
 *  - vcsBranch: VCS-connected, branch-based; versions are created through the API.
 *  - vcsTag:    VCS-connected, tag-based; versions come from git tags, never the API.
 *  - upload:    no VCS connection; versions are created through the API and the
 *               module archive is uploaded to the version's upload link.
 */
export type HcpModuleMode = 'vcsBranch' | 'vcsTag' | 'upload';

/** The `hcpPublishMode` input: a concrete mode, or `auto` to infer it. */
export type HcpPublishMode = 'auto' | HcpModuleMode;

/** Lives here (not in hcp-publisher.ts) so index.ts can validate the input without the publisher module. */
export const HCP_PUBLISH_MODES: readonly HcpPublishMode[] = ['auto', 'vcsBranch', 'vcsTag', 'upload'];

/** Identifies a module version in a registry. */
export interface ModuleCoordinates {
    namespace: string;
    name: string;
    provider: string;
    version: string;
}

/** Outcome of a publish operation. */
export interface PublishResult {
    /** True when the version was newly published; false when it already existed. */
    published: boolean;
    /** Human-readable status message. */
    message: string;
}

/** A platform-specific module publisher. */
export interface RegistryPublisher {
    publish(): Promise<PublishResult>;
}
