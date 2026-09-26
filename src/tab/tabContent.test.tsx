jest.mock('azure-devops-extension-sdk', () => ({
  init: jest.fn(),
  // Never resolves, so the module-level SDK.ready().then(...) render side-effect
  // (which needs a real DOM) stays inert during the test — no jsdom required.
  ready: jest.fn(() => new Promise(() => { /* pending */ })),
  getAccessToken: jest.fn(() => Promise.resolve('fake-access-token')),
  getConfiguration: jest.fn(() => ({})),
}));

jest.mock('azure-devops-extension-api', () => ({
  getClient: jest.fn(),
}));

jest.mock('azure-devops-extension-api/Build', () => ({
  BuildRestClient: class { },
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { getClient } from 'azure-devops-extension-api';
import { TerraformPlanTab } from './tabContent';
import { TERRAFORM_TASK_ID } from './origin';
import * as ansi from './ansi-to-html';

const PLAN_SUMMARY_TYPE = 'terraform-plan-summary';
const APPLY_SUMMARY_TYPE = 'terraform-apply-summary';
const STATE_SUMMARY_TYPE = 'terraform-state-summary';
const LEGACY_RAW_TYPE = 'terraform-plan-results';

function validPlanDigest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'plan',
    producedBy: { task: 'TerraformTaskV5', taskVersion: '5.12.0' },
    tool: { name: 'terraform', version: '1.14.6' },
    meta: { name: 'plan-main', createdIso: '2026-07-01T12:00:00.000Z' },
    truncated: false,
    summary: { add: 2, change: 0, destroy: 0, replace: 0, read: 0, noChanges: false, driftDetected: false },
    resources: [
      {
        address: 'aws_instance.web',
        type: 'aws_instance',
        name: 'web',
        providerName: 'registry.terraform.io/hashicorp/aws',
        actions: ['create'],
        attributeChanges: [
          { path: 'instance_type', before: { kind: 'unknown' }, after: { kind: 'value', json: '"t3.micro"' } },
        ],
      },
    ],
    outputChanges: [{ name: 'url', action: 'create', value: { kind: 'unknown' } }],
    ...overrides,
  };
}

function validApplyDigest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'apply',
    producedBy: { task: 'TerraformTaskV5', taskVersion: '5.12.0' },
    tool: { name: 'terraform', version: '1.14.6' },
    meta: { name: 'apply-main', createdIso: '2026-07-01T12:05:00.000Z' },
    truncated: false,
    outcome: 'succeeded',
    summary: { add: 1, change: 0, destroy: 0, durationMs: 1234 },
    resources: [{ address: 'aws_instance.web', action: 'create', status: 'complete', durationMs: 900 }],
    diagnostics: [],
    outputs: [{ name: 'url', action: 'create', value: { kind: 'unknown' } }],
    ...overrides,
  };
}

function validStateDigest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'state',
    producedBy: { task: 'TerraformTaskV5', taskVersion: '5.12.0' },
    tool: { name: 'terraform', version: '1.14.6' },
    meta: { name: 'state-main', createdIso: '2026-07-01T12:10:00.000Z' },
    truncated: false,
    summary: { resourceCount: 1, dataSourceCount: 0 },
    resources: [
      {
        address: 'aws_instance.web',
        type: 'aws_instance',
        name: 'web',
        providerName: 'registry.terraform.io/hashicorp/aws',
        mode: 'managed',
        attributes: [{ name: 'instance_type', value: { kind: 'value', json: '"t3.micro"' } }],
      },
    ],
    outputs: [{ name: 'url', value: { kind: 'unknown' } }],
    ...overrides,
  };
}

function attachment(name: string) {
  return { name, _links: { self: { href: `https://example.test/${name}` } } };
}

/** Wires getClient(BuildRestClient).getAttachments to branch by attachment type, and fetch to return the given text bodies keyed by name. */
function mockLoad(options: {
  planNames?: string[];
  applyNames?: string[];
  stateNames?: string[];
  legacyNames?: string[];
  bodies: Record<string, string>;
}) {
  const { planNames = [], applyNames = [], stateNames = [], legacyNames = [], bodies } = options;

  (getClient as jest.Mock).mockReturnValue({
    getAttachments: jest.fn((_project: string, _id: number, type: string) => {
      if (type === PLAN_SUMMARY_TYPE) return Promise.resolve(planNames.map(attachment));
      if (type === APPLY_SUMMARY_TYPE) return Promise.resolve(applyNames.map(attachment));
      if (type === STATE_SUMMARY_TYPE) return Promise.resolve(stateNames.map(attachment));
      if (type === LEGACY_RAW_TYPE) return Promise.resolve(legacyNames.map(attachment));
      return Promise.resolve([]);
    }),
  });

  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn((url: string) => {
    const name = url.split('/').pop() as string;
    const body = bodies[name];
    if (body === undefined) {
      return Promise.resolve({ ok: false, text: () => Promise.resolve(''), headers: { get: () => null } });
    }
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(body),
      headers: { get: (h: string) => (h === 'content-length' ? String(body.length) : null) },
    });
  });
}

/** Creates an unmounted TerraformPlanTab with setState monkey-patched to merge synchronously into instance state. */
function makeTestableTab(): TerraformPlanTab {
  const tab = new TerraformPlanTab({});
  const inst = tab as unknown as { state: Record<string, unknown> };
  (tab as unknown as { setState: (u: unknown) => void }).setState = (update: unknown): void => {
    const next = typeof update === 'function' ? (update as (s: unknown) => object)(inst.state) : update;
    inst.state = { ...inst.state, ...(next as object) };
  };
  return tab;
}

function html(tab: TerraformPlanTab): string {
  return renderToStaticMarkup(tab.render());
}

const build = { project: { id: 'proj' }, id: 1 } as never;

describe('TerraformPlanTab', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders a loading indicator before any results have been fetched', () => {
    const tab = makeTestableTab();
    expect(html(tab)).toContain('Loading terraform results...');
  });

  it('renders an error message when the attachment list itself fails to load', async () => {
    (getClient as jest.Mock).mockReturnValue({
      getAttachments: jest.fn().mockRejectedValue(new Error('attachments API unavailable')),
    });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    expect(html(tab)).toContain('Error: attachments API unavailable');
  });

  it('renders an empty state naming every publish input when nothing has been published', async () => {
    mockLoad({ bodies: {} });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    const out = html(tab);
    expect(out).toContain('No terraform plans, applies, or state have been published');
    for (const input of ['publishPlanResults', 'publishPlanSummary', 'publishApplyResults', 'publishStateResults']) {
      expect(out).toContain(`<code>${input}</code>`);
    }
  });

  it('renders a single plan digest: summary header + resource list, no overview list for one item', async () => {
    mockLoad({ planNames: ['plan-a'], bodies: { 'plan-a': JSON.stringify(validPlanDigest()) } });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    const out = html(tab);
    expect(out).toContain('plan-a');
    expect(out).toContain('aws_instance.web');
    expect(out).toContain('+2');
    expect(out).not.toContain('overview-list');
  });

  it('renders a roll-up header + overview list for multiple plan digests, and switches detail on select', async () => {
    mockLoad({
      planNames: ['plan-a', 'plan-b'],
      bodies: {
        'plan-a': JSON.stringify(validPlanDigest({ meta: { name: 'plan-a', createdIso: 'x' } })),
        'plan-b': JSON.stringify(
          validPlanDigest({
            meta: { name: 'plan-b', createdIso: 'x' },
            resources: [
              {
                address: 'aws_instance.other',
                type: 'aws_instance',
                name: 'other',
                providerName: 'registry.terraform.io/hashicorp/aws',
                actions: ['delete'],
                attributeChanges: [],
              },
            ],
            summary: { add: 0, change: 0, destroy: 1, replace: 0, read: 0, noChanges: false, driftDetected: false },
          })
        ),
      },
    });
    const tab = makeTestableTab();
    await tab.loadAll(build);

    let out = html(tab);
    expect(out).toContain('All plans (2)');
    expect(out).toContain('plan-a');
    expect(out).toContain('plan-b');
    // The plan that destroys something is selected by default, not the first one.
    expect(out).toContain('data-testid="resource-row-aws_instance.other"');
    expect(out).not.toContain('data-testid="resource-row-aws_instance.web"');

    (tab as unknown as { onSelectPlan: (id: string) => void }).onSelectPlan('plan-a#0');
    out = html(tab);
    expect(out).toContain('data-testid="resource-row-aws_instance.web"');
  });

  it('falls back to the legacy raw view when no structured plan attachments exist', async () => {
    mockLoad({ legacyNames: ['legacy-plan.txt'], bodies: { 'legacy-plan.txt': 'Plan: 1 to add' } });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    expect(html(tab)).toContain('Plan: 1 to add');
  });

  it('renders the Apply pivot with timeline, diagnostics, and outputs', async () => {
    mockLoad({ applyNames: ['apply-a'], bodies: { 'apply-a': JSON.stringify(validApplyDigest()) } });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    // No plan/legacy published, so the tab defaults to the Apply pivot.
    const out = html(tab);
    expect(out).toContain('apply-a');
    expect(out).toContain('Succeeded');
    expect(out).toContain('aws_instance.web');
  });

  it('switches between Plan and Apply pivots via setActivePivot', async () => {
    mockLoad({
      planNames: ['plan-a'],
      applyNames: ['apply-a'],
      bodies: {
        'plan-a': JSON.stringify(validPlanDigest()),
        'apply-a': JSON.stringify(validApplyDigest()),
      },
    });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    expect(html(tab)).toContain('plan-a');

    (tab as unknown as { setActivePivot: (p: 'plan' | 'apply' | 'state') => void }).setActivePivot('apply');
    expect(html(tab)).toContain('apply-a');
  });

  it('renders the State pivot with a resource inventory and outputs', async () => {
    mockLoad({ stateNames: ['state-a'], bodies: { 'state-a': JSON.stringify(validStateDigest()) } });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    // No plan/apply/legacy published, so the tab defaults to the State pivot.
    const out = html(tab);
    expect(out).toContain('state-a');
    expect(out).toContain('aws_instance.web');
    expect(out).toContain('1 resources');
    expect(out).not.toContain('overview-list');
  });

  it('renders a roll-up header + overview list for multiple state digests, and switches detail on select', async () => {
    mockLoad({
      stateNames: ['state-a', 'state-b'],
      bodies: {
        'state-a': JSON.stringify(validStateDigest({ meta: { name: 'state-a', createdIso: 'x' } })),
        'state-b': JSON.stringify(
          validStateDigest({
            meta: { name: 'state-b', createdIso: 'x' },
            summary: { resourceCount: 2, dataSourceCount: 1 },
            resources: [
              {
                address: 'data.aws_ami.latest',
                type: 'aws_ami',
                name: 'latest',
                providerName: 'registry.terraform.io/hashicorp/aws',
                mode: 'data',
                attributes: [],
              },
            ],
          })
        ),
      },
    });
    const tab = makeTestableTab();
    await tab.loadAll(build);

    let out = html(tab);
    expect(out).toContain('All state (2)');
    expect(out).toContain('state-a');
    expect(out).toContain('state-b');
    // First item selected by default.
    expect(out).toContain('aws_instance.web');

    (tab as unknown as { onSelectState: (id: string) => void }).onSelectState('state-b#0');
    out = html(tab);
    expect(out).toContain('data.aws_ami.latest');
  });

  it('switches to the State pivot via setActivePivot and shows the empty state when nothing is published for it', async () => {
    mockLoad({ planNames: ['plan-a'], bodies: { 'plan-a': JSON.stringify(validPlanDigest()) } });
    const tab = makeTestableTab();
    await tab.loadAll(build);

    (tab as unknown as { setActivePivot: (p: 'plan' | 'apply' | 'state') => void }).setActivePivot('state');
    expect(html(tab)).toContain('No terraform state has been published for this pipeline run.');
  });

  it('labels a destroy-mode plan digest with a Destroy badge (digest spec §7.1)', async () => {
    mockLoad({
      planNames: ['destroy-a'],
      bodies: { 'destroy-a': JSON.stringify(validPlanDigest({ planMode: 'destroy', meta: { name: 'destroy-a', createdIso: 'x' } })) },
    });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    const out = html(tab);
    expect(out).toContain('Destroy');
    expect(out).toContain('badge-destroy');
  });

  it('selecting a state resource shows its attribute table, selecting again hides it', async () => {
    mockLoad({ stateNames: ['state-a'], bodies: { 'state-a': JSON.stringify(validStateDigest()) } });
    const tab = makeTestableTab();
    await tab.loadAll(build);

    (tab as unknown as { onSelectStateResource: (a: string) => void }).onSelectStateResource('aws_instance.web');
    let out = html(tab);
    expect(out).toContain('instance_type');
    expect(out).toContain('t3.micro');

    (tab as unknown as { onSelectStateResource: (a: string) => void }).onSelectStateResource('aws_instance.web');
    out = html(tab);
    expect(out).not.toContain('state-inventory-attrs-table');
  });

  it('degrades (does not crash) on a schemaVersion:999 state digest and shows the unknown-version banner + raw fallback', async () => {
    const futureDigest = { schemaVersion: 999, kind: 'state' };
    mockLoad({ stateNames: ['future-state'], bodies: { 'future-state': JSON.stringify(futureDigest) } });
    const tab = makeTestableTab();
    expect(async () => tab.loadAll(build)).not.toThrow();
    await tab.loadAll(build);
    const out = html(tab);
    expect(out).toContain('schemaVersion 999');
    expect(out).toContain('View raw digest');
  });

  it('shows a parse-error item with its raw content instead of crashing', async () => {
    mockLoad({ planNames: ['broken-plan'], bodies: { 'broken-plan': '{ not valid json' } });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    const out = html(tab);
    expect(out).toContain('Could not render structured results');
    expect(out).toContain('broken-plan');
  });

  it('degrades (does not crash) on a schemaVersion:999 plan digest and shows the unknown-version banner + raw fallback', async () => {
    const futureDigest = { schemaVersion: 999, kind: 'plan', resources: [], outputChanges: [], summary: {} };
    mockLoad({ planNames: ['future-plan'], bodies: { 'future-plan': JSON.stringify(futureDigest) } });
    const tab = makeTestableTab();
    expect(async () => tab.loadAll(build)).not.toThrow();
    await tab.loadAll(build);
    const out = html(tab);
    expect(out).toContain('schemaVersion 999');
    expect(out).toContain('View raw digest');
  });

  it('selecting a resource shows its attribute diff, selecting again hides it', async () => {
    mockLoad({ planNames: ['plan-a'], bodies: { 'plan-a': JSON.stringify(validPlanDigest()) } });
    const tab = makeTestableTab();
    await tab.loadAll(build);

    (tab as unknown as { onSelectResource: (a: string) => void }).onSelectResource('aws_instance.web');
    let out = html(tab);
    expect(out).toContain('instance_type');
    expect(out).toContain('t3.micro');
    // The diff opens inline, directly under the selected row — not after the whole list.
    expect(out.indexOf('resource-diff-inline')).toBeGreaterThan(out.indexOf('data-testid="resource-row-aws_instance.web"'));
    expect(out.indexOf('resource-diff-inline')).toBeLessThan(out.indexOf('</ul>'));

    (tab as unknown as { onSelectResource: (a: string) => void }).onSelectResource('aws_instance.web');
    out = html(tab);
    expect(out).not.toContain('resource-diff-table');
  });

  describe('review layout', () => {
    type Handlers = {
      onToggleSection: (key: string) => void;
      onToggleUnchangedResources: () => void;
      onToggleUnchangedOutputs: () => void;
      planRollup: (items: unknown[]) => unknown;
      state: { planItems: unknown[] };
    };
    const handlers = (tab: TerraformPlanTab): Handlers => tab as unknown as Handlers;

    function reviewPlan(): Record<string, unknown> {
      return validPlanDigest({
        summary: { add: 1, change: 0, destroy: 0, replace: 0, read: 0, noChanges: false, driftDetected: true },
        resources: [
          {
            address: 'aws_instance.web',
            type: 'aws_instance',
            name: 'web',
            providerName: 'registry.terraform.io/hashicorp/aws',
            actions: ['create'],
            attributeChanges: [],
          },
          {
            address: 'aws_instance.untouched',
            type: 'aws_instance',
            name: 'untouched',
            providerName: 'registry.terraform.io/hashicorp/aws',
            actions: ['no-op'],
            attributeChanges: [],
          },
        ],
        drift: [
          {
            address: 'aws_subnet.drifted',
            type: 'aws_subnet',
            name: 'drifted',
            providerName: 'registry.terraform.io/hashicorp/aws',
            attributeChanges: [{ path: 'tags', before: { kind: 'value', json: '{}' }, after: { kind: 'value', json: '{"owner":"portal"}' } }],
          },
        ],
        outputChanges: [
          { name: 'url', action: 'create', value: { kind: 'unknown' } },
          { name: 'region', action: 'no-op', value: { kind: 'value', json: '"eastus"' } },
        ],
      });
    }

    async function loadReviewPlan(): Promise<TerraformPlanTab> {
      mockLoad({ planNames: ['plan-a'], bodies: { 'plan-a': JSON.stringify(reviewPlan()) } });
      const tab = makeTestableTab();
      await tab.loadAll(build);
      return tab;
    }

    it('heads each plan section with its count', async () => {
      const out = html(await loadReviewPlan());
      expect(out).toContain('Resource changes<span class="detail-section-count"> (1)</span>');
      expect(out).toContain('Drift<span class="detail-section-count"> (1)</span>');
      expect(out).toContain('Output changes<span class="detail-section-count"> (1)</span>');
    });

    // Assertions below match rendered structure, not bare digest text: the raw
    // digest JSON (under "View raw digest") contains every address and value.
    it('keeps drift collapsed until its section is opened', async () => {
      const tab = await loadReviewPlan();
      let out = html(tab);
      expect(out).toContain('class="detail-section-toggle" aria-expanded="false"');
      expect(out).not.toContain('class="drift-list"');

      handlers(tab).onToggleSection('plan.drift');
      out = html(tab);
      expect(out).toContain('class="drift-list"');
      expect(out).toContain('<span class="resource-diff-address">aws_subnet.drifted</span>');
    });

    it('closes an open section and reopens it', async () => {
      const tab = await loadReviewPlan();
      handlers(tab).onToggleSection('plan.changes');
      expect(html(tab)).not.toContain('data-testid="resource-row-aws_instance.web"');

      handlers(tab).onToggleSection('plan.changes');
      expect(html(tab)).toContain('data-testid="resource-row-aws_instance.web"');
    });

    it('hides unchanged resources until the reviewer asks for them', async () => {
      const tab = await loadReviewPlan();
      let out = html(tab);
      expect(out).toContain('Unchanged (1)');
      expect(out).not.toContain('data-testid="resource-row-aws_instance.untouched"');

      handlers(tab).onToggleUnchangedResources();
      out = html(tab);
      expect(out).toContain('data-testid="resource-row-aws_instance.untouched"');
    });

    it('hides unchanged output changes until the reviewer asks for them', async () => {
      const tab = await loadReviewPlan();
      let out = html(tab);
      expect(out).toContain('Show 1 unchanged output');
      expect(out).not.toContain('>region<');

      handlers(tab).onToggleUnchangedOutputs();
      out = html(tab);
      expect(out).toContain('>region<');
    });

    it('omits the Drift section for a plan without drift', async () => {
      mockLoad({ planNames: ['plan-a'], bodies: { 'plan-a': JSON.stringify(validPlanDigest()) } });
      const tab = makeTestableTab();
      await tab.loadAll(build);
      expect(html(tab)).not.toContain('drift-section');
    });

    it('heads the apply sections, summarising diagnostics by severity', async () => {
      mockLoad({
        applyNames: ['apply-a'],
        bodies: {
          'apply-a': JSON.stringify(
            validApplyDigest({
              outcome: 'failed',
              diagnostics: [
                { severity: 'error', summary: 'boom' },
                { severity: 'error', summary: 'bang' },
                { severity: 'warning', summary: 'deprecated' },
              ],
            })
          ),
        },
      });
      const tab = makeTestableTab();
      await tab.loadAll(build);
      const out = html(tab);
      expect(out).toContain('Resources<span class="detail-section-count"> (1)</span>');
      expect(out).toContain('Diagnostics<span class="detail-section-count"> (2 errors, 1 warning)</span>');
      expect(out).toContain('Outputs<span class="detail-section-count"> (1)</span>');

      expect(out).toContain('class="diagnostics-panel"');

      handlers(tab).onToggleSection('apply.diagnostics');
      expect(html(tab)).not.toContain('class="diagnostics-panel"');
    });

    it('counts a single error or warning in the singular, and none as 0', async () => {
      for (const [diagnostics, label] of [
        [[{ severity: 'error', summary: 'boom' }], '1 error'],
        [[{ severity: 'warning', summary: 'hm' }], '1 warning'],
        [[], '0'],
      ] as const) {
        mockLoad({ applyNames: ['apply-a'], bodies: { 'apply-a': JSON.stringify(validApplyDigest({ diagnostics })) } });
        const tab = makeTestableTab();
        await tab.loadAll(build);
        expect(html(tab)).toContain(`Diagnostics<span class="detail-section-count"> (${label})</span>`);
      }
    });

    it('heads the state sections with their counts', async () => {
      mockLoad({ stateNames: ['state-a'], bodies: { 'state-a': JSON.stringify(validStateDigest()) } });
      const tab = makeTestableTab();
      await tab.loadAll(build);
      const out = html(tab);
      expect(out).toContain('Resources<span class="detail-section-count"> (1)</span>');
      expect(out).toContain('Outputs<span class="detail-section-count"> (1)</span>');
    });

    it('reuses the multi-plan roll-up across renders instead of recomputing it', async () => {
      mockLoad({
        planNames: ['plan-a', 'plan-b'],
        bodies: { 'plan-a': JSON.stringify(validPlanDigest()), 'plan-b': JSON.stringify(validPlanDigest()) },
      });
      const tab = makeTestableTab();
      await tab.loadAll(build);
      const items = handlers(tab).state.planItems;
      expect(handlers(tab).planRollup(items)).toBe(handlers(tab).planRollup(items));
      expect(html(tab)).toContain('All plans (2)');
    });
  });

  it('refuses an over-ceiling attachment by its Content-Length WITHOUT buffering the body (pre-read guard)', async () => {
    (getClient as jest.Mock).mockReturnValue({
      getAttachments: jest.fn((_p: string, _id: number, type: string) => {
        if (type === PLAN_SUMMARY_TYPE) return Promise.resolve([attachment('huge-plan')]);
        return Promise.resolve([]);
      }),
    });
    const textSpy = jest.fn(() => Promise.resolve('should-never-be-read'));
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        text: textSpy,
        // 17 MB declared, over the 16 MB TAB_PARSE_CEILING_BYTES.
        headers: { get: (h: string) => (h === 'content-length' ? String(17 * 1024 * 1024) : null) },
      })
    );

    const tab = makeTestableTab();
    await tab.loadAll(build);
    const out = html(tab);
    expect(out).toMatch(/over the .* tab parse ceiling/i);
    expect(textSpy).not.toHaveBeenCalled(); // body never buffered
  });

  it('skips an attachment whose fetch throws, keeping the others', async () => {
    (getClient as jest.Mock).mockReturnValue({
      getAttachments: jest.fn((_p: string, _id: number, type: string) => {
        if (type === PLAN_SUMMARY_TYPE) return Promise.resolve([attachment('ok-plan'), attachment('network-error')]);
        return Promise.resolve([]);
      }),
    });
    (global as unknown as { fetch: jest.Mock }).fetch = jest
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify(validPlanDigest())),
          headers: { get: () => null },
        })
      )
      .mockImplementationOnce(() => Promise.reject(new Error('network down')));
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => { /* silence expected log */ });

    const tab = makeTestableTab();
    await tab.loadAll(build);
    const out = html(tab);
    expect(out).toContain('ok-plan');
    expect(out).not.toContain('network-error');
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

type Pivot = 'plan' | 'apply' | 'state';

/** The tab's private handlers, reached the same way the tests above reach them. */
interface TabHandlers {
  setActivePivot(pivot: Pivot): void;
  onSelectPlan(id: string): void;
  onSelectApply(id: string): void;
  onSelectState(id: string): void;
  onSelectResource(address: string): void;
  onResourceSearchChange(text: string): void;
  onSelectStateResource(address: string): void;
  onStateSearchTextChange(text: string): void;
  onSelectLegacy(event: { target: { value: string } }): void;
  onRawDetailsToggle(pivot: Pivot, id: string, open: boolean): void;
}

function handlers(tab: TerraformPlanTab): TabHandlers {
  return tab as unknown as TabHandlers;
}

function tabState(tab: TerraformPlanTab): Record<string, unknown> {
  return (tab as unknown as { state: Record<string, unknown> }).state;
}

const SELECTION_KEYS = [
  'activePivot',
  'selectedPlanId',
  'selectedApplyId',
  'selectedStateId',
  'selectedLegacyIndex',
  'selectedResourceAddress',
  'resourceSearchText',
  'selectedStateAddress',
  'stateSearchText',
  'openRawDetails',
];

function selections(tab: TerraformPlanTab): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of SELECTION_KEYS) picked[key] = tabState(tab)[key];
  return picked;
}

const OTHER_RESOURCE = {
  address: 'aws_instance.other',
  type: 'aws_instance',
  name: 'other',
  providerName: 'registry.terraform.io/hashicorp/aws',
  actions: ['delete'],
  attributeChanges: [],
};

/** Resolves once `condition` holds, flushing pending promise callbacks between checks. */
async function flushUntil(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !condition(); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(condition()).toBe(true);
}

describe('TerraformPlanTab raw digest views', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('leaves the raw digest body out of the render entirely while its expander is closed', async () => {
    mockLoad({ planNames: ['plan-a'], bodies: { 'plan-a': JSON.stringify(validPlanDigest()) } });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    const ansiSpy = jest.spyOn(ansi, 'ansiToHtml');

    const out = html(tab);
    expect(out).toContain('<details class="raw-details"><summary>View raw digest</summary></details>');
    expect(out).not.toContain('raw-view');
    expect(ansiSpy).not.toHaveBeenCalled();
  });

  it('renders the open expander as plain text, for that one digest item only', async () => {
    mockLoad({
      planNames: ['plan-a', 'plan-b'],
      bodies: {
        'plan-a': JSON.stringify(validPlanDigest({ meta: { name: 'plan-a', createdIso: 'x' } })),
        'plan-b': JSON.stringify(validPlanDigest({ meta: { name: 'plan-b', createdIso: 'x' } })),
      },
    });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    const ansiSpy = jest.spyOn(ansi, 'ansiToHtml');

    handlers(tab).onRawDetailsToggle('plan', 'plan-a#0', true);
    let out = html(tab);
    expect(out).toContain('<details class="raw-details" open="">');
    expect(out).toContain('&quot;name&quot;:&quot;plan-a&quot;');
    expect(ansiSpy).not.toHaveBeenCalled();

    // A close reported by a different item's expander (React closing a reused
    // <details> after the selection moved) does not close this one.
    handlers(tab).onRawDetailsToggle('plan', 'plan-b#0', false);
    expect(tabState(tab).openRawDetails).toEqual({ pivot: 'plan', id: 'plan-a#0' });

    handlers(tab).onSelectPlan('plan-b#0');
    expect(html(tab)).not.toContain('raw-view');
    handlers(tab).onSelectPlan('plan-a#0');
    expect(html(tab)).toContain('&quot;name&quot;:&quot;plan-a&quot;');

    handlers(tab).onRawDetailsToggle('plan', 'plan-a#0', false);
    out = html(tab);
    expect(out).not.toContain('raw-view');
    expect(tabState(tab).openRawDetails).toBeNull();
  });

  it('shows a digest that fails to parse as plain text, never through ansiToHtml', async () => {
    mockLoad({ planNames: ['broken-plan'], bodies: { 'broken-plan': '\x1b[31m<b>not json</b>\x1b[0m' } });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    const ansiSpy = jest.spyOn(ansi, 'ansiToHtml');

    const out = html(tab);
    expect(out).toContain('Could not render structured results');
    expect(out).toContain('&lt;b&gt;not json&lt;/b&gt;');
    expect(out).not.toContain('class="ansi-');
    expect(ansiSpy).not.toHaveBeenCalled();
  });

  it('still renders legacy terraform-plan-results output through ansiToHtml', async () => {
    mockLoad({ legacyNames: ['legacy-plan.txt'], bodies: { 'legacy-plan.txt': '\x1b[32m+ create\x1b[0m' } });
    const tab = makeTestableTab();
    await tab.loadAll(build);

    expect(html(tab)).toContain('<span class="ansi-green">+ create</span>');
  });
});

describe('TerraformPlanTab reloads (onBuildChanged firing again)', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('clears the error screen once a later load succeeds', async () => {
    (getClient as jest.Mock).mockReturnValueOnce({
      getAttachments: jest.fn().mockRejectedValue(new Error('attachments API unavailable')),
    });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    expect(html(tab)).toContain('Error: attachments API unavailable');

    mockLoad({ planNames: ['plan-a'], bodies: { 'plan-a': JSON.stringify(validPlanDigest()) } });
    await tab.loadAll(build);

    const out = html(tab);
    expect(out).not.toContain('Error:');
    expect(out).toContain('aws_instance.web');
  });

  it('a reload of the same build keeps every selection that still exists', async () => {
    mockLoad({
      planNames: ['plan-a', 'plan-b'],
      applyNames: ['apply-a', 'apply-b'],
      stateNames: ['state-a', 'state-b'],
      bodies: {
        'plan-a': JSON.stringify(validPlanDigest()),
        'plan-b': JSON.stringify(validPlanDigest({ resources: [OTHER_RESOURCE] })),
        'apply-a': JSON.stringify(validApplyDigest()),
        'apply-b': JSON.stringify(validApplyDigest()),
        'state-a': JSON.stringify(validStateDigest()),
        'state-b': JSON.stringify(validStateDigest()),
      },
    });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    const h = handlers(tab);
    h.onSelectPlan('plan-b#0');
    h.onSelectResource('aws_instance.other');
    h.onResourceSearchChange('other');
    h.onSelectApply('apply-b#0');
    h.onSelectState('state-b#0');
    h.onSelectStateResource('aws_instance.web');
    h.onStateSearchTextChange('web');
    h.onRawDetailsToggle('state', 'state-b#0', true);
    h.setActivePivot('state');
    const before = selections(tab);

    await tab.loadAll(build);

    expect(selections(tab)).toEqual(before);
    expect(before).toEqual({
      activePivot: 'state',
      selectedPlanId: 'plan-b#0',
      selectedApplyId: 'apply-b#0',
      selectedStateId: 'state-b#0',
      selectedLegacyIndex: 0,
      selectedResourceAddress: 'aws_instance.other',
      resourceSearchText: 'other',
      selectedStateAddress: 'aws_instance.web',
      stateSearchText: 'web',
      openRawDetails: { pivot: 'state', id: 'state-b#0' },
    });
  });

  it('falls back only for the selections whose target is gone', async () => {
    const stateWithout = validStateDigest({ summary: { resourceCount: 0, dataSourceCount: 0 }, resources: [] });
    mockLoad({
      planNames: ['plan-a', 'plan-b'],
      stateNames: ['state-a'],
      bodies: {
        'plan-a': JSON.stringify(validPlanDigest()),
        'plan-b': JSON.stringify(validPlanDigest({ resources: [OTHER_RESOURCE] })),
        'state-a': JSON.stringify(validStateDigest()),
      },
    });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    const h = handlers(tab);
    h.onSelectPlan('plan-b#0');
    h.onSelectResource('aws_instance.other');
    h.onResourceSearchChange('other');
    h.onRawDetailsToggle('plan', 'plan-b#0', true);
    h.onSelectStateResource('aws_instance.web');
    h.onStateSearchTextChange('web');
    h.setActivePivot('state');

    // plan-b was removed, and state-a no longer holds aws_instance.web.
    mockLoad({
      planNames: ['plan-a'],
      stateNames: ['state-a'],
      bodies: { 'plan-a': JSON.stringify(validPlanDigest()), 'state-a': JSON.stringify(stateWithout) },
    });
    await tab.loadAll(build);

    expect(selections(tab)).toEqual({
      activePivot: 'state',
      selectedPlanId: 'plan-a#0',
      selectedApplyId: null,
      selectedStateId: 'state-a#0',
      selectedLegacyIndex: 0,
      selectedResourceAddress: null,
      resourceSearchText: '',
      selectedStateAddress: null,
      stateSearchText: 'web',
      openRawDetails: null,
    });
  });

  it('keeps the selection when a newly published attachment is listed before it', async () => {
    mockLoad({ planNames: ['plan-b'], bodies: { 'plan-b': JSON.stringify(validPlanDigest({ resources: [OTHER_RESOURCE] })) } });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    handlers(tab).onSelectResource('aws_instance.other');

    mockLoad({
      planNames: ['plan-a', 'plan-b'],
      bodies: {
        'plan-a': JSON.stringify(validPlanDigest()),
        'plan-b': JSON.stringify(validPlanDigest({ resources: [OTHER_RESOURCE] })),
      },
    });
    await tab.loadAll(build);

    expect(tabState(tab).selectedPlanId).toBe('plan-b#0');
    expect(tabState(tab).selectedResourceAddress).toBe('aws_instance.other');
    expect(html(tab)).toContain('All plans (2)');
  });

  it('follows the selected legacy attachment by name as the list changes', async () => {
    const legacy = (names: string[]): void => {
      const bodies: Record<string, string> = {};
      for (const name of names) bodies[name] = `output of ${name}`;
      mockLoad({ legacyNames: names, bodies });
    };
    legacy(['a.txt', 'b.txt']);
    const tab = makeTestableTab();
    await tab.loadAll(build);
    handlers(tab).onSelectLegacy({ target: { value: '1' } });

    await tab.loadAll(build);
    expect(tabState(tab).selectedLegacyIndex).toBe(1);

    legacy(['0.txt', 'a.txt', 'b.txt']);
    await tab.loadAll(build);
    expect(tabState(tab).selectedLegacyIndex).toBe(2);
    expect(html(tab)).toContain('output of b.txt');

    legacy(['a.txt']);
    await tab.loadAll(build);
    expect(tabState(tab).selectedLegacyIndex).toBe(0);
  });

  it('opens on the default pivot when the previous load had shown nothing', async () => {
    mockLoad({ bodies: {} });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    expect(html(tab)).toContain('No terraform plans, applies, or state have been published');

    mockLoad({ applyNames: ['apply-a'], bodies: { 'apply-a': JSON.stringify(validApplyDigest()) } });
    await tab.loadAll(build);

    expect(tabState(tab).activePivot).toBe('apply');
  });

  it('a load for a different build starts from the default view', async () => {
    mockLoad({
      planNames: ['plan-a', 'plan-b'],
      bodies: {
        'plan-a': JSON.stringify(validPlanDigest()),
        'plan-b': JSON.stringify(validPlanDigest({ resources: [OTHER_RESOURCE] })),
      },
    });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    handlers(tab).onSelectPlan('plan-b#0');
    handlers(tab).onResourceSearchChange('other');
    handlers(tab).setActivePivot('apply');

    await tab.loadAll({ project: { id: 'proj' }, id: 2 } as never);

    expect(tabState(tab)).toMatchObject({
      activePivot: 'plan',
      selectedPlanId: 'plan-a#0',
      resourceSearchText: '',
      loadedBuildId: 2,
    });
  });

  it('discards an older overlapping load that resolves after a newer one', async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    (getClient as jest.Mock)
      .mockReturnValueOnce({
        getAttachments: jest.fn(async (_p: string, _id: number, type: string) => {
          await gate;
          return type === PLAN_SUMMARY_TYPE ? [attachment('old-plan')] : [];
        }),
      })
      .mockReturnValueOnce({
        getAttachments: jest.fn(async (_p: string, _id: number, type: string) =>
          type === PLAN_SUMMARY_TYPE ? [attachment('new-plan')] : []
        ),
      });
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify(validPlanDigest()),
      headers: { get: () => null },
    }));

    const tab = makeTestableTab();
    const first = tab.loadAll(build);
    await tab.loadAll(build);
    releaseFirst();
    await first;

    const out = html(tab);
    expect(out).toContain('new-plan');
    expect(out).not.toContain('old-plan');
  });

  it('ignores a failure from a load that a newer one superseded', async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    (getClient as jest.Mock)
      .mockReturnValueOnce({
        getAttachments: jest.fn(async () => {
          await gate;
          throw new Error('stale failure');
        }),
      })
      .mockReturnValueOnce({
        getAttachments: jest.fn(async (_p: string, _id: number, type: string) =>
          type === PLAN_SUMMARY_TYPE ? [attachment('new-plan')] : []
        ),
      });
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify(validPlanDigest()),
      headers: { get: () => null },
    }));

    const tab = makeTestableTab();
    const first = tab.loadAll(build);
    await tab.loadAll(build);
    releaseFirst();
    await first;

    const out = html(tab);
    expect(out).not.toContain('Error:');
    expect(out).toContain('new-plan');
  });

  it('a superseded load starts none of the downloads it had not already started', async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    // Downloads run four at a time per attachment type, so the first load has
    // p1-p4 and l1-l2 in flight and p5-p6 still waiting when it is superseded.
    (getClient as jest.Mock)
      .mockReturnValueOnce({
        getAttachments: jest.fn((_p: string, _id: number, type: string) => {
          if (type === PLAN_SUMMARY_TYPE) return Promise.resolve(['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map(attachment));
          if (type === LEGACY_RAW_TYPE) return Promise.resolve(['l1', 'l2'].map(attachment));
          return Promise.resolve([]);
        }),
      })
      .mockReturnValueOnce({
        getAttachments: jest.fn((_p: string, _id: number, type: string) =>
          Promise.resolve(type === PLAN_SUMMARY_TYPE ? [attachment('q1')] : [])
        ),
      });
    const fetchMock = jest.fn(async (url: string) => {
      const name = url.split('/').pop() as string;
      if (name.startsWith('p') || name.startsWith('l')) await gate;
      const body = name.startsWith('l') ? `output of ${name}` : JSON.stringify(validPlanDigest());
      return { ok: true, text: async () => body, headers: { get: () => null } };
    });
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;

    const tab = makeTestableTab();
    const first = tab.loadAll(build);
    await flushUntil(() => fetchMock.mock.calls.length === 6); // p1-p4 and l1-l2 in flight
    await tab.loadAll(build);
    releaseFirst();
    await first;

    const fetched = fetchMock.mock.calls.map(([url]) => url.split('/').pop());
    expect(fetched.sort()).toEqual(['l1', 'l2', 'p1', 'p2', 'p3', 'p4', 'q1']);
    expect(html(tab)).toContain('q1');
  });
});

describe('TerraformPlanTab opens on what needs review', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  type ReviewHandlers = TabHandlers & {
    onSelectAttention(pivot: Pivot, id: string): void;
    onResourceActionFilterChange(group: string | null): void;
    onToggleSection(key: string): void;
  };
  const review = (tab: TerraformPlanTab): ReviewHandlers => tab as unknown as ReviewHandlers;

  const DESTROYING_PLAN = validPlanDigest({
    resources: [OTHER_RESOURCE],
    summary: { add: 0, change: 0, destroy: 1, replace: 0, read: 0, noChanges: false, driftDetected: false },
  });
  const FAILED_APPLY = validApplyDigest({
    outcome: 'failed',
    summary: { add: 1, change: 0, destroy: 0, durationMs: 734000 },
    resources: [
      { address: 'aws_instance.ok', action: 'create', status: 'complete', durationMs: 900 },
      { address: 'aws_instance.bad', action: 'create', status: 'errored', durationMs: 1200 },
    ],
    diagnostics: [{ severity: 'error', summary: 'boom', address: 'aws_instance.bad' }],
  });

  it('lists what needs review above the pivots, and opens an entry on click', async () => {
    mockLoad({
      planNames: ['plan-a', 'plan-b'],
      applyNames: ['apply-a'],
      bodies: { 'plan-a': JSON.stringify(validPlanDigest()), 'plan-b': JSON.stringify(DESTROYING_PLAN), 'apply-a': JSON.stringify(FAILED_APPLY) },
    });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    const out = html(tab);
    expect(out).toContain('Needs review (2)');
    expect(out.indexOf('attention-strip')).toBeLessThan(out.indexOf('pivot-bar'));
    expect(out).toContain('<span class="attention-item-reason">: apply failed with 1 error</span>');
    expect(out).toContain('<span class="attention-item-reason">: 1 to destroy</span>');

    review(tab).onSelectAttention('plan', 'plan-b#0');
    expect(tabState(tab)).toMatchObject({ activePivot: 'plan', selectedPlanId: 'plan-b#0' });
    review(tab).onSelectAttention('apply', 'apply-a#0');
    expect(tabState(tab)).toMatchObject({ activePivot: 'apply', selectedApplyId: 'apply-a#0' });
  });

  it('keeps the search when an entry opens the plan that is already selected', async () => {
    mockLoad({ planNames: ['plan-b'], bodies: { 'plan-b': JSON.stringify(DESTROYING_PLAN) } });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    handlers(tab).onResourceSearchChange('other');
    review(tab).onSelectAttention('plan', 'plan-b#0');
    expect(tabState(tab).resourceSearchText).toBe('other');
  });

  it('opens a state entry from the strip', async () => {
    mockLoad({
      stateNames: ['state-a', 'state-b'],
      bodies: { 'state-a': JSON.stringify(validStateDigest()), 'state-b': JSON.stringify(validStateDigest({ truncated: true })) },
    });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    expect(html(tab)).toContain('partial view (truncated)');
    review(tab).onSelectAttention('state', 'state-b#0');
    expect(tabState(tab)).toMatchObject({ activePivot: 'state', selectedStateId: 'state-b#0' });
  });

  it('shows no strip when nothing needs review', async () => {
    mockLoad({ planNames: ['plan-a'], bodies: { 'plan-a': JSON.stringify(validPlanDigest()) } });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    expect(html(tab)).not.toContain('attention-strip');
  });

  it('counts each pivot and marks a failed apply on its tab', async () => {
    mockLoad({
      planNames: ['plan-a', 'plan-b'],
      applyNames: ['apply-a'],
      bodies: { 'plan-a': JSON.stringify(validPlanDigest()), 'plan-b': JSON.stringify(validPlanDigest()), 'apply-a': JSON.stringify(FAILED_APPLY) },
    });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    const out = html(tab);
    expect(out).toContain('Plan <span class="pivot-count">2</span>');
    expect(out).toContain('Apply <span class="pivot-count">1</span><span class="pivot-status-failed"> failed</span>');
    expect(out).toContain('State <span class="pivot-count">0</span>');
  });

  it('counts legacy CLI outputs on the Plan tab when no structured plan was published', async () => {
    mockLoad({ legacyNames: ['a.txt', 'b.txt'], bodies: { 'a.txt': 'x', 'b.txt': 'y' } });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    expect(html(tab)).toContain('Plan <span class="pivot-count">2</span>');
  });

  it('opens on the Apply pivot, with the failed apply selected, when an apply failed', async () => {
    mockLoad({
      planNames: ['plan-a'],
      applyNames: ['apply-a', 'apply-b'],
      bodies: { 'plan-a': JSON.stringify(validPlanDigest()), 'apply-a': JSON.stringify(validApplyDigest()), 'apply-b': JSON.stringify(FAILED_APPLY) },
    });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    expect(tabState(tab)).toMatchObject({ activePivot: 'apply', selectedApplyId: 'apply-b#0' });
  });

  it('leads a failed apply with its diagnostics and shows how long it took', async () => {
    mockLoad({ applyNames: ['apply-a'], bodies: { 'apply-a': JSON.stringify(FAILED_APPLY) } });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    const out = html(tab);
    expect(out.indexOf('>Diagnostics<')).toBeLessThan(out.indexOf('>Resources<'));
    expect(out).toContain('took 12m 14s');
    expect(out).toContain('Errored (1)');
  });

  it('keeps Resources first for a successful apply', async () => {
    mockLoad({ applyNames: ['apply-a'], bodies: { 'apply-a': JSON.stringify(validApplyDigest()) } });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    const out = html(tab);
    expect(out.indexOf('>Resources<')).toBeLessThan(out.indexOf('>Diagnostics<'));
  });

  it('explains a failed apply that carries no diagnostics instead of saying there are none', async () => {
    mockLoad({ applyNames: ['apply-a'], bodies: { 'apply-a': JSON.stringify({ ...FAILED_APPLY, diagnostics: [] }) } });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    const out = html(tab);
    expect(out).toContain('Diagnostics<span class="detail-section-count"> (none included)</span>');
    expect(out).toContain('<code>includeDiagnostics</code>');
    expect(out).not.toContain('No diagnostics.');
  });

  describe('Terraform CLI output alongside structured plans', () => {
    it('offers the CLI output published under the same name, collapsed until opened', async () => {
      // Both attachment types share the name, so hrefs and bodies are routed by type.
      (getClient as jest.Mock).mockReturnValue({
        getAttachments: jest.fn((_p: string, _id: number, type: string) => {
          if (type === PLAN_SUMMARY_TYPE) return Promise.resolve([{ name: 'plan-a', _links: { self: { href: 'https://example.test/summary/plan-a' } } }]);
          if (type === LEGACY_RAW_TYPE) return Promise.resolve([{ name: 'plan-a', _links: { self: { href: 'https://example.test/legacy/plan-a' } } }]);
          return Promise.resolve([]);
        }),
      });
      (global as unknown as { fetch: jest.Mock }).fetch = jest.fn((url: string) => {
        const body = url.includes('/legacy/') ? '\x1b[32m+ create\x1b[0m' : JSON.stringify(validPlanDigest());
        return Promise.resolve({ ok: true, text: () => Promise.resolve(body), headers: { get: () => null } });
      });
      const tab = makeTestableTab();
      await tab.loadAll(build);
      let out = html(tab);
      expect(out).toContain('>Terraform CLI output<');
      expect(out).not.toContain('ansi-green');

      review(tab).onToggleSection('plan.cli');
      out = html(tab);
      expect(out).toContain('<span class="ansi-green">+ create</span>');
    });

    it('keeps CLI output that no structured plan claims reachable, one section each', async () => {
      mockLoad({
        planNames: ['plan-a'],
        legacyNames: ['other.txt'],
        bodies: { 'plan-a': JSON.stringify(validPlanDigest()), 'other.txt': 'raw output of other' },
      });
      const tab = makeTestableTab();
      await tab.loadAll(build);
      let out = html(tab);
      expect(out).toContain('Terraform CLI output<span class="detail-section-count"> (other.txt)</span>');
      expect(out).not.toContain('raw output of other');

      review(tab).onToggleSection('cli:0:other.txt');
      out = html(tab);
      expect(out).toContain('raw output of other');
    });
  });

  describe('action filter', () => {
    const MIXED_PLAN = validPlanDigest({
      resources: [
        { address: 'aws_instance.web', type: 'aws_instance', name: 'web', providerName: 'p', actions: ['create'], attributeChanges: [] },
        OTHER_RESOURCE,
      ],
    });

    it('narrows the resource list and resets when another plan is selected', async () => {
      mockLoad({ planNames: ['plan-a', 'plan-b'], bodies: { 'plan-a': JSON.stringify(MIXED_PLAN), 'plan-b': JSON.stringify(MIXED_PLAN) } });
      const tab = makeTestableTab();
      await tab.loadAll(build);
      handlers(tab).onSelectPlan('plan-a#0');
      review(tab).onResourceActionFilterChange('delete');
      let out = html(tab);
      expect(out).toContain('data-testid="resource-row-aws_instance.other"');
      expect(out).not.toContain('data-testid="resource-row-aws_instance.web"');

      handlers(tab).onSelectPlan('plan-b#0');
      expect(tabState(tab).resourceActionFilter).toBeNull();
      out = html(tab);
      expect(out).toContain('data-testid="resource-row-aws_instance.web"');
    });

    it('survives a reload of the same build alongside its plan', async () => {
      mockLoad({ planNames: ['plan-a'], bodies: { 'plan-a': JSON.stringify(MIXED_PLAN) } });
      const tab = makeTestableTab();
      await tab.loadAll(build);
      review(tab).onResourceActionFilterChange('create');
      await tab.loadAll(build);
      expect(tabState(tab).resourceActionFilter).toBe('create');

      await tab.loadAll({ project: { id: 'proj' }, id: 2 } as never);
      expect(tabState(tab).resourceActionFilter).toBeNull();
    });
  });
});

describe('TerraformPlanTab pipeline order and loading', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  const TIMELINE = '11111111-1111-1111-1111-111111111111';
  const BASE = 'https://dev.example.test/org/proj';
  const guid = (n: number): string => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

  /** Attachments with real attachment URLs (naming their publishing record) and a timeline to resolve them against. */
  function mockRun(
    plans: Array<{ name: string; record: string }>,
    records: Array<Record<string, unknown>>,
    bodies: Record<string, string>,
    timeline: 'ok' | 'fails' = 'ok'
  ): void {
    mockLoad({ bodies });
    (getClient as jest.Mock).mockReturnValue({
      getAttachments: jest.fn((_p: string, _id: number, type: string) =>
        Promise.resolve(
          type === PLAN_SUMMARY_TYPE
            ? plans.map((p) => ({ name: p.name, _links: { self: { href: `${BASE}/_apis/build/builds/1/${TIMELINE}/${p.record}/attachments/${type}/${p.name}` } } }))
            : []
        )
      ),
      getBuildTimeline: jest.fn(() => (timeline === 'ok' ? Promise.resolve({ records }) : Promise.reject(new Error('timeline unavailable')))),
    });
  }

  const RECORDS = [
    { id: guid(1), type: 'Stage', name: 'Plan dev', order: 1 },
    { id: guid(2), parentId: guid(1), type: 'Job', name: 'Plan', order: 1 },
    { id: guid(3), parentId: guid(2), type: 'Task', name: 'Terraform plan (dev)', order: 4, task: { id: TERRAFORM_TASK_ID } },
    { id: guid(4), type: 'Stage', name: 'Plan prod', order: 2 },
    { id: guid(5), parentId: guid(4), type: 'Job', name: 'Plan', order: 1 },
    { id: guid(6), parentId: guid(5), type: 'Task', name: 'Terraform plan (prod)', order: 4, task: { id: TERRAFORM_TASK_ID } },
    { id: guid(7), parentId: guid(5), type: 'Task', name: 'Bash', order: 5, task: { id: '6c731c3c-3c68-459a-a5c9-bde6e6595b5b' } },
  ];

  it('orders plans by where they ran in the pipeline, not by name, and says where each came from', async () => {
    mockRun(
      [
        { name: 'a-prod', record: guid(6) },
        { name: 'z-dev', record: guid(3) },
      ],
      RECORDS,
      { 'a-prod': JSON.stringify(validPlanDigest()), 'z-dev': JSON.stringify(validPlanDigest()) }
    );
    const tab = makeTestableTab();
    await tab.loadAll(build);
    const out = html(tab);
    expect(out.indexOf('>z-dev<')).toBeLessThan(out.indexOf('>a-prod<'));
    expect(out).toContain('<span class="overview-item-origin">Plan dev › Plan › Terraform plan (dev)</span>');
    expect(out).toContain(`href="${BASE}/_build/results?buildId=1&amp;view=logs&amp;j=${guid(2)}&amp;t=${guid(3)}"`);
  });

  it('flags a digest that a step other than the Terraform task published', async () => {
    mockRun([{ name: 'spoofed', record: guid(7) }], RECORDS, { spoofed: JSON.stringify(validPlanDigest()) });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    const out = html(tab);
    expect(out).toContain("published by a step that isn&#x27;t the Terraform task");
    expect(out).toContain('<span class="badge badge-untrusted">Not from the Terraform task</span>');
  });

  it('still loads, ordered by name and without steps, when the timeline cannot be read', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => { /* expected */ });
    mockRun(
      [
        { name: 'b-plan', record: guid(3) },
        { name: 'a-plan', record: guid(6) },
      ],
      RECORDS,
      { 'b-plan': JSON.stringify(validPlanDigest()), 'a-plan': JSON.stringify(validPlanDigest()) },
      'fails'
    );
    const tab = makeTestableTab();
    await tab.loadAll(build);
    const out = html(tab);
    expect(out.indexOf('>a-plan<')).toBeLessThan(out.indexOf('>b-plan<'));
    expect(out).not.toContain('View step log');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to read the build timeline:', expect.any(Error));
  });

  it("falls back to the stage and job the digest itself recorded, with its working directory", async () => {
    mockLoad({
      planNames: ['plan-a'],
      bodies: {
        'plan-a': JSON.stringify(
          validPlanDigest({ meta: { name: 'plan-a', stage: 'Plan prod', job: 'Plan', workingDirectory: 'environments/prod', createdIso: 'x' } })
        ),
      },
    });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    const out = html(tab);
    expect(out).toContain('<span class="summary-header-origin-label">Plan prod › Plan</span>');
    expect(out).toContain('<span class="summary-header-workdir">environments/prod</span>');
    expect(out).not.toContain('badge-untrusted');
  });

  it('shows download progress during the first load', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mockLoad({ planNames: ['fast', 'slow'], bodies: { fast: JSON.stringify(validPlanDigest()), slow: JSON.stringify(validPlanDigest()) } });
    const fetchMock = jest.fn(async (url: string) => {
      if (url.endsWith('/slow')) await gate;
      return { ok: true, text: async () => JSON.stringify(validPlanDigest()), headers: { get: () => null } };
    });
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;

    const tab = makeTestableTab();
    const loading = tab.loadAll(build);
    await flushUntil(() => html(tab).includes('(1 of 2)'));
    release();
    await loading;
    expect(html(tab)).not.toContain('Loading terraform results');
  });

  it('downloads at most four attachments at once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const names = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    const bodies: Record<string, string> = {};
    for (const name of names) bodies[name] = JSON.stringify(validPlanDigest());
    mockLoad({ planNames: names, bodies });
    let inFlight = 0;
    let peak = 0;
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await gate;
      inFlight--;
      return { ok: true, text: async () => JSON.stringify(validPlanDigest()), headers: { get: () => null } };
    });

    const tab = makeTestableTab();
    const loading = tab.loadAll(build);
    await flushUntil(() => inFlight === 4);
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(inFlight).toBe(4);
    release();
    await loading;
    expect(peak).toBe(4);
    expect(html(tab)).toContain('All plans (6)');
  });

  it('stops reading a body that streams past the parse ceiling, without a declared length', async () => {
    mockLoad({ planNames: ['huge'], bodies: {} });
    const chunk = new Uint8Array(6 * 1024 * 1024);
    let sent = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 4) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const textSpy = jest.fn();
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({ ok: true, body, text: textSpy, headers: { get: () => null } }));

    const tab = makeTestableTab();
    await tab.loadAll(build);
    expect(html(tab)).toMatch(/over the \d+-byte tab parse ceiling \(stopped reading after \d+ bytes\)/);
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThan(5);
    expect(textSpy).not.toHaveBeenCalled();
  });
});
