/**
 * @jest-environment jsdom
 */

jest.mock('azure-devops-extension-sdk', () => ({
    init: jest.fn(),
    ready: jest.fn(() => Promise.resolve()),
    getAccessToken: jest.fn(() => Promise.resolve('fake-access-token')),
    getConfiguration: jest.fn(() => ({})),
}));

jest.mock('azure-devops-extension-api', () => ({
    getClient: jest.fn(),
}));

jest.mock('azure-devops-extension-api/Build', () => ({
    BuildRestClient: class {},
}));

import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { getClient } from 'azure-devops-extension-api';
import { TerraformPlanTab } from './tabContent';
import { ansiToHtml } from './ansi-to-html';

describe('TerraformPlanTab', () => {
    let container: HTMLDivElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        (global as unknown as { fetch: jest.Mock }).fetch = jest.fn();
    });

    afterEach(() => {
        document.body.removeChild(container);
        jest.clearAllMocks();
    });

    it('routes fetched plan content through ansiToHtml before it reaches the DOM', async () => {
        // A malicious/coloured attachment: raw HTML tag plus an ANSI SGR sequence.
        const rawContent = '<script>alert(1)</script>\x1b[31mred & <b>bold</b>\x1b[0m';

        (getClient as jest.Mock).mockReturnValue({
            getAttachments: jest.fn().mockResolvedValue([
                { name: 'plan.txt', _links: { self: { href: 'https://example.test/attachment' } } },
            ]),
        });

        ((global as unknown as { fetch: jest.Mock }).fetch).mockResolvedValue({
            ok: true,
            text: () => Promise.resolve(rawContent),
        });

        const root = ReactDOM.createRoot(container);
        const ref = React.createRef<TerraformPlanTab>();

        await act(async () => {
            root.render(<TerraformPlanTab ref={ref} />);
        });

        await act(async () => {
            await ref.current!.loadPlans({ project: { id: 'proj' }, id: 1 } as never);
        });

        const pre = container.querySelector('pre');
        expect(pre).not.toBeNull();

        // The rendered markup must be exactly the ansiToHtml-encoded output — not the raw content.
        expect(pre!.innerHTML).toBe(ansiToHtml(rawContent));

        // The raw <script> tag must never land in the DOM verbatim (proves it was HTML-escaped,
        // not injected as live markup via dangerouslySetInnerHTML).
        expect(container.querySelector('script')).toBeNull();
        expect(pre!.innerHTML).not.toContain('<script>');
        expect(pre!.innerHTML).toContain('&lt;script&gt;');
    });
});
