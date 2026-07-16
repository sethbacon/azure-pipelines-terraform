import * as React from "react";
import { StateResource } from "../digest-schema";
import { TAB_MAX_RENDERED_ROWS } from "../caps";
import { formatRedactedValue } from "./redacted-value";

export interface StateInventoryProps {
    resources: StateResource[];
    selectedAddress: string | null;
    onSelect: (address: string) => void;
    /** Controlled search text — this component holds no internal state. */
    searchText: string;
    onSearchTextChange: (text: string) => void;
    maxRenderedRows?: number;
}

/**
 * Grouped (by resource type), filterable state-inventory list, with an
 * inline expandable attribute table per resource (digest spec §7.2: a
 * `StateResource` is a point-in-time inventory row — current values only, no
 * change action, no before/after). Fully controlled, same idiom as
 * `ResourceList`: no internal component state, so it renders deterministically
 * from props alone.
 */
export function StateInventory(props: StateInventoryProps): JSX.Element {
    const { resources, selectedAddress, onSelect, searchText, onSearchTextChange } = props;
    const maxRows = props.maxRenderedRows ?? TAB_MAX_RENDERED_ROWS;

    if (resources.length === 0) {
        return <div className="state-inventory-empty">No resources in state.</div>;
    }

    const needle = searchText.trim().toLowerCase();
    const filtered = needle
        ? resources.filter(
              (r) => r.address.toLowerCase().includes(needle) || r.type.toLowerCase().includes(needle)
          )
        : resources;

    const truncated = filtered.length > maxRows;
    const shown = truncated ? filtered.slice(0, maxRows) : filtered;

    const groups = new Map<string, StateResource[]>();
    for (const resource of shown) {
        const bucket = groups.get(resource.type);
        if (bucket) bucket.push(resource);
        else groups.set(resource.type, [resource]);
    }
    const groupNames = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));

    return (
        <div className="state-inventory">
            <input
                type="text"
                className="state-inventory-search"
                placeholder="Search resources by address or type…"
                value={searchText}
                onChange={(e) => onSearchTextChange(e.target.value)}
            />
            {truncated && (
                <div className="state-inventory-truncated-banner">
                    List truncated to {maxRows} of {filtered.length} matching resources.
                </div>
            )}
            {filtered.length === 0 ? (
                <div className="state-inventory-empty">No resources match "{searchText}".</div>
            ) : (
                groupNames.map((type) => (
                    <div className="state-inventory-group" key={type}>
                        <div className="state-inventory-group-heading">
                            {type} ({groups.get(type)!.length})
                        </div>
                        <ul className="state-inventory-list">
                            {groups.get(type)!.map((resource) => {
                                const expanded = resource.address === selectedAddress;
                                return (
                                    <React.Fragment key={resource.address}>
                                        <li
                                            data-testid={`state-row-${resource.address}`}
                                            className={`state-inventory-row${expanded ? " selected" : ""}`}
                                            onClick={() => onSelect(resource.address)}
                                        >
                                            <span className="state-inventory-address">{resource.address}</span>
                                            <span className="state-inventory-type">{resource.type}</span>
                                            <span className="state-inventory-provider">{resource.providerName}</span>
                                            <span className="state-inventory-mode">{resource.mode}</span>
                                            {resource.moduleAddress && (
                                                <span className="state-inventory-module">{resource.moduleAddress}</span>
                                            )}
                                        </li>
                                        {expanded && (
                                            <li className="state-inventory-detail" data-testid={`state-detail-${resource.address}`}>
                                                {resource.attributes.length === 0 ? (
                                                    <div className="state-inventory-detail-empty">
                                                        No attributes recorded for this resource.
                                                    </div>
                                                ) : (
                                                    <table className="state-inventory-attrs-table">
                                                        <thead>
                                                            <tr>
                                                                <th>Attribute</th>
                                                                <th>Value</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            {resource.attributes.map((attr) => (
                                                                <tr key={attr.name}>
                                                                    <td className="state-inventory-attr-name">{attr.name}</td>
                                                                    <td className="state-inventory-attr-value">
                                                                        {formatRedactedValue(attr.value)}
                                                                    </td>
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                )}
                                            </li>
                                        )}
                                    </React.Fragment>
                                );
                            })}
                        </ul>
                    </div>
                ))
            )}
        </div>
    );
}
