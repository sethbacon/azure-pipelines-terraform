/**
 * @jest-environment jsdom
 */

/*
 * Live-DOM tests for TerraformPlanTab: the behaviour here depends on real
 * re-renders, <details> toggle events and click handlers, which the
 * renderToStaticMarkup harness in tabContent.test.tsx cannot exercise.
 */

jest.mock('azure-devops-extension-sdk', () => ({
  init: jest.fn(),
  // Never resolves, so the module-level SDK.ready().then(...) bootstrap stays
  // inert; each test mounts its own TerraformPlanTab instead.
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

import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { getClient } from 'azure-devops-extension-api';
import { TerraformPlanTab } from './tabContent';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PLAN_SUMMARY_TYPE = 'terraform-plan-summary';
const build = { project: { id: 'proj' }, id: 1 } as never;

function planResource(i: number, attributeCount: number, valueChars: number): Record<string, unknown> {
  return {
    address: `aws_instance.web_${i}`,
    type: 'aws_instance',
    name: `web_${i}`,
    providerName: 'registry.terraform.io/hashicorp/aws',
    actions: ['create'],
    attributeChanges: Array.from({ length: attributeCount }, (_, j) => ({
      path: `tags.t${j}`,
      before: { kind: 'unknown' },
      after: { kind: 'value', json: JSON.stringify('v'.repeat(valueChars)) },
    })),
  };
}

function planDigestText(resources: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: 'plan',
    producedBy: { task: 'TerraformTaskV5', taskVersion: '5.12.0' },
    tool: { name: 'terraform', version: '1.14.6' },
    meta: { name: 'plan-main', createdIso: '2026-07-01T12:00:00.000Z' },
    truncated: false,
    summary: { add: resources.length, change: 0, destroy: 0, replace: 0, read: 0, noChanges: false, driftDetected: false },
    resources,
    outputChanges: [],
  });
}

/** Structurally valid, but over RawView's 2 MB inline-render cap — the reported repro used a 4.2 MB digest. */
const LARGE_PLAN = planDigestText(Array.from({ length: 30 }, (_, i) => planResource(i, 36, 3900)));
const SMALL_PLAN = planDigestText([planResource(0, 1, 8)]);

function mockPlanAttachments(bodies: Record<string, string>): void {
  (getClient as jest.Mock).mockReturnValue({
    getAttachments: jest.fn((_project: string, _id: number, type: string) =>
      Promise.resolve(
        type === PLAN_SUMMARY_TYPE
          ? Object.keys(bodies).map((name) => ({ name, _links: { self: { href: `https://example.test/${name}` } } }))
          : []
      )
    ),
  });
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn((url: string) => {
    const body = bodies[url.split('/').pop() as string];
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(body),
      headers: { get: (h: string) => (h === 'content-length' ? String(body.length) : null) },
    });
  });
}

let container: HTMLDivElement;
let root: Root;
let tab: TerraformPlanTab;
let createObjectURL: jest.Mock;
let revokeObjectURL: jest.Mock;

async function mountAndLoad(bodies: Record<string, string>): Promise<void> {
  mockPlanAttachments(bodies);
  const ref = React.createRef<TerraformPlanTab>();
  await act(async () => {
    root.render(<TerraformPlanTab ref={ref} />);
  });
  tab = ref.current as TerraformPlanTab;
  await act(async () => {
    await tab.loadAll(build);
  });
}

/** Types one character at a time, the way a user does: one React onChange (and one full tab re-render) per keystroke. */
function typeInto(input: HTMLInputElement, text: string): void {
  const setNativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  for (const ch of text) {
    act(() => {
      setNativeValue.call(input, input.value + ch);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
}

/** Clicks the expander's <summary> and waits for jsdom's queued `toggle` event to reach React. */
async function clickSummary(details: HTMLDetailsElement): Promise<void> {
  await act(async () => {
    (details.querySelector('summary') as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function rawDetails(): HTMLDetailsElement {
  return container.querySelector('details.raw-details') as HTMLDetailsElement;
}

function searchBox(): HTMLInputElement {
  return container.querySelector('input.resource-list-search') as HTMLInputElement;
}

beforeEach(() => {
  // jsdom implements neither; the tab must not need them until the user asks for a download.
  createObjectURL = jest.fn(() => 'blob:mock-download');
  revokeObjectURL = jest.fn();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('TerraformPlanTab in a live DOM', () => {
  it('creates no object URL while typing in the resource search over an oversized digest (reported: one leaked blob per keystroke)', async () => {
    expect(LARGE_PLAN.length).toBeGreaterThan(4 * 1024 * 1024);
    await mountAndLoad({ 'plan-large': LARGE_PLAN });

    typeInto(searchBox(), 'aws_instance.w'); // 14 keystrokes, 14 re-renders

    expect(searchBox().value).toBe('aws_instance.w');
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('does not render the raw digest body while its expander is closed', async () => {
    await mountAndLoad({ 'plan-large': LARGE_PLAN });

    expect(rawDetails().open).toBe(false);
    expect(rawDetails().querySelector('.raw-view, .plan-oversize')).toBeNull();
  });

  it('renders the raw digest as plain text once opened, and drops it again when closed', async () => {
    await mountAndLoad({ 'plan-small': SMALL_PLAN });

    await clickSummary(rawDetails());
    expect(rawDetails().open).toBe(true);
    const pre = rawDetails().querySelector('.raw-view pre') as HTMLPreElement;
    expect(pre.textContent).toBe(SMALL_PLAN);
    expect(pre.querySelector('span')).toBeNull(); // not routed through ansiToHtml

    await clickSummary(rawDetails());
    expect(rawDetails().open).toBe(false);
    expect(rawDetails().querySelector('.raw-view')).toBeNull();
  });

  it('opening an oversized raw digest offers a download that creates exactly one object URL, only on click, and revokes it', async () => {
    await mountAndLoad({ 'plan-large': LARGE_PLAN });
    await clickSummary(rawDetails());
    typeInto(searchBox(), 'web_1');
    expect(createObjectURL).not.toHaveBeenCalled();

    const anchorClicks: Array<{ href: string | null; download: string }> = [];
    jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      anchorClicks.push({ href: this.getAttribute('href'), download: this.download });
    });
    jest.useFakeTimers();

    act(() => (rawDetails().querySelector('.plan-oversize button') as HTMLButtonElement).click());

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchorClicks).toEqual([{ href: 'blob:mock-download', download: 'plan-large.txt' }]);
    jest.runOnlyPendingTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-download');
  });

  it('a reload of the same build keeps the open expander, the search text and the rendered selection', async () => {
    await mountAndLoad({ 'plan-small': SMALL_PLAN });
    typeInto(searchBox(), 'web');
    act(() => (container.querySelector('[data-testid="resource-row-aws_instance.web_0"]') as HTMLElement).click());
    await clickSummary(rawDetails());

    await act(async () => {
      await tab.loadAll(build); // onBuildChanged fires again as the build progresses
    });

    expect(searchBox().value).toBe('web');
    expect(container.querySelector('.resource-row.selected')?.textContent).toContain('aws_instance.web_0');
    expect(rawDetails().open).toBe(true);
    expect(rawDetails().querySelector('.raw-view pre')?.textContent).toBe(SMALL_PLAN);
  });
});
