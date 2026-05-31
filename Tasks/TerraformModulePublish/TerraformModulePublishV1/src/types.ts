/** Supported registry platforms. */
export type RegistryType = 'hcp' | 'private';

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
