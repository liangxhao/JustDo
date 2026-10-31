import { describe, expect, it } from 'vitest';

import { renderMarkdownHtml } from '../conversation-overlay/modules/sidepanel-markdown.js';

describe('browser extension side panel markdown', () => {
  it('renders disclosures with Markdown content and nested disclosures', () => {
    const html = renderMarkdownHtml('<details>\n<summary>**More**</summary>\n\n- item\n\n<details open>\n<summary>Nested</summary>\n\n`body`\n</details>\n</details>');

    expect(html).toContain('<details>');
    expect(html).toContain('<summary><strong>More</strong></summary>');
    expect(html).toContain('<li>item</li>');
    expect(html).toContain('<details open>');
    expect(html).toContain('<code>body</code>');
    expect(html.match(/<\/details>/g)).toHaveLength(2);
  });

  it('strips disclosure attributes while escaping other HTML and code examples', () => {
    const html = renderMarkdownHtml('<details onclick="alert(1)" style="color:red">\n<summary onmouseover="alert(2)">Title</summary>\n\n<img src=x onerror=alert(3)>\n</details>\n\n`<details>`\n\n```xml\n<details>\n<summary>example</summary>\n</details>\n```');

    expect(html).toContain('<details>');
    expect(html).toContain('<summary>Title</summary>');
    expect(html).not.toContain('onclick=');
    expect(html).not.toContain('onmouseover=');
    expect(html).not.toContain('<img');
    expect(html).toContain('<code>&lt;details&gt;</code>');
    expect(html).toContain('&lt;summary&gt;example&lt;/summary&gt;');
  });

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
