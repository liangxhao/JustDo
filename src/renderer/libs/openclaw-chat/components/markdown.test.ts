// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';

import {
  findStableStreamingMarkdownBoundary,
  md,
  splitMarkdownFrontmatter,
  stripMarkdownFrontmatter,
  toSanitizedMarkdownHtml,
} from '@/libs/openclaw-chat/components/markdown';

describe('Progress card Markdown', () => {
  test('allows only the scoped progress element extension', () => {
    const source =
      '<progress value="3" max="7" class="evil" hidden style="position:fixed;inset:0;background:url(https://example.test/pixel)" title="unsafe" onclick="alert(1)"></progress><script>alert(2)</script>';

    const standard = toSanitizedMarkdownHtml(source);
    const progressCard = toSanitizedMarkdownHtml(source, { allowProgressElement: true });

    expect(standard).not.toContain('<progress');
    const container = document.createElement('div');
    container.innerHTML = progressCard;
    const progress = container.querySelector('progress');
    expect(progress?.getAttribute('value')).toBe('3');
    expect(progress?.getAttribute('max')).toBe('7');
    expect(progress?.getAttribute('aria-label')).toBeTruthy();
    expect(progressCard).not.toContain('onclick');
    expect(progressCard).not.toContain('class=');
    expect(progressCard).not.toContain('style=');
    expect(progressCard).not.toContain('hidden');
    expect(progressCard).not.toContain('title=');
    expect(progressCard).not.toContain('example.test');
    expect(progressCard).not.toContain('<script');
  });

  test('does not allow progress-only attributes on other elements', () => {
    const html = toSanitizedMarkdownHtml('<input value="secret" max="7">', {
      allowProgressElement: true,
    });

    expect(html).not.toContain('value=');
    expect(html).not.toContain('max=');
  });
});

describe('Markdown front matter', () => {
  test('strips a YAML front matter block from document previews', () => {
    const source = ['---', 'name: example', 'description: A test', '---', '', '# Content'].join(
      '\n',
    );

    expect(stripMarkdownFrontmatter(source)).toBe('# Content');
    expect(splitMarkdownFrontmatter(source)).toEqual({
      frontmatter: 'name: example\ndescription: A test',
      body: '# Content',
    });
  });

  test('supports BOM-prefixed front matter and YAML document terminators', () => {
    expect(stripMarkdownFrontmatter('\uFEFF---\nname: example\n...\n正文')).toBe('正文');
  });

  test('keeps Markdown without a complete front matter block unchanged', () => {
    const source = '---\nThis is a horizontal rule, not front matter.';

    expect(stripMarkdownFrontmatter(source)).toBe(source);
  });
});

describe('Markdown autolinks', () => {
  test.each(['，', '。', '；', '！', '？', '、'])(
    'ends a bare URL before the CJK punctuation %s',
    punctuation => {
      const html = md.render(`详情见 https://docs.openclaw.ai/tools/skills${punctuation}后续正文`);

      expect(html).toContain(
        '<a href="https://docs.openclaw.ai/tools/skills">https://docs.openclaw.ai/tools/skills</a>',
      );
      expect(html).toContain(`${punctuation}后续正文`);
      expect(html).not.toContain(encodeURIComponent(punctuation));
    },
  );

  test('does not rewrite an explicit Markdown link containing CJK punctuation', () => {
    const html = md.render('[示例](https://example.com/search?q=中文，测试)');

    expect(html).toContain(
      '<a href="https://example.com/search?q=%E4%B8%AD%E6%96%87%EF%BC%8C%E6%B5%8B%E8%AF%95">示例</a>',
    );
  });
});

describe('Markdown emphasis', () => {
  test.each([
    ['ASCII double quotes', '**"xxxx"**这种', '&quot;xxxx&quot;'],
    ['curly double quotes', '**“xxxx”**这种', '“xxxx”'],
  ])('renders strong text wrapped in %s next to CJK text', (_description, source, text) => {
    const html = md.render(source);

    expect(html).toContain(`<strong>${text}</strong>这种`);
  });

  test('preserves inline Markdown inside quote-wrapped strong text', () => {
    const html = md.render('**"use `code`"**这种');

    expect(html).toContain('<strong>&quot;use <code>code</code>&quot;</strong>这种');
  });

  test('ignores apparent closing markers inside code spans', () => {
    const html = md.render('**"use `"**` now"**这种');

    expect(html).toContain('<strong>&quot;use <code>&quot;**</code> now&quot;</strong>这种');
  });

  test('does not parse quote-wrapped strong syntax inside code spans', () => {
    const html = md.render('`**"xxxx"**这种`');

    expect(html).toContain('<code>**&quot;xxxx&quot;**这种</code>');
    expect(html).not.toContain('<strong>');
  });

  test('does not hide closing brackets while scanning Markdown link labels', () => {
    const html = md.render('[**"x]y"**这种](https://e.test)');

    expect(html).not.toContain('<a href="https://e.test"><strong>');
    expect(html).toContain('[<strong>&quot;x]y&quot;</strong>这种](');
  });

  test('keeps standard CommonMark behavior when the following text is not CJK', () => {
    const html = md.render('**"xxxx"**bar');

    expect(html).not.toContain('<strong>');
    expect(html).toContain('**&quot;xxxx&quot;**bar');
  });
});

describe('Markdown tables', () => {
  test('wraps a table in a horizontal scroll container', () => {
    const html = md.render('| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |');

    expect(html).toContain('<div class="markdown-table-scroll"><table>');
    expect(html).toContain('</table></div>');
  });
});

describe('Markdown images', () => {
  test('marks inline images as enlargeable and shows the localized interaction hint', () => {
    const html = md.render('![detail](data:image/png;base64,AA==)');

    expect(html).toContain('class="markdown-inline-image"');
    expect(html).toContain('title="双击放大查看"');
  });
});

describe('Box-drawing diagrams', () => {
  test('renders unfenced multiline diagrams in a literal text container', () => {
    const source = ['┌────┐', '│ AB │', '└────┘'].join('\n');

    const html = md.render(source);

    expect(html).toContain('class="markdown-box-drawing-diagram"');
    expect(html).toContain(source);
    expect(html).not.toContain('<br>');
  });

  test('escapes HTML while preserving diagram text', () => {
    const source = '┌────┐\n│ <img src=x onerror=alert(1)> │\n└────┘';

    const html = md.render(source);

    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
  });

  test('keeps ordinary prose containing a box-drawing character unchanged', () => {
    const html = md.render('用 │ 表示垂直连线。');

    expect(html).not.toContain('markdown-box-drawing-diagram');
  });

  test('preserves Markdown around an independent diagram block', () => {
    const html = md.render(
      '# 标题\n正文 [链接](https://example.com)\n┌────┐\n│ AB │\n└────┘\n- 列表项',
    );

    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain('<a href="https://example.com">链接</a>');
    expect(html).toContain('class="markdown-box-drawing-diagram"');
    expect(html).toContain('<li>列表项</li>');
  });

  test('does not reinterpret a fenced code block containing box-drawing characters', () => {
    const html = md.render('```text\n┌────┐\n│ AB │\n└────┘\n```');

    expect(html).toContain('class="code-block-wrapper"');
    expect(html).toContain('class="markdown-box-drawing-code"');
    expect(html).not.toContain('markdown-box-drawing-diagram');
  });

  test('marks indented code blocks containing a complete diagram', () => {
    const source = '    ┌────┐\n    │ AB │\n    └────┘';
    const boundary = findStableStreamingMarkdownBoundary(source);
    const html = md.render(source.slice(0, boundary));

    expect(boundary).toBe(source.length);
    expect(html).toContain('class="markdown-box-drawing-code"');
  });

  test('keeps ordinary fenced code on the regular code font path', () => {
    const html = md.render('```typescript\nconst answer = 42;\n```');

    expect(html).not.toContain('markdown-box-drawing-code');
  });

  test('does not reinterpret incomplete box-drawing prose', () => {
    const html = md.render('符号示例：\n┌ ─ ┐\n这不是完整框图。');

    expect(html).not.toContain('markdown-box-drawing-diagram');
  });

  test('uses the diagram block after a complete frame finishes streaming', () => {
    const source = '┌────┐\n│ AB │\n└────┘';

    const boundary = findStableStreamingMarkdownBoundary(source);
    const html = md.render(source.slice(0, boundary));

    expect(boundary).toBe(source.length);
    expect(html).toContain('class="markdown-box-drawing-diagram"');
    expect(html).toContain(source);
    expect(html).not.toContain('markdown-plain-text-fallback');
  });
});

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
    ['an explicitly labelled JSON fence', '```json\n{"answer": 42}\n```'],
    ['an unlabelled JSON-shaped fence', '```\n{"answer": 42}\n```'],
  ])('renders %s expanded', (_description, source) => {
    const html = md.render(source);

    expect(html).toContain('class="code-block-wrapper"');
    expect(html).toContain('<pre><code');
    expect(html).not.toContain('<details');
    expect(html).not.toContain('json-collapse');
  });

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
