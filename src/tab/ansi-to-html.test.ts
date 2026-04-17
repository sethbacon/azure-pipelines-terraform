import { ansiToHtml, escapeHtml } from './ansi-to-html';

describe('escapeHtml', () => {
    it('escapes ampersands and angle brackets', () => {
        expect(escapeHtml('<div>&')).toBe('&lt;div&gt;&amp;');
    });

    it('passes plain text through unchanged', () => {
        expect(escapeHtml('hello world')).toBe('hello world');
    });
});

describe('ansiToHtml', () => {
    // --- Plain text ---

    it('returns plain text unchanged (HTML-escaped)', () => {
        expect(ansiToHtml('hello world')).toBe('hello world');
    });

    it('escapes HTML entities in plain text', () => {
        expect(ansiToHtml('<b>bold</b> & done')).toBe('&lt;b&gt;bold&lt;/b&gt; &amp; done');
    });

    it('handles empty string', () => {
        expect(ansiToHtml('')).toBe('');
    });

    // --- Single color codes ---

    it('wraps text in a color span and closes on reset', () => {
        const input = '\x1b[31mred text\x1b[0m';
        expect(ansiToHtml(input)).toBe('<span class="ansi-red">red text</span>');
    });

    it('handles bold code', () => {
        const input = '\x1b[1mbold\x1b[0m';
        expect(ansiToHtml(input)).toBe('<span class="ansi-bold">bold</span>');
    });

    it('handles grey (bright black) code 90', () => {
        const input = '\x1b[90mgrey\x1b[0m';
        expect(ansiToHtml(input)).toBe('<span class="ansi-grey">grey</span>');
    });

    // --- Multi-code sequences ---

    it('handles bold+red in a single escape sequence', () => {
        const input = '\x1b[1;31mbold red\x1b[0m';
        expect(ansiToHtml(input)).toBe(
            '<span class="ansi-bold"><span class="ansi-red">bold red</span></span>'
        );
    });

    it('handles multiple separate color sequences', () => {
        const input = '\x1b[32mgreen\x1b[0m then \x1b[34mblue\x1b[0m';
        expect(ansiToHtml(input)).toBe(
            '<span class="ansi-green">green</span> then <span class="ansi-blue">blue</span>'
        );
    });

    // --- Balanced tags ---

    it('auto-closes spans at end of input (no trailing reset)', () => {
        const input = '\x1b[31mred text without reset';
        expect(ansiToHtml(input)).toBe('<span class="ansi-red">red text without reset</span>');
    });

    it('auto-closes multiple nested spans at end of input', () => {
        const input = '\x1b[1;31mbold red no reset';
        expect(ansiToHtml(input)).toBe(
            '<span class="ansi-bold"><span class="ansi-red">bold red no reset</span></span>'
        );
    });

    it('does not emit extra </span> for reset when no span is open', () => {
        const input = '\x1b[0mtext after reset';
        expect(ansiToHtml(input)).toBe('text after reset');
    });

    it('reset closes all open spans at once', () => {
        const input = '\x1b[1m\x1b[31mbold red\x1b[0m normal';
        expect(ansiToHtml(input)).toBe(
            '<span class="ansi-bold"><span class="ansi-red">bold red</span></span> normal'
        );
    });

    // --- Unrecognized and non-SGR codes ---

    it('strips unrecognized SGR codes', () => {
        const input = '\x1b[48;5;196mextended color\x1b[0m';
        // 48, 5, 196 are not in the map — should be stripped but text preserved
        expect(ansiToHtml(input)).toBe('extended color');
    });

    it('strips non-SGR CSI sequences (e.g. cursor movement)', () => {
        const input = 'before\x1b[2Jafter';
        expect(ansiToHtml(input)).toBe('beforeafter');
    });

    it('strips cursor-position sequences', () => {
        const input = 'hello\x1b[H\x1b[2Jworld';
        expect(ansiToHtml(input)).toBe('helloworld');
    });

    // --- Bare reset / empty code ---

    it('treats bare ESC[m as reset (empty code list)', () => {
        const input = '\x1b[31mred\x1b[m normal';
        expect(ansiToHtml(input)).toBe('<span class="ansi-red">red</span> normal');
    });

    // --- Mixed content ---

    it('handles a realistic terraform plan snippet', () => {
        const input =
            '\x1b[1mTerraform will perform the following actions:\x1b[0m\n' +
            '\n' +
            '  \x1b[32m+\x1b[0m resource "aws_instance" "example" {\n' +
            '      \x1b[32m+\x1b[0m ami = \x1b[32m"ami-12345"\x1b[0m\n' +
            '    }\n' +
            '\n' +
            '\x1b[1mPlan:\x1b[0m 1 to add, 0 to change, 0 to destroy.';

        const result = ansiToHtml(input);

        // Verify no unbalanced tags
        const openCount = (result.match(/<span /g) || []).length;
        const closeCount = (result.match(/<\/span>/g) || []).length;
        expect(openCount).toBe(closeCount);

        // Verify key content is present
        expect(result).toContain('<span class="ansi-bold">Terraform will perform the following actions:</span>');
        expect(result).toContain('<span class="ansi-green">+</span>');
        expect(result).toContain('<span class="ansi-green">"ami-12345"</span>');
    });

    // --- Performance / large input ---

    it('handles large input without hanging', () => {
        const line = '\x1b[32m' + 'x'.repeat(1000) + '\x1b[0m\n';
        const input = line.repeat(1000);
        const start = Date.now();
        const result = ansiToHtml(input);
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(2000); // should complete well under 2s
        const openCount = (result.match(/<span /g) || []).length;
        const closeCount = (result.match(/<\/span>/g) || []).length;
        expect(openCount).toBe(closeCount);
        expect(openCount).toBe(1000);
    });
});
