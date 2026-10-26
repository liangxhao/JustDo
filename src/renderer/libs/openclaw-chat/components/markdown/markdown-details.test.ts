// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';

import { i18nService } from '@/services/i18n';

import {
  findStableStreamingMarkdownBoundary,
  toSanitizedMarkdownHtml,
  toStreamingMarkdownHtml,
} from './markdown';

const detailsOptions = { allowDetails: true };
const renderers = {
  final: (source: string) => toSanitizedMarkdownHtml(source, detailsOptions),
  streaming: (source: string) => toStreamingMarkdownHtml(source, detailsOptions),
};

function fragment(html: string): HTMLDivElement {
  const container = document.createElement('div');
  container.innerHTML = html;
  return container;
}

describe('chat disclosure admission', () => {
  const source = '<details open>\n<summary>**More** `info`</summary>\n\nbody\n</details>';

  test('requires explicit message-body admission and isolates its cache', () => {
    for (const renderer of [toSanitizedMarkdownHtml, toStreamingMarkdownHtml]) {
      expect(fragment(renderer(source)).querySelector('details')).toBeNull();
      expect(fragment(renderer(source, detailsOptions)).querySelector('details')).not.toBeNull();
      expect(fragment(renderer(source)).querySelector('details')).toBeNull();
    }
  });

  test('never admits disclosures in progress-card mode', () => {
    const html = toSanitizedMarkdownHtml(`${source}\n\n<progress value="2" max="3"></progress>`, {
      ...detailsOptions,
      allowProgressElement: true,
    });
    expect(fragment(html).querySelector('details')).toBeNull();
    expect(fragment(html).querySelector('progress')).not.toBeNull();
  });

  test('preserves only the supported open attribute and renderer-owned class', () => {
    const root = fragment(toSanitizedMarkdownHtml(source, detailsOptions));
    expect(root.querySelector('details')?.className).toBe('markdown-disclosure');
    expect(root.querySelector('details')?.open).toBe(true);
    expect(root.querySelector('summary strong')?.textContent).toBe('More');
    expect(root.querySelector('summary code')?.textContent).toBe('info');
    const invalid = fragment(
      toSanitizedMarkdownHtml(
        '<details open="true" onclick="alert(1)">\nbody\n</details>',
        detailsOptions,
      ),
    );
    expect(invalid.querySelector('details')).toBeNull();
    expect(invalid.textContent).toContain('<details open="true" onclick="alert(1)">');
  });

  test.each(['<details>\nbody\n</details>', '<details><summary> </summary>body</details>'])(
    'provides a localized missing-label fallback: %s',
    source => {
      const root = fragment(toSanitizedMarkdownHtml(source, detailsOptions));
      expect(root.querySelector('summary')?.textContent?.trim()).toBe(
        i18nService.t('messageDetailsFallback'),
      );
      expect(root.querySelector('details')?.textContent).toContain('body');
    },
  );
});

for (const [mode, render] of Object.entries(renderers)) {
  describe(`${mode} disclosure structure`, () => {
    test('renders block markdown and nested disclosures without admitting raw HTML', () => {
      const root = fragment(
        render(
          [
            'Primary answer.',
            '',
            '<details open>',
            '',
            '<summary>Background</summary>',
            '',
            '**Bold**',
            '',
            '- one',
            '- two',
            '',
            '> quoted',
            '',
            '```ts',
            'const value = 1;',
            '```',
            '',
            '<details><summary>Inner</summary>inside</details>',
            '',
            '<script>nope</script>',
            '</details>',
            '',
            'Action outside.',
          ].join('\n'),
        ),
      );
      const details = root.querySelector('details');
      expect(root.firstElementChild?.textContent).toBe('Primary answer.');
      expect(details?.querySelector('strong')?.textContent).toBe('Bold');
      expect(details?.querySelectorAll('li')).toHaveLength(2);
      expect(details?.querySelector('blockquote')?.textContent?.trim()).toBe('quoted');
      expect(details?.querySelector('code.language-typescript')?.textContent).toContain(
        'const value = 1;',
      );
      expect(details?.querySelector('details')?.querySelector('summary')?.textContent).toBe(
        'Inner',
      );
      expect(details?.textContent).toContain('<script>nope</script>');
      expect(root.querySelector('script')).toBeNull();
      expect(root.lastElementChild?.textContent).toBe('Action outside.');
    });

    test('consumes summary content before considering nested tags', () => {
      const root = fragment(
        render(
          '<details><summary>Outer </details><details> label</summary><details><summary>Inner</summary>body</details>tail</details>\n\noutside\n\n',
        ),
      );
      expect(root.querySelectorAll('details')).toHaveLength(2);
      expect(root.querySelector('summary')?.textContent).toBe('Outer </details><details> label');
      expect(root.querySelector('details details')?.textContent).not.toContain('tail');
      expect(root.querySelector('details')?.textContent).not.toContain('outside');
    });

    test.each([
      '`<details><summary>code</summary>body</details>`',
      'prose <details><summary>inline</summary>body</details>',
      '- [ ] <details><summary>task</summary>body</details>',
      '\\<details>\n\\<summary>escaped</summary>',
      '    <details>\n    <summary>indented</summary>',
      '```html\n<details><summary>fenced</summary>body</details>\n```',
    ])('keeps code, escaped and non-block occurrences literal: %s', source => {
      const root = fragment(render(source));
      expect(root.querySelector('details')).toBeNull();
      expect(root.textContent).toContain('<details>');
    });

    test('ignores tag-shaped inline code and quoted HTML attributes on structural lines', () => {
      const root = fragment(
        render(
          '<details><summary>A</summary>`literal </details>` <span title="</details>">text</span> still inside</details>\n\noutside\n\n',
        ),
      );
      expect(root.querySelectorAll('details')).toHaveLength(1);
      expect(root.querySelector('details code')?.textContent).toBe('literal </details>');
      expect(root.querySelector('details')?.textContent).toContain('still inside');
      expect(root.querySelector('details')?.textContent).toContain('<span title="</details>">');
      expect(root.querySelector('details')?.textContent).not.toContain('outside');
    });

    test('keeps disclosure tags inside a multiline inline-code span literal', () => {
      const source = 'Here is `\n<details>\n<summary>code</summary>\n</details>\n` end.\n\n';
      const root = fragment(render(source));
      expect(root.querySelector('details')).toBeNull();
      expect(root.textContent).toContain('<summary>code</summary>');
      if (mode === 'final') expect(root.querySelector('code')?.textContent).toContain('<details>');
    });

    test('keeps multiline code closers inside their actual disclosure', () => {
      const source =
        '<details>\n<summary>A</summary>\n\nHere is `\n</details>\n` code.\n\nStill inside\n</details>\n\nOutside\n\n';
      const root = fragment(render(source));
      expect(root.querySelectorAll('details')).toHaveLength(1);
      expect(root.querySelector('details code')?.textContent).toContain('</details>');
      expect(root.querySelector('details')?.textContent).toContain('Still inside');
      expect(root.querySelector('details')?.textContent).not.toContain('Outside');
    });

    test.each(['"', "'"])('preserves multiline %s HTML attribute ownership', quote => {
      const source = `<details>\n<summary>A</summary>\n\n<div title=${quote}multiline\n</details>\n${quote}>x</div>\nStill inside\n</details>\n\nOutside\n\n`;
      const root = fragment(render(source));
      expect(root.querySelectorAll('details')).toHaveLength(1);
      expect(root.querySelector('details')?.textContent).toContain('</details>');
      expect(root.querySelector('details')?.textContent).toContain('Still inside');
      expect(root.querySelector('details')?.textContent).not.toContain('Outside');
    });

    test.each([
      '<pre>literal </details></pre>',
      '<script>const s="</details>"</script>',
      '<style>/* </details> */</style>',
      '<textarea>literal </details></textarea>',
      '<!-- literal </details> -->',
      '<?pi literal </details> ?>',
      '<![CDATA[literal </details>]]>',
    ])('retains raw HTML literal ownership on a structural line: %s', raw => {
      const root = fragment(
        render(`<details><summary>A</summary>${raw}still inside</details>\n\noutside\n\n`),
      );
      expect(root.querySelectorAll('details')).toHaveLength(1);
      expect(root.querySelector('details')?.textContent).toContain(raw);
      expect(root.querySelector('details')?.textContent).toContain('still inside');
      expect(root.querySelector('details')?.textContent).not.toContain('outside');
    });

    test.each([
      '<pre>\n</details>\n</pre>',
      '<!--\n</details>\n-->',
      '<script>\nconst s="</details>"\n</script>',
    ])('retains multiline raw HTML following a structural tag: %s', raw => {
      const root = fragment(
        render(`<details><summary>A</summary>${raw}\nstill inside\n</details>\n\noutside\n\n`),
      );
      expect(root.querySelectorAll('details')).toHaveLength(1);
      expect(root.querySelector('details')?.textContent).toContain('</details>');
      expect(root.querySelector('details')?.textContent).toContain('still inside');
      expect(root.querySelector('details')?.textContent).not.toContain('outside');
    });

    test.each(['script', 'pre'])(
      'does not pair raw %s backticks with later primary-answer code',
      tag => {
        const source = `<details>\n<summary>A</summary>\n\n<${tag}>const s = "\x60";</${tag}>\n</details>\nActual answer with \x60code\x60.\n\n`;
        const root = fragment(render(source));
        expect(root.querySelector('details')?.textContent).not.toContain('Actual answer');
        expect(root.querySelector('details')?.textContent).toContain('const s = "`";');
        expect(root.textContent).toContain('Actual answer');
      },
    );

    test('escapes duplicate and orphan summary tags', () => {
      const root = fragment(
        render(
          '<summary>Orphan</summary>\n<details><summary>First</summary>\n<summary>Second</summary>\nbody\n</details>\n\n',
        ),
      );
      expect(root.querySelectorAll('summary')).toHaveLength(1);
      expect(root.textContent).toContain('<summary>Orphan</summary>');
      expect(root.querySelector('details')?.textContent).toContain('<summary>Second</summary>');
    });

    test('keeps overflow tags balanced and literal without closing accepted ancestors', () => {
      const accepted = Array.from(
        { length: 32 },
        (_, index) => `<details><summary>Level ${index}</summary>`,
      ).join('\n');
      const source = `${accepted}\n<details>\n<summary>Overflow</summary>\noverflow\n</details>\nstill deepest\n${'</details>\n'.repeat(32)}\nOutside\n\n`;
      const root = fragment(render(source));
      const details = root.querySelectorAll('details');
      expect(details).toHaveLength(32);
      expect(details[31]?.textContent).toContain('<details>');
      expect(details[31]?.textContent).toContain('</details>');
      expect(details[31]?.textContent).toContain('still deepest');
      expect(details[0]?.textContent).not.toContain('Outside');
    });

    test('supports many siblings and same-line body content', () => {
      const source = Array.from(
        { length: 40 },
        (_, index) => `<details><summary>Sibling ${index}</summary>**body ${index}**</details>`,
      ).join('\n');
      const root = fragment(render(`${source}\n\nTrailing\n\n`));
      expect(root.querySelectorAll('details')).toHaveLength(40);
      expect(root.querySelectorAll('details strong')).toHaveLength(40);
      expect(root.lastElementChild?.textContent).toBe('Trailing');
    });

    test('recognizes a closer absorbed into a normal HTML block', () => {
      const root = fragment(
        render('<details>\n<summary>X</summary>\n\n<div>body</div>\n</details>\n\nFollowing\n\n'),
      );
      expect(root.querySelector('details')?.textContent).toContain('<div>body</div>');
      expect(root.querySelector('details')?.textContent).not.toContain('Following');
      expect(root.lastElementChild?.textContent).toBe('Following');
    });

    test.each([
      ['comment', '<!--\n</details>\n-->'],
      ['pre', '<pre>\n</details>\n</pre>'],
      ['script', '<script>\n</details>\n</script>'],
      ['style', '<style>\n</details>\n</style>'],
      ['textarea', '<textarea>\n</details>\n</textarea>'],
      ['processing instruction', '<?pi\n</details>\n?>'],
      ['declaration', '<!doctype\n</details>\n>'],
      ['CDATA', '<![CDATA[\n</details>\n]]>'],
    ])('retains raw %s ownership inside a disclosure', (_name, raw) => {
      const root = fragment(
        render(
          `<details>\n<summary>X</summary>\n\n<div>\n${raw}\n</div>\n\nStill inside\n</details>\n\nFollowing\n\n`,
        ),
      );
      expect(root.querySelector('details')?.textContent).toContain('</details>');
      expect(root.querySelector('details')?.textContent).toContain('Still inside');
      expect(root.querySelector('details')?.textContent).not.toContain('Following');
    });
  });
}

describe('streaming disclosure boundaries', () => {
  test('retains complete fences and blank paragraphs inside an unfinished disclosure', () => {
    const prefix = 'Intro\n\n';
    const body =
      '<details>\n<summary>Logs</summary>\n\n~~~ts\nconst value = 1;\n~~~\n\nstill streaming';
    expect(findStableStreamingMarkdownBoundary(prefix + body, detailsOptions)).toBe(prefix.length);
    const root = fragment(toStreamingMarkdownHtml(prefix + body, detailsOptions));
    expect(root.children).toHaveLength(2);
    expect(root.querySelector('details code')?.textContent).toContain('const value = 1;');
    expect(root.querySelector('details')?.textContent).toContain('still streaming');
    expect(root.textContent).not.toContain('</details>');
  });

  test('retires a completed disclosure before subsequent live prose', () => {
    const prefix = '<details><summary>Done</summary>fixed</details>\n\n';
    expect(findStableStreamingMarkdownBoundary(`${prefix}continuing **now`, detailsOptions)).toBe(
      prefix.length,
    );
    const root = fragment(toStreamingMarkdownHtml(`${prefix}continuing **now`, detailsOptions));
    expect(root.querySelector('details p')?.textContent).toBe('fixed');
    expect(root.lastElementChild?.textContent).toBe('continuing **now');
  });

  test.each([
    ['<details>\n<summary>Still arriving', 'Still arriving'],
    ['<details><summary>Outer</summary>\n<details><summary>Inner', 'Inner'],
  ])('repairs an eligible summary on the actual final line: %s', (source, label) => {
    const root = fragment(toStreamingMarkdownHtml(source, detailsOptions));
    const summaries = root.querySelectorAll('summary');
    expect(summaries[summaries.length - 1]?.textContent).toBe(label);
    expect(root.textContent).not.toContain('</summary>');
    // Final rendering must never adopt the streaming-only virtual closing tag.
    expect(fragment(toSanitizedMarkdownHtml(source, detailsOptions)).textContent).toContain(
      `<summary>${label}`,
    );
  });

  test.each([
    '<details>\n<summary>Literal\n',
    '<details>\n<summary>Earlier\nbody',
    '<summary>Orphan',
    '<details><summary>First</summary>\n<summary>Second',
    '<details>\n<!--\n<summary>Literal',
    '<details>\n<pre>\n<summary>Literal',
    '<details>\n\n    <summary>Literal',
  ])('keeps ineligible pending summaries literal: %s', source => {
    const root = fragment(toStreamingMarkdownHtml(source, detailsOptions));
    expect(root.textContent).toMatch(/<summary>(?:Literal|Earlier|Orphan|Second)/);
    expect(root.textContent).not.toContain('</summary>');
  });

  test.each([
    '- <details>\n  <summary>A</summary>\n\n  body\n  </details>\n  continuing',
    '> <details>\n> <summary>A</summary>\n>\n> still inside',
    '1.  item\n    <details>\n    <summary>A</summary>\n\n    still inside',
  ])('keeps disclosure containers intact while streaming: %s', source => {
    expect(findStableStreamingMarkdownBoundary(source, detailsOptions)).toBe(0);
    const root = fragment(toStreamingMarkdownHtml(source, detailsOptions));
    expect(root.children).toHaveLength(1);
    expect(root.querySelector('details summary')?.textContent).toBe('A');
  });

  test('shows an unfinished Mermaid source until the fence is complete inside a disclosure', () => {
    const source = '<details>\n<summary>Diagram</summary>\n\n```mermaid\ngraph TD\nA -->';
    const pending = fragment(toStreamingMarkdownHtml(source, detailsOptions));
    expect(pending.querySelector('.mermaid-block')).toBeNull();
    expect(pending.querySelector('details code')?.textContent).toContain('A -->');
    const completed = fragment(
      toStreamingMarkdownHtml(`${source} B\n\x60\x60\x60`, detailsOptions),
    );
    expect(completed.querySelector('details .mermaid-block')).not.toBeNull();
  });

  test.each([
    '> <details>\n> <summary>Diagram</summary>\n>\n> ```mermaid\n> graph TD\n> A --> B\n> ```\n>\n> still streaming',
    '- <details>\n  <summary>Diagram</summary>\n\n  ```mermaid\n  graph TD\n  A --> B\n  ```\n\n  still streaming',
  ])('recognizes a closed Mermaid fence in a disclosure Markdown container: %s', source => {
    const root = fragment(toStreamingMarkdownHtml(source, detailsOptions));
    expect(root.querySelector('details .mermaid-block')).not.toBeNull();
  });

  test.each(
    ['<!--', '<pre>'].flatMap(opener =>
      [`> ${opener}\n> **literal`, `- item\n\n  ${opener}\n  **literal`].map(raw => ({
        opener,
        raw,
      })),
    ),
  )('releases unfinished raw $opener ownership when its Markdown container ends', ({ raw }) => {
    const source = `<details>\n<summary>First</summary>\n\n${raw}\n\n</details>\n\n<details>\n<summary>Next`;
    const root = fragment(toStreamingMarkdownHtml(source, detailsOptions));
    const details = root.querySelectorAll('details');
    expect(details).toHaveLength(2);
    expect(details[0].textContent).toContain('**literal');
    expect(details[0].textContent).not.toContain('Next');
    expect(details[1].querySelector('summary')?.textContent).toBe('Next');
  });

  test('keeps large runs of closing-tag examples inside their code fence', () => {
    const literals = '</details>\n'.repeat(2000);
    const source = `<details><summary>Examples</summary>\n\n\x60\x60\x60html\n${literals}\x60\x60\x60\n\nStill inside`;
    const root = fragment(toStreamingMarkdownHtml(source, detailsOptions));
    expect(root.querySelectorAll('details')).toHaveLength(1);
    expect(root.querySelector('details code')?.textContent?.match(/<\/details>/g)).toHaveLength(
      2000,
    );
    expect(root.querySelector('details')?.textContent).toContain('Still inside');
  });

  test('keeps incomplete fence information visible inside a disclosure', () => {
    const source = '<details>\n<summary>Example</summary>\n\n```type';
    const root = fragment(toStreamingMarkdownHtml(source, detailsOptions));
    expect(root.querySelector('.code-block-wrapper')).toBeNull();
    expect(root.querySelector('details')?.textContent).toContain('```type');
  });

  test('keeps the complete oversized source literal before any disclosure parsing', () => {
    const source =
      '<details>\n<summary>Huge</summary>\n\n' + 'body\n\n'.repeat(7000) + '</details>';
    const root = fragment(toStreamingMarkdownHtml(source, detailsOptions));
    expect(root.querySelector('details')).toBeNull();
    expect(root.querySelector('.markdown-plain-text-fallback')?.textContent).toBe(source);
  });
});
