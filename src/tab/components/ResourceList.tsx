import * as React from "react";
import { PlanResource } from "../digest-schema";
import { TAB_MAX_RENDERED_ROWS } from "../caps";

const GROUP_ORDER = ["import", "replace", "delete", "create", "update", "read", "forget", "no-op"] as const;

/**
 * Headings use Terraform's own plan-summary vocabulary ("Plan: N to import, N to
 * add, N to change, N to destroy") rather than the raw
 * `resource_changes[].change.actions` values, which are an internal JSON
 * encoding users never see in CLI output.
 */
const GROUP_LABELS: Record<(typeof GROUP_ORDER)[number], string> = {
    import: "Import",
    replace: "Replace",
    delete: "Destroy",
    create: "Add",
    update: "Change",
    read: "Read",
    forget: "Forget",
    "no-op": "No changes",
};

/**
 * Import is not an action, so a resource can be imported AND changed. Only
 * import-ONLY instances (whose actions are just no-op) get their own group;
 * an import that also changes stays in its action group and is tagged instead,
 * so it is never counted or shown twice.
 */
function groupKey(resource: PlanResource): (typeof GROUP_ORDER)[number] {
    const { actions } = resource;
    if (actions.includes("replace")) return "replace";
    if (actions.includes("delete") && actions.includes("create")) return "replace";
    const noOp = actions.length === 0 || (actions.length === 1 && actions[0] === "no-op");
    if (resource.importing && noOp) return "import";
    if (actions.length === 0) return "no-op";
    const first = actions[0];
    return (GROUP_ORDER as readonly string[]).includes(first) ? (first as (typeof GROUP_ORDER)[number]) : "no-op";
}

export interface ResourceListProps {
    resources: PlanResource[];
    selectedAddress: string | null;
    onSelect: (address: string) => void;
    /** Controlled search text — this component holds no internal state. */
    searchText: string;
    onSearchTextChange: (text: string) => void;
    maxRenderedRows?: number;
}

/**
 * Grouped, filterable resource list. Fully controlled (search text + caller):
 * no internal component state, so it renders deterministically from props
 * alone and needs no DOM/hook-testing infrastructure to unit test.
 */
export function ResourceList(props: ResourceListProps): JSX.Element {
    const { resources, selectedAddress, onSelect, searchText, onSearchTextChange } = props;
    const maxRows = props.maxRenderedRows ?? TAB_MAX_RENDERED_ROWS;

    if (resources.length === 0) {
        return <div className="resource-list-empty">No resource changes in this plan.</div>;
    }

    const needle = searchText.trim().toLowerCase();
    const filtered = needle ? resources.filter((r) => r.address.toLowerCase().includes(needle)) : resources;

    const truncated = filtered.length > maxRows;
    const shown = truncated ? filtered.slice(0, maxRows) : filtered;

    const groups = new Map<(typeof GROUP_ORDER)[number], PlanResource[]>();
    for (const resource of shown) {
        const key = groupKey(resource);
        const bucket = groups.get(key);
        if (bucket) bucket.push(resource);
        else groups.set(key, [resource]);
    }

    return (
        <div className="resource-list">
            <input
                type="text"
                className="resource-list-search"
                placeholder="Search resources by address…"
                value={searchText}
                onChange={(e) => onSearchTextChange(e.target.value)}
            />
            {truncated && (
                <div className="resource-list-truncated-banner">
                    List truncated to {maxRows} of {filtered.length} matching resources.
                </div>
            )}
            {filtered.length === 0 ? (
                <div className="resource-list-empty">No resources match "{searchText}".</div>
            ) : (
                GROUP_ORDER.filter((g) => groups.has(g)).map((group) => (
                    <div className="resource-group" key={group}>
                        <div className="resource-group-heading">
                            {GROUP_LABELS[group]} ({groups.get(group)!.length})
                        </div>
                        <ul className="resource-group-list">
                            {groups.get(group)!.map((resource) => (
                                <li
                                    key={resource.address}
                                    data-testid={`resource-row-${resource.address}`}
                                    className={`resource-row${resource.address === selectedAddress ? " selected" : ""}`}
                                    onClick={() => onSelect(resource.address)}
                                >
                                    <span className="resource-row-address">{resource.address}</span>
                                    <span className="resource-row-type">{resource.type}</span>
                                    {resource.importing && group !== "import" && (
                                        <span className="badge badge-import">Import</span>
                                    )}
                                    {resource.actionReason && (
                                        <span className="resource-row-reason">{resource.actionReason}</span>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </div>
                ))
            )}
        </div>
    );
}
