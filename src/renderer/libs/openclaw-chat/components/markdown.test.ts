import { describe, expect, test } from 'vitest';

import { md } from './markdown';

describe('Mermaid Markdown fences', () => {
  test('renders a diagram preview by default and retains the source for toggling', () => {
    const html = md.render('```mermaid\ngraph TD\n  A --> B\n```');

    expect(html).toContain('class="code-block-wrapper mermaid-block"');
    expect(html).toContain('class="mermaid-preview"');
    expect(html).toContain('class="mermaid-source" hidden');
    expect(html).toContain('<span class="hljs-keyword">graph</span>');
    expect(html).toContain('<span class="hljs-built_in">TD</span>');
    expect(html).toContain('<span class="hljs-symbol">--&gt;</span>');
    expect(html).toContain('class="mermaid-toggle"');
  });
});
