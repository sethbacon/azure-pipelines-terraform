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
import { ansiToHtml } from './ansi-to-html';

/**
 * Creates an unmounted TerraformPlanTab with setState monkey-patched to merge
 * synchronously into the instance's own state — a real (unmounted) component's
 * setState is a no-op (there is no updater attached outside a live React tree),
 * which is why every test that exercises state transitions needs this. An
 * optional partial state can be applied up front for render-only fixtures.
 */
function makeTestableTab(initialState: Record<string, unknown> = {}): TerraformPlanTab {
  const tab = new TerraformPlanTab({});
  const inst = tab as unknown as { state: Record<string, unknown> };
  inst.state = { ...inst.state, ...initialState };
  (tab as unknown as { setState: (u: unknown) => void }).setState = (update: unknown): void => {
    const next = typeof update === 'function' ? (update as (s: unknown) => object)(inst.state) : update;
    inst.state = { ...inst.state, ...(next as object) };
  };
  return tab;
}

describe('TerraformPlanTab', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('routes fetched plan content through ansiToHtml before rendering (no raw HTML injected)', async () => {
    // A malicious/coloured attachment: raw HTML tag plus an ANSI SGR sequence.
    const rawContent = '<script>alert(1)</script>\x1b[31mred & <b>bold</b>\x1b[0m';

    (getClient as jest.Mock).mockReturnValue({
      getAttachments: jest.fn().mockResolvedValue([
        { name: 'plan.txt', _links: { self: { href: 'https://example.test/attachment' } } },
      ]),
    });

    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(rawContent),
    });

    const tab = makeTestableTab();

    await tab.loadPlans({ project: { id: 'proj' }, id: 1 } as never);

    // Render the populated component to a static HTML string (no DOM required).
    const html = renderToStaticMarkup(tab.render());

    // Content is routed through ansiToHtml (HTML-escaped), not injected raw into
    // the dangerouslySetInnerHTML sink.
    expect(html).toContain(ansiToHtml(rawContent));
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('renders a loading indicator before any plans have been fetched', () => {
    const tab = makeTestableTab();
    const html = renderToStaticMarkup(tab.render());
    expect(html).toContain('Loading terraform plans...');
  });

  it('renders an error message when loading the attachments failed', () => {
    const tab = makeTestableTab({ loading: false, error: 'boom' });
    const html = renderToStaticMarkup(tab.render());
    expect(html).toContain('Error: boom');
  });

  it('renders an empty-state message when the build published no plans', () => {
    const tab = makeTestableTab({ loading: false, error: null, plans: [] });
    const html = renderToStaticMarkup(tab.render());
    expect(html).toContain('No terraform plans have been published for this pipeline run.');
  });

  it('renders a <select> plan picker for multiple plans, and onPlanSelect updates the selected index', () => {
    const tab = makeTestableTab({
      loading: false,
      error: null,
      plans: [
        { name: 'plan-a.txt', content: 'aaa' },
        { name: 'plan-b.txt', content: 'bbb' },
      ],
      selectedIndex: 0,
    });

    const html = renderToStaticMarkup(tab.render());
    expect(html).toContain('<select');
    expect(html).toContain('plan-a.txt');
    expect(html).toContain('plan-b.txt');

    (tab as unknown as { onPlanSelect: (e: unknown) => void }).onPlanSelect({ target: { value: '1' } });
    expect((tab as unknown as { state: { selectedIndex: number } }).state.selectedIndex).toBe(1);
  });

  it('renders a download link instead of inline output when plan content exceeds the render-size cap', () => {
    const oversized = 'x'.repeat(2 * 1024 * 1024 + 1);
    const tab = makeTestableTab({
      loading: false,
      error: null,
      plans: [{ name: 'huge-plan.txt', content: oversized }],
      selectedIndex: 0,
    });

    const html = renderToStaticMarkup(tab.render());
    expect(html).toContain('too large to render inline');
    expect(html).toContain('Download raw output');
    expect(html).not.toContain('dangerouslySetInnerHTML');
  });

  it('loadPlans sets an empty plans list and stops loading when the build has no attachments', async () => {
    (getClient as jest.Mock).mockReturnValue({
      getAttachments: jest.fn().mockResolvedValue([]),
    });

    const tab = makeTestableTab();
    await tab.loadPlans({ project: { id: 'proj' }, id: 1 } as never);

    const state = (tab as unknown as { state: { plans: unknown[]; loading: boolean } }).state;
    expect(state.plans).toEqual([]);
    expect(state.loading).toBe(false);
  });

  it('loadPlans skips an attachment whose download throws and one that returns a non-OK response, keeping only the successful download', async () => {
    (getClient as jest.Mock).mockReturnValue({
      getAttachments: jest.fn().mockResolvedValue([
        { name: 'network-error.txt', _links: { self: { href: 'https://example.test/a' } } },
        { name: 'not-found.txt', _links: { self: { href: 'https://example.test/b' } } },
        { name: 'ok.txt', _links: { self: { href: 'https://example.test/c' } } },
      ]),
    });

    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => { /* silence expected log */ });

    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ ok: false, text: () => Promise.resolve('') })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('plan output') });

    const tab = makeTestableTab();
    await tab.loadPlans({ project: { id: 'proj' }, id: 1 } as never);

    const state = (tab as unknown as { state: { plans: Array<{ name: string }>; loading: boolean } }).state;
    expect(state.plans).toHaveLength(1);
    expect(state.plans[0].name).toBe('ok.txt');
    expect(state.loading).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to download attachment network-error.txt:'),
      expect.any(Error),
    );

    consoleErrorSpy.mockRestore();
  });

  it('loadPlans sets an error state when fetching the attachment list itself fails', async () => {
    (getClient as jest.Mock).mockReturnValue({
      getAttachments: jest.fn().mockRejectedValue(new Error('attachments API unavailable')),
    });

    const tab = makeTestableTab();
    await tab.loadPlans({ project: { id: 'proj' }, id: 1 } as never);

    const state = (tab as unknown as { state: { error: string | null; loading: boolean } }).state;
    expect(state.error).toBe('attachments API unavailable');
    expect(state.loading).toBe(false);
  });
});
