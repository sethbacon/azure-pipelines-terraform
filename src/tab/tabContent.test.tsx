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

const PLAN_SUMMARY_TYPE = 'terraform-plan-summary';
const APPLY_SUMMARY_TYPE = 'terraform-apply-summary';
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

function attachment(name: string) {
  return { name, _links: { self: { href: `https://example.test/${name}` } } };
}

/** Wires getClient(BuildRestClient).getAttachments to branch by attachment type, and fetch to return the given text bodies keyed by name. */
function mockLoad(options: {
  planNames?: string[];
  applyNames?: string[];
  legacyNames?: string[];
  bodies: Record<string, string>;
}) {
  const { planNames = [], applyNames = [], legacyNames = [], bodies } = options;

  (getClient as jest.Mock).mockReturnValue({
    getAttachments: jest.fn((_project: string, _id: number, type: string) => {
      if (type === PLAN_SUMMARY_TYPE) return Promise.resolve(planNames.map(attachment));
      if (type === APPLY_SUMMARY_TYPE) return Promise.resolve(applyNames.map(attachment));
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

  it('renders an empty state when nothing has been published', async () => {
    mockLoad({ bodies: {} });
    const tab = makeTestableTab();
    await tab.loadAll(build);
    expect(html(tab)).toContain('No terraform plans or applies have been published');
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
    // First item selected by default.
    expect(out).toContain('aws_instance.web');

    (tab as unknown as { onSelectPlan: (id: string) => void }).onSelectPlan('plan-b#1');
    out = html(tab);
    expect(out).toContain('aws_instance.other');
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

    (tab as unknown as { setActivePivot: (p: 'plan' | 'apply') => void }).setActivePivot('apply');
    expect(html(tab)).toContain('apply-a');
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

    (tab as unknown as { onSelectResource: (a: string) => void }).onSelectResource('aws_instance.web');
    out = html(tab);
    expect(out).not.toContain('resource-diff-table');
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
