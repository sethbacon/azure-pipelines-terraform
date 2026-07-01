/**
 * Dry-run reporting.
 *
 * Produces a human-readable plan of what a publish would do, WITHOUT performing
 * any write to ServiceNow (no POST/PATCH, no category auto-create, no manifest
 * or legacy JSON file writes). Read-only lookups (source-key resolution, fetching
 * the existing article) are still performed so the plan can report the real target
 * sys_id and current state.
 */

export type PlannedAction = 'create' | 'update' | 'workflow-only';

export interface DryRunPlan {
    action: PlannedAction;
    instance: string;
    kbId?: string;
    /** sys_id of the article that would be updated; undefined for a create. */
    articleId?: string;
    /** Current workflow state of the existing article (update paths only). */
    currentWorkflowState?: string;
    title?: string;
    author?: string;
    category?: string;
    subcategory?: string;
    /** Target workflow state after the (skipped) write. */
    workflowState: string;
    sourceKey?: string;
    /** Byte length of the HTML body that would be written, if any. */
    contentBytes?: number;
    /** Whether the resolved source key matched an existing article. */
    sourceKeyMatched?: boolean;
}

/**
 * Format a DryRunPlan as a readable multi-line report for the pipeline log.
 * Pure function — no I/O — so it is trivially testable.
 */
export function formatDryRunReport(plan: DryRunPlan): string {
    const lines: string[] = [];
    lines.push('========================================');
    lines.push('  DRY RUN — no changes will be made');
    lines.push('========================================');

    const actionLabel: Record<PlannedAction, string> = {
        'create': 'CREATE new article',
        'update': 'UPDATE existing article',
        'workflow-only': 'CHANGE workflow state only',
    };
    lines.push(`Action:            ${actionLabel[plan.action]}`);
    lines.push(`Instance:          ${plan.instance}`);

    if (plan.kbId) {
        lines.push(`Knowledge base:    ${plan.kbId}`);
    }
    if (plan.action === 'create') {
        lines.push('Target article:    (new)');
    } else {
        lines.push(`Target article:    ${plan.articleId ?? '(unknown)'}`);
        if (plan.currentWorkflowState) {
            lines.push(`Current state:     ${plan.currentWorkflowState}`);
        }
    }

    if (plan.sourceKey) {
        const matched = plan.sourceKeyMatched
            ? `matched existing article ${plan.articleId ?? ''}`.trim()
            : 'no existing match (would create)';
        lines.push(`Source key:        ${plan.sourceKey} (${matched})`);
    }

    if (plan.title !== undefined) {
        lines.push(`Title:             ${plan.title}`);
    }
    if (plan.author !== undefined) {
        lines.push(`Author:            ${plan.author}`);
    }

    if (plan.category) {
        const sub = plan.subcategory ? ` > ${plan.subcategory}` : '';
        lines.push(`Category:          ${plan.category}${sub}`);
        lines.push('                   (categories/subcategories would be auto-created if missing — skipped in dry run)');
    }

    lines.push(`Workflow state:    -> ${plan.workflowState}`);

    if (plan.contentBytes !== undefined) {
        lines.push(`Body content:      ${plan.contentBytes} bytes of HTML`);
    } else {
        lines.push('Body content:      (none — no htmlFile provided)');
    }

    lines.push('----------------------------------------');
    lines.push('No write was performed. Re-run with dryRun disabled to apply.');
    lines.push('========================================');

    return lines.join('\n');
}
