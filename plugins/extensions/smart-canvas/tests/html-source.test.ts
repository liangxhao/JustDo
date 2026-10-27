import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { applyDocumentAttributes, prepareHtmlSource } from '../document/html-source';
import { SMART_CANVAS_IMAGE_SOURCE_ATTRIBUTE } from '../document/image-loading';

describe('authored HTML adaptation', () => {
  it('retains script, import-map and stylesheet bytes and order when removing document wrappers', () => {
    const head =
      '<title>Earth</title><style>body { background: #000 }</style><script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/three.js"}}</script>';
    const body =
      '<main id="earth"></main><script type="module">import * as THREE from "three"; const markup = "<body>inside script</body>";</script>';
    const result = prepareHtmlSource(
      `<!doctype html><html lang="zh"><head>${head}</head><body class="globe">${body}</body></html>`,
    );
    expect(result.html).toBe(head + body);
    expect(result.documentAttributes).toEqual([
      { target: 'html', attributes: [{ name: 'lang', value: 'zh' }] },
      { target: 'body', attributes: [{ name: 'class', value: 'globe' }] },
    ]);
  });

  it('keeps ordinary fragments, raw text, comments and template script contents intact', () => {
    const html =
      '<!-- <html> --><style>p:after{content:"</body>"}</style><div>&lt;html&gt;</div><script>const text = "<html></html>";</script><template><script>const text = "<head>";</script></template>';
    expect(prepareHtmlSource(html)).toEqual({ html, documentAttributes: [] });
  });

  it('holds parser-created img sources without rewriting JavaScript, CSS or other resource attributes', () => {
    const source =
      '<img id="cover" src="https://assets.example/earth.png?a=1&amp;b=2" alt="Earth"><script>const html = \'<img src="keep">\';</script><style>p{background:url("keep")}</style><script src="https://cdn.jsdelivr.net/code.js"></script>';
    const result = prepareHtmlSource(source);
    const dom = new JSDOM(result.html);
    try {
      const image = dom.window.document.querySelector('img')!;
      expect(image.hasAttribute('src')).toBe(false);
      expect(image.getAttribute(SMART_CANVAS_IMAGE_SOURCE_ATTRIBUTE)).toBe(
        'https://assets.example/earth.png?a=1&b=2',
      );
      expect(dom.window.document.querySelector('script[src]')?.getAttribute('src')).toBe(
        'https://cdn.jsdelivr.net/code.js',
      );
      expect(result.html).toContain('const html = \'<img src="keep">\';');
      expect(result.html).toContain('background:url("keep")');
    } finally {
      dom.window.close();
    }
  });

  it('preserves first-attribute HTML semantics for duplicate img src and processes template images', () => {
    const result = prepareHtmlSource(
      '<img src="https://assets.example/first" src="https://assets.example/second"><template><img src="data:image/png;base64,AA=="></template>',
    );
    const dom = new JSDOM(result.html);
    try {
      const image = dom.window.document.querySelector('img')!;
      expect(image.hasAttribute('src')).toBe(false);
      expect(image.getAttribute(SMART_CANVAS_IMAGE_SOURCE_ATTRIBUTE)).toBe(
        'https://assets.example/first',
      );
      const template = dom.window.document.querySelector('template')!;
      expect(template.content.querySelector('img')?.getAttribute('src')).toBe(
        'data:image/png;base64,AA==',
      );
    } finally {
      dom.window.close();
    }
  });

  it('keeps native image sources readable by immediately following author scripts', () => {
    const html =
      '<img id="native" src="data:image/png;base64,AA=="><script>window.originalSource = document.getElementById("native").getAttribute("src");</script>';
    const result = prepareHtmlSource(html);
    expect(result.html).toBe(html);
    const dom = new JSDOM(result.html, { runScripts: 'dangerously' });
    try {
      expect((dom.window as unknown as { originalSource: string }).originalSource).toBe(
        'data:image/png;base64,AA==',
      );
    } finally {
      dom.window.close();
    }
    for (const src of [
      'blob:https://assets.example/image',
      'http://assets.example/image',
      './image.png',
    ])
      expect(prepareHtmlSource(`<img src="${src}">`).html).toBe(`<img src="${src}">`);
  });

  it('applies authored html/body attributes inside the native-owned shell with a self-contained bootstrap', () => {
    const { documentAttributes } = prepareHtmlSource(
      '<html lang="zh"><body id="globe" data-label="&lt;/script&gt;" style="margin:0"><main>Earth</main></body></html>',
    );
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only',
    });
    try {
      dom.window.eval(
        `(${applyDocumentAttributes.toString()})(${JSON.stringify(documentAttributes)});`,
      );
      expect(dom.window.document.documentElement.lang).toBe('zh');
      expect(dom.window.document.body.id).toBe('globe');
      expect(dom.window.document.body.dataset.label).toBe('</script>');
      expect(dom.window.document.body.style.margin).toBe('0px');
    } finally {
      dom.window.close();
    }
  });
});
