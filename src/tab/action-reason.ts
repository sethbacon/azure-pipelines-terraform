/**
 * Terraform's `action_reason` codes (from `terraform show -json`) in the
 * wording its own CLI output uses, so a reviewer reads "no longer in
 * configuration" rather than `delete_because_no_resource_config`. A code this
 * table doesn't know is shown as-is.
 */
const REASONS: Record<string, string> = {
    replace_because_tainted: "tainted, so must be replaced",
    replace_because_cannot_update: "must be replaced",
    replace_by_request: "replaced as requested (-replace)",
    replace_by_triggers: "replaced by replace_triggered_by",
    delete_because_no_resource_config: "no longer in configuration",
    delete_because_no_module: "its module is no longer in configuration",
    delete_because_wrong_repetition: "count or for_each changed for this resource",
    delete_because_count_index: "count index is out of range",
    delete_because_each_key: "for_each key is no longer present",
    delete_because_no_move_target: "moved to an address that doesn't exist",
    read_because_config_unknown: "read during apply: its configuration depends on unknown values",
    read_because_dependency_pending: "read during apply: it depends on pending changes",
    read_because_check_nested: "read during apply: a check block refers to it",
};

/** Human wording for an `action_reason` code; unknown codes pass through unchanged. */
export function describeActionReason(reason: string): string {
    return Object.prototype.hasOwnProperty.call(REASONS, reason) ? REASONS[reason] : reason;
}
