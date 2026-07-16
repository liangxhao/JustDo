import { describe, expect, test } from 'vitest';

import { md } from '@/libs/openclaw-chat/components/markdown';

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

describe('Nested Markdown fences', () => {
  test('renders markdown examples with escaped inner backtick fences', () => {
    const input = `\`\`\`markdown
# 技能名称 - 使用示例

## 描述
...

## 示例
\\\`\\\`\\\`
代码或步骤
\\\`\\\`\\\`

## 说明
...
\`\`\``;
    const html = md.render(input);

    expect(html).toContain('code-block-wrapper--markdown');
    expect(html).toContain('language-markdown');
    expect(html).toContain('code-language-markdown');
    expect(html).toContain('class="hljs');
    expect(html).toContain('# 技能名称 - 使用示例');
    expect(html).toContain('## 示例');
    expect(html).toContain('```');
    expect(html).not.toContain('\\`\\`\\`');
    expect(html).toContain('代码或步骤');
    expect(html).not.toContain('<h1>');
    expect(html).not.toContain('<h2>');
    expect(html.match(/code-block-wrapper/g)).toHaveLength(2);
  });

  test('normalizes repeated backslashes before inner markdown fences', () => {
    const html = md.render(`\`\`\`markdown
\\\\\`\\\\\`\\\\\`
代码或步骤
\\\\\`\\\\\`\\\\\`
\`\`\``);

    expect(html).toContain('```');
    expect(html).not.toContain('\\\\`');
  });
});

describe('Code fence syntax highlighting', () => {
  test.each([
    ['python', 'def greet(name):', 'hljs-keyword'],
    ['typescript', 'const answer: number = 42;', 'hljs-keyword'],
    ['c++', 'std::vector<int> values;', 'hljs-type'],
    ['powershell', 'Get-ChildItem | Where-Object { $_.Length -gt 0 }', 'hljs-built_in'],
  ])('highlights an explicitly labelled %s fence', (language, source, highlightClass) => {
    const html = md.render(`\`\`\`${language}\n${source}\n\`\`\``);

    expect(html).toContain(`class="hljs language-${language === 'c++' ? 'cpp' : language}`);
    expect(html).toContain(highlightClass);
  });

  test('keeps unknown languages escaped and unhighlighted', () => {
    const html = md.render('```custom-lang\n<script>alert(1)</script>\n```');

    expect(html).toContain('language-custom-lang');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('class="hljs language-custom-lang');
  });
});
