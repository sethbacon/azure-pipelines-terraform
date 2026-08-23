/**
 * The migration notice that Markdown2Html and PublishKbArticle emit on every
 * run while they move out of this extension into their own
 * (azure-pipelines-release-docs).
 *
 * WHY A RUNTIME WARNING AND NOT JUST A README LINE. A task GUID cannot be
 * reused across two separately-published extensions, so the replacements
 * arrive under a new name AND a new id. That makes this a rename, not an
 * in-place move: an existing `Markdown2Html@1` reference keeps resolving to
 * THIS task indefinitely, and nothing in the product tells the pipeline author
 * that a successor exists. Absent a signal on the run itself, the migration
 * completes only for people who happen to read a repository README.
 *
 * Kept byte-identical across both tasks' `src/` directories and guarded by
 * scripts/check-shared-modules.js: the destination extension, the replacement
 * names and the URL are one answer to one question, and a correction to any of
 * them must not be applied to one task and silently missed in the other.
 */

/** Where the replacement extension and the migration's status are documented. */
export const MIGRATION_URL = 'https://github.com/sethbacon/azure-pipelines-release-docs';

/**
 * Returned rather than logged so it is testable without an agent, and single
 * line by construction: `tasks.warning` writes a line-based
 * `##vso[task.logissue]` command that an embedded newline would split in two.
 */
export function migrationNotice(currentTaskName: string, replacementTaskName: string): string {
    return (
        `DEPRECATION: ${currentTaskName} is moving out of this extension and will be republished as ` +
        `${replacementTaskName} in the "Pipeline Tasks for Release & Documentation" extension. ` +
        'This build is unaffected: a task reference is never redirected automatically, so this ' +
        `pipeline keeps using ${currentTaskName} until its YAML is changed. ` +
        `Migration status, availability and the cutover window: ${MIGRATION_URL}`
    );
}
