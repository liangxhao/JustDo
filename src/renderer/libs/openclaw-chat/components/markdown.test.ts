// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';

import {
  findStableStreamingMarkdownBoundary,
  md,
  splitMarkdownFrontmatter,
  stripMarkdownFrontmatter,
  toSanitizedMarkdownHtml,
  toStreamingMarkdownHtml,
} from '@/libs/openclaw-chat/components/markdown';

describe('local HTML links', () => {
  test('decodes a relative HTML link with spaces and Chinese characters for the native file lookup', () => {
    const container = document.createElement('div');
    container.innerHTML = toSanitizedMarkdownHtml('[Report](<output/测试 report.html>)');
    expect(container.querySelector('a')?.getAttribute('data-local-html-path')).toBe(
      'output/测试 report.html',
    );
  });
  test.each([
    '[Report](output/report.html)',
    '[Report](file:///C:/project/report.html)',
    'C:\\project\\report.html',
    '/tmp/report.xhtml',
  ])('keeps %s clickable without a file navigation', source => {
    const container = document.createElement('div');
    container.innerHTML = toSanitizedMarkdownHtml(source);
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('data-local-html-path')).toBeTruthy();
    expect(anchor?.getAttribute('href')).toBe('#');
  });

  test.each([
    ['请打开 C:\\project\\report.html 然后查看结果。', 'C:\\project\\report.html'],
    ['See /tmp/report.html for the results.', '/tmp/report.html'],
    ['See file:///C:/project/report.html for the results.', 'file:///C:/project/report.html'],
    ['See C:\\project\\100%.html for the results.', 'C:\\project\\100%.html'],
    ['See /tmp/report#1.HTML for the results.', '/tmp/report#1.HTML'],
    ['See /tmp/report_name_copy.html for the results.', '/tmp/report_name_copy.html'],
    ['See C:\\project\\_site\\report.html for the results.', 'C:\\project\\_site\\report.html'],
    ['See /tmp/report.html#backup.html for the results.', '/tmp/report.html#backup.html'],
    ['/tmp/_report_.html', '/tmp/_report_.html'],
    ['File: C:\\project\\_site\\report.html', 'C:\\project\\_site\\report.html'],
    ['**C:\\project\\_site\\report.html**', 'C:\\project\\_site\\report.html'],
    ['See /tmp/notes.txt and C:\\project\\_site\\report.html', 'C:\\project\\_site\\report.html'],
  ])('links a bare HTML path inside a sentence: %s', (source, filePath) => {
    const container = document.createElement('div');
    container.innerHTML = toSanitizedMarkdownHtml(source);
    expect(container.querySelector('a')?.getAttribute('data-local-html-path')).toBe(filePath);
    expect(container.textContent?.trim()).toBe(source.replace(/^\*\*|\*\*$/gu, ''));
  });

  test.each([
    '[Section](output/report.html#chart)',
    '[Section](file:///C:/project/report.html#chart)',
  ])('keeps the HTML navigation suffix separate from the file lookup: %s', source => {
    const container = document.createElement('div');
    container.innerHTML = toSanitizedMarkdownHtml(source);
    expect(container.querySelector('a')?.getAttribute('data-local-html-path')).toMatch(
      /report\.html$/u,
    );
    expect(container.querySelector('a')?.getAttribute('data-local-html-suffix')).toBe('#chart');
  });

  test('does not link paths inside code or existing web links', () => {
    const container = document.createElement('div');
    container.innerHTML = toSanitizedMarkdownHtml(
      '`C:\\project\\report.html` [See /tmp/report.html](https://example.com/report.html) https://example.com/other.html',
    );
    expect(container.querySelectorAll('a')).toHaveLength(2);
    expect(container.querySelector('[data-local-html-path]')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('C:\\project\\report.html');
  });

  test.each([
    '[Bad](javascript:alert(1))',
    '[Bad](file://attacker.example/report.html)',
    '[Bad](file:///C:/secret.txt)',
  ])('does not admit an unsafe or non-HTML file link: %s', source => {
    const container = document.createElement('div');
    container.innerHTML = toSanitizedMarkdownHtml(source);
    expect(container.querySelector('a')?.getAttribute('data-local-html-path')).toBeFalsy();
    expect(container.querySelector('a')?.hasAttribute('href')).toBeFalsy();
  });
});

describe('Streaming fenced code', () => {
  test('renders an open code fence before the closing marker arrives', () => {
    const source = 'Example:\n\n```typescript\nconst answer = 42;';
    const streaming = document.createElement('div');
    streaming.innerHTML = toStreamingMarkdownHtml(source);
    expect(streaming.querySelector('.code-block-wrapper')).not.toBeNull();
    expect(streaming.querySelector('code')?.textContent).toContain('const answer = 42;');
    expect(streaming.querySelector('p')?.textContent).toBe('Example:');
    const completed = document.createElement('div');
    completed.innerHTML = toStreamingMarkdownHtml(`${source}\n\x60\x60\x60`);
    expect(completed.querySelectorAll('.code-block-wrapper')).toHaveLength(1);
    expect(completed.querySelector('code')?.textContent?.trim()).toBe(
      streaming.querySelector('code')?.textContent?.trim(),
    );
  });

  test('waits for the fence language line and keeps incomplete links literal', () => {
    expect(toStreamingMarkdownHtml('```type')).not.toContain('code-block-wrapper');
    expect(toStreamingMarkdownHtml('[Open](https://exam')).not.toContain('<a');
  });

  test('keeps an incomplete Mermaid diagram visible until its fence closes', () => {
    const source = '```mermaid\ngraph TD\nA -->';
    const container = document.createElement('div');
    container.innerHTML = toStreamingMarkdownHtml(source);
    expect(container.querySelector('.mermaid-block')).toBeNull();
    expect(container.textContent).toBe(source);

    container.innerHTML = toStreamingMarkdownHtml(`${source} B\n\x60\x60\x60`);
    expect(container.querySelector('.mermaid-block')).not.toBeNull();
    expect(container.querySelector('.mermaid-source code')?.textContent).toContain('A --> B');
  });

  test('keeps invalid backtick fence info literal while streaming', () => {
    const source = '```js`invalid\n**still incomplete';
    const container = document.createElement('div');
    container.innerHTML = toStreamingMarkdownHtml(source);
    expect(container.querySelector('.code-block-wrapper')).toBeNull();
    expect(container.textContent).toBe(source);
  });

  test('keeps HTML and Markdown inside a streaming fence as code', () => {
    const container = document.createElement('div');
    container.innerHTML = toStreamingMarkdownHtml(
      '~~~html\n<img src=x onerror=alert(1)>\n**literal**',
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('strong')).toBeNull();
    expect(container.querySelector('code')?.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

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

describe('HTML comments', () => {
  test('styles comment tokens only when the scoped preview option is enabled', () => {
    const source = 'Before\n\n<!-- openclaw:dreaming:diary:end -->\n\nAfter';

    const standard = toSanitizedMarkdownHtml(source);
    const styled = toSanitizedMarkdownHtml(source, { styleHtmlComments: true });

    expect(standard).not.toContain('markdown-html-comment');
    expect(styled).toContain('class="markdown-html-comment"');
    expect(styled).toContain('&lt;!-- openclaw:dreaming:diary:end --&gt;');
  });

  test('does not style escaped comments or comments inside code fences', () => {
    const escaped = toSanitizedMarkdownHtml('\\<!-- visible comment -->', {
      styleHtmlComments: true,
    });
    const fenced = toSanitizedMarkdownHtml('```html\n<!-- code comment -->\n```', {
      styleHtmlComments: true,
    });

    expect(escaped).not.toContain('markdown-html-comment');
    expect(fenced).not.toContain('markdown-html-comment');
  });
});

describe('large Markdown content', () => {
  test('falls back to plaintext without truncating the message', () => {
    const source = `head:${'x'.repeat(200_000)}:<tail>`;

    const html = toSanitizedMarkdownHtml(source);

    expect(html).toContain('head:');
    expect(html).toContain('&lt;tail&gt;');
    expect(html).not.toContain('truncated');
    expect(html.replace(/<br>\n?/g, '\n').replace(/^<pre>|<\/pre>$/g, '')).toContain(
      'x'.repeat(200_000),
    );
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
    const source = document.createElement('div');
    source.innerHTML = html;
    expect(source.querySelector('code')!.textContent).not.toContain('\\`\\`\\`');
    expect(source.querySelector<HTMLElement>('[data-code]')!.dataset.code).toContain('\\`\\`\\`');
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
    const source = document.createElement('div');
    source.innerHTML = html;
    expect(source.querySelector('code')!.textContent).not.toContain('\\\\`');
    expect(source.querySelector<HTMLElement>('[data-code]')!.dataset.code).toContain('\\\\`');
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

    expect(html).toContain(`<span class="code-block-lang">${language}</span>`);
    expect(html).toContain(`class="hljs language-${language === 'c++' ? 'cpp' : language}`);
    expect(html).toContain(highlightClass);
  });

  test('does not show a language label for an unlabelled fence', () => {
    const html = md.render('```\nplain text\n```');

    expect(html).not.toContain('code-block-lang');
  });

  test('renders an explicitly labelled language name in lowercase', () => {
    const html = md.render('```TypeScript\nconst answer = 42;\n```');

    expect(html).toContain('<span class="code-block-lang">typescript</span>');
    expect(html).not.toContain('<span class="code-block-lang">TypeScript</span>');
  });

  test('keeps unknown languages escaped and unhighlighted', () => {
    const html = md.render('```custom-lang\n<script>alert(1)</script>\n```');

    expect(html).toContain('language-custom-lang');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('class="hljs language-custom-lang');
  });
});
