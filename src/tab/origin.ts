/**
 * Where in the run a digest attachment came from, read from the build
 * timeline rather than from the digest itself.
 *
 * A digest's own `meta.stage` / `meta.job` are self-reported, and any step in
 * the pipeline can publish an attachment of a digest's type with
 * `##vso[task.addattachment]`. The attachment URL, though, is built by the
 * server and names the timeline record (the step) that published it, and the
 * timeline is server data: so the stage, job, step, and whether that step is
 * the Terraform task all come from Azure DevOps, not from the attachment.
 */

/** TerraformTaskV5's task id (task.json `id`, and the manifest's `supportsTasks`). */
export const TERRAFORM_TASK_ID = "981e87cd-b686-4a9e-b09e-b4afdedf126b";

/** The parts of a build timeline record this module reads. */
export interface TimelineRecordLike {
    id: string;
    parentId?: string | null;
    type?: string;
    name?: string;
    order?: number;
    task?: { id?: string } | null;
}

export interface AttachmentOrigin {
    stage?: string;
    job?: string;
    /** The step (task) that published the attachment. */
    step: string;
    /** Whether that step is the Terraform task; a script step can publish the same attachment type. */
    fromTerraformTask: boolean;
    /** The record's `order` at each level from the root down, for sorting by position in the run. */
    orderPath: number[];
    /** The step's log in the web UI, when the attachment URL gives the collection and project. */
    logUrl?: string;
}

/** Looks up the origin of an attachment by its URL. */
export type OriginLookup = (href: string) => AttachmentOrigin | undefined;

const GUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const ATTACHMENT_PATH = new RegExp(`^(.*)/_apis/build/builds/\\d+/(${GUID})/(${GUID})/attachments/`);

/**
 * The collection/project base URL and the publishing record's id, from an
 * attachment URL of the form
 * `<base>/_apis/build/builds/{buildId}/{timelineId}/{recordId}/attachments/{type}/{name}`.
 * Null for anything else, including a non-http(s) URL.
 */
export function parseAttachmentHref(href: string): { base: string; recordId: string } | null {
    let url: URL;
    try {
        url = new URL(href);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const match = ATTACHMENT_PATH.exec(url.pathname);
    if (!match) return null;
    return { base: `${url.origin}${match[1]}`, recordId: match[3].toLowerCase() };
}

/**
 * Builds the lookup from the build's timeline records. An attachment whose URL
 * doesn't parse, or whose record isn't in the timeline, has no origin.
 */
export function buildOriginLookup(records: TimelineRecordLike[], buildId: number): OriginLookup {
    const byId = new Map<string, TimelineRecordLike>();
    for (const record of records) {
        if (record && typeof record.id === "string") byId.set(record.id.toLowerCase(), record);
    }

    return (href: string): AttachmentOrigin | undefined => {
        const parsed = parseAttachmentHref(href);
        if (!parsed) return undefined;
        const record = byId.get(parsed.recordId);
        if (!record) return undefined;

        // Walk up to the root; the guard stops a malformed (cyclic) parent chain.
        const chain: TimelineRecordLike[] = [];
        const seen = new Set<string>();
        for (let r: TimelineRecordLike | undefined = record; r && !seen.has(r.id.toLowerCase()); ) {
            seen.add(r.id.toLowerCase());
            chain.unshift(r);
            r = r.parentId ? byId.get(r.parentId.toLowerCase()) : undefined;
        }

        const nearest = (type: string): TimelineRecordLike | undefined => chain.filter((r) => r.type === type).pop();
        const stage = nearest("Stage");
        const job = nearest("Job");
        const logUrl = job
            ? `${parsed.base}/_build/results?buildId=${buildId}&view=logs&j=${encodeURIComponent(job.id)}&t=${encodeURIComponent(record.id)}`
            : undefined;

        return {
            stage: stage?.name,
            job: job?.name,
            step: record.name ?? "",
            fromTerraformTask: (record.task?.id ?? "").toLowerCase() === TERRAFORM_TASK_ID,
            orderPath: chain.map((r) => (typeof r.order === "number" ? r.order : 0)),
            logUrl,
        };
    };
}

/** Run order: by position at each level of the timeline; items without an origin sort last. */
export function compareOrigins(a: AttachmentOrigin | undefined, b: AttachmentOrigin | undefined): number {
    if (!a || !b) return a ? -1 : b ? 1 : 0;
    const length = Math.max(a.orderPath.length, b.orderPath.length);
    for (let i = 0; i < length; i++) {
        const diff = (a.orderPath[i] ?? -1) - (b.orderPath[i] ?? -1);
        if (diff !== 0) return diff;
    }
    return 0;
}

/** "Stage › Job › Step", skipping the levels this origin doesn't have. */
export function formatOrigin(origin: AttachmentOrigin): string {
    return [origin.stage, origin.job, origin.step].filter((part): part is string => !!part).join(" › ");
}
