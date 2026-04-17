/**
 * Terraform Plan Tab — Azure DevOps Pipeline Build Results Tab
 *
 * Displays terraform plan output published as pipeline attachments.
 * Uses the standard Azure DevOps Extension SDK pattern:
 *   SDK.init() → SDK.ready() → config.onBuildChanged() → BuildRestClient.getAttachments()
 *
 * Architecture informed by studying:
 *   - jason-johnson/azure-pipelines-tasks-terraform (MIT, Copyright 2021 Charles Zipp, 2023 Jason Johnson)
 *   - JaydenMaalouf/azure-pipelines-terraform-output (MIT, Copyright Microsoft Corporation)
 * See THIRD_PARTY_NOTICES.md for full attribution.
 * No code was copied from either project. All implementation below is original.
 */

import * as React from "react";
import * as ReactDOM from "react-dom";
import * as SDK from "azure-devops-extension-sdk";
import { Build, BuildRestClient } from "azure-devops-extension-api/Build";
import { getClient } from "azure-devops-extension-api";
import "./tabContent.css";

/** Attachment type matching jason-johnson convention for migration compatibility */
const ATTACHMENT_TYPE = "terraform-plan-results";

/** Maximum attachment size (bytes) to render inline. Larger content gets a download link. */
const MAX_RENDER_SIZE = 2 * 1024 * 1024; // 2 MB

interface PlanAttachment {
    name: string;
    content: string;
}

interface TerraformPlanTabState {
    plans: PlanAttachment[];
    selectedIndex: number;
    loading: boolean;
    error: string | null;
}

/**
 * SGR code → CSS class mapping for the subset of ANSI codes terraform emits.
 */
const SGR_CLASS_MAP: Record<string, string> = {
    "1": "ansi-bold",
    "30": "ansi-black",
    "31": "ansi-red",
    "32": "ansi-green",
    "33": "ansi-yellow",
    "34": "ansi-blue",
    "35": "ansi-magenta",
    "36": "ansi-cyan",
    "37": "ansi-white",
    "90": "ansi-grey",
};

/**
 * Convert ANSI SGR escape codes (ECMA-48 standard) to HTML spans with CSS classes.
 *
 * Uses a state-machine approach that tracks open spans to guarantee balanced tags.
 * Multi-code sequences (e.g. \x1b[1;31m) are fully handled — each recognised code
 * opens its own span, and reset (code 0) closes all currently open spans.
 */
function ansiToHtml(text: string): string {
    const parts: string[] = [];
    let openSpans = 0;

    // Match SGR sequences (\x1b[...m) or runs of plain text between them.
    // Also matches any other CSI sequences so they can be stripped.
    const TOKEN_RE = /\x1b\[([0-9;]*)m|\x1b\[[0-9;]*[a-zA-Z]/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = TOKEN_RE.exec(text)) !== null) {
        // Emit plain text before this match (HTML-escaped)
        if (match.index > lastIndex) {
            parts.push(escapeHtml(text.slice(lastIndex, match.index)));
        }
        lastIndex = TOKEN_RE.lastIndex;

        // Non-SGR CSI sequence (no capture group) — strip it
        if (match[1] === undefined) continue;

        const codes = match[1].split(";");
        for (const code of codes) {
            if (code === "0" || code === "") {
                // Reset: close all open spans
                while (openSpans > 0) {
                    parts.push("</span>");
                    openSpans--;
                }
            } else {
                const className = SGR_CLASS_MAP[code];
                if (className) {
                    parts.push(`<span class="${className}">`);
                    openSpans++;
                }
            }
        }
    }

    // Emit any trailing plain text
    if (lastIndex < text.length) {
        parts.push(escapeHtml(text.slice(lastIndex)));
    }

    // Close any spans left open at end-of-input
    while (openSpans > 0) {
        parts.push("</span>");
        openSpans--;
    }

    return parts.join("");
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

class TerraformPlanTab extends React.Component<{}, TerraformPlanTabState> {
    constructor(props: {}) {
        super(props);
        this.state = {
            plans: [],
            selectedIndex: 0,
            loading: true,
            error: null,
        };
    }

    public render(): JSX.Element {
        const { plans, selectedIndex, loading, error } = this.state;

        if (loading) {
            return <div className="plan-loading">Loading terraform plans...</div>;
        }

        if (error) {
            return <div className="plan-empty">Error: {error}</div>;
        }

        if (plans.length === 0) {
            return (
                <div className="plan-empty">
                    No terraform plans have been published for this pipeline run.
                    <br /><br />
                    Set <code>publishPlanResults</code> on the terraform plan task to publish plan output here.
                </div>
            );
        }

        const selectedPlan = plans[selectedIndex];

        return (
            <div className="terraform-container">
                {plans.length > 1 && (
                    <div className="plan-header">
                        <label htmlFor="plan-select">Plan:</label>
                        <select
                            id="plan-select"
                            className="plan-select"
                            value={selectedIndex}
                            onChange={this.onPlanSelect}
                        >
                            {plans.map((plan, i) => (
                                <option key={plan.name} value={i}>{plan.name}</option>
                            ))}
                        </select>
                    </div>
                )}
                {plans.length === 1 && (
                    <div className="plan-header">
                        <strong>{selectedPlan.name}</strong>
                    </div>
                )}
                {selectedPlan.content.length > MAX_RENDER_SIZE ? (
                    <div className="plan-oversize">
                        <p>
                            Plan output is too large to render inline
                            ({(selectedPlan.content.length / (1024 * 1024)).toFixed(1)} MB).
                        </p>
                        <a
                            href={URL.createObjectURL(new Blob([selectedPlan.content], { type: "text/plain" }))}
                            download={`${selectedPlan.name}.txt`}
                        >
                            Download raw output
                        </a>
                    </div>
                ) : (
                    <pre dangerouslySetInnerHTML={{ __html: ansiToHtml(selectedPlan.content) }} />
                )}
            </div>
        );
    }

    private onPlanSelect = (event: React.ChangeEvent<HTMLSelectElement>): void => {
        this.setState({ selectedIndex: parseInt(event.target.value, 10) });
    };

    public async loadPlans(build: Build): Promise<void> {
        try {
            const buildClient = getClient(BuildRestClient);
            const attachments = await buildClient.getAttachments(
                build.project.id,
                build.id,
                ATTACHMENT_TYPE
            );

            if (!attachments || attachments.length === 0) {
                this.setState({ plans: [], loading: false });
                return;
            }

            const plans: PlanAttachment[] = [];
            const accessToken = await SDK.getAccessToken();
            const authHeader = "Basic " + btoa(":" + accessToken);

            for (const attachment of attachments) {
                try {
                    const response = await fetch(attachment._links.self.href, {
                        headers: { Authorization: authHeader },
                    });
                    if (response.ok) {
                        const content = await response.text();
                        plans.push({ name: attachment.name, content });
                    }
                } catch (err) {
                    console.error(`Failed to download attachment ${attachment.name}:`, err);
                }
            }

            plans.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
            this.setState({ plans, selectedIndex: 0, loading: false });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.setState({ error: message, loading: false });
        }
    }
}

// Initialize the Azure DevOps Extension SDK and render the tab
SDK.init();

SDK.ready().then(() => {
    const config = SDK.getConfiguration();
    const container = document.getElementById("terraform-container");

    if (!container) {
        console.error("Container element not found");
        return;
    }

    if (typeof config.onBuildChanged === "function") {
        let tabRef: TerraformPlanTab | null = null;

        ReactDOM.render(
            <TerraformPlanTab ref={(ref) => { tabRef = ref; }} />,
            container
        );

        config.onBuildChanged((build: Build) => {
            if (tabRef) {
                tabRef.loadPlans(build);
            }
        });
    } else {
        ReactDOM.render(
            <div className="plan-empty">
                This tab is only available in build pipeline results.
            </div>,
            container
        );
    }
}).catch((err) => {
    console.error("Failed to initialize Azure DevOps Extension SDK:", err);
});
