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

    const tab = new TerraformPlanTab({});
    const inst = tab as unknown as { state: Record<string, unknown> };
    // The instance is not mounted by a renderer, so apply setState synchronously
    // in place for the test.
    (tab as unknown as { setState: (u: unknown) => void }).setState = (update: unknown): void => {
      const next = typeof update === 'function' ? (update as (s: unknown) => object)(inst.state) : update;
      inst.state = { ...inst.state, ...(next as object) };
    };

    await tab.loadPlans({ project: { id: 'proj' }, id: 1 } as never);

    // Render the populated component to a static HTML string (no DOM required).
    const html = renderToStaticMarkup(tab.render());

    // Content is routed through ansiToHtml (HTML-escaped), not injected raw into
    // the dangerouslySetInnerHTML sink.
    expect(html).toContain(ansiToHtml(rawContent));
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});
