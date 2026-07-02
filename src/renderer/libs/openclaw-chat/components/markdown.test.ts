import { describe, expect, test } from 'vitest';

import { md } from './markdown';

describe('LaTeX Markdown formulas', () => {
  test('renders inline formulas with KaTeX', () => {
    const html = md.render('Euler: $e^{i\\pi}+1=0$');

    expect(html).toContain('class="katex"');
    expect(html).toContain('Euler:');
  });

  test('renders block formulas with KaTeX', () => {
    const html = md.render('$$\n\\frac{a}{b}\n$$');

    expect(html).toContain('class="katex-display"');
    expect(html).toContain('class="katex"');
  });

  test('supports bracket delimiters', () => {
    const html = md.render('\\[x^2+y^2=z^2\\]');

    expect(html).toContain('class="katex-display"');
  });
});

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
