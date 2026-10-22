import { describe, expect, it } from 'vitest';

import { renderMarkdownHtml } from '../conversation-overlay/modules/sidepanel-markdown.js';

describe('browser extension side panel markdown', () => {
  it('renders common message markdown', () => {
    const html = renderMarkdownHtml('# Result\n\n- **done**\n- `next`');

    expect(html).toContain('<h1>Result</h1>');
    expect(html).toContain('<strong>done</strong>');
    expect(html).toContain('<code>next</code>');
  });

  it('escapes raw html and rejects unsafe link protocols', () => {
    const html = renderMarkdownHtml('<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))');

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
  });

  it('opens safe links outside the side panel process', () => {
    const html = renderMarkdownHtml('[docs](https://example.com)');

    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
