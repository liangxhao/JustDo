import fs from 'node:fs';

import { JSDOM } from 'jsdom';
import { expect, test } from 'vitest';

import { htmlPageContentKind } from '../../../plugins/extensions/smart-canvas/document/content-kind';
import { HTML_PAGE_KIND } from '../../../plugins/extensions/smart-canvas/document/contracts';
import { resolveWebpageEmbedTarget } from '../../../src/main/chat/embed/webpageEmbedMounts';
import { previewFromEmbedShortcode } from '../../../src/renderer/libs/openclaw-chat/pipeline/embed-presentation';
import { scanEmbedShortcodes } from '../../../src/renderer/libs/openclaw-chat/pipeline/embed-shortcodes';

const deliveryExamples = fs.readFileSync(
  'plugins/extensions/smart-canvas/skills/visualize/references/delivery-examples.md',
  'utf8',
);

test('published HTML page call uses raw markup accepted by the registered kind', () => {
  const reference = fs.readFileSync(
    'plugins/extensions/smart-canvas/skills/visualize/references/pinned-network.md',
    'utf8',
  );
  const examples = [...reference.matchAll(/```json\s*([\s\S]*?)```/g)];
  expect(examples).toHaveLength(1);
  for (const [, example] of examples) {
    const document = JSON.parse(example);
    expect(document.kind).toBe(HTML_PAGE_KIND);
    expect(document.pin).toBe(true);
    expect(document.widget_code).toContain('<img');
    expect(() => htmlPageContentKind.validateSource(document.widget_code)).not.toThrow();
  }
});

test('published Widget arguments contain actual source and the full HTML counter works', () => {
  const examples = [...deliveryExamples.matchAll(/```json\s*([\s\S]*?)```/g)]
    .map(([, source]) => JSON.parse(source));
  expect(examples.length).toBeGreaterThan(0);
  for (const example of examples) {
    expect(['html', HTML_PAGE_KIND]).toContain(example.kind);
    expect(typeof example.title).toBe('string');
    expect(typeof example.widget_code).toBe('string');
    if (example.kind === HTML_PAGE_KIND) {
      expect(() => htmlPageContentKind.validateSource(example.widget_code)).not.toThrow();
      const dom = new JSDOM(example.widget_code, { runScripts: 'dangerously' });
      try {
        const button = dom.window.document.querySelector('button')!;
        const output = dom.window.document.querySelector('output')!;
        expect(output.textContent).toBe('0');
        button.click();
        button.click();
        expect(output.textContent).toBe('2');
      } finally {
        dom.window.close();
      }
    } else {
      const dom = new JSDOM(example.widget_code);
      try {
        expect(dom.window.document.querySelector('svg[role="img"]')).not.toBeNull();
        expect(dom.window.document.querySelectorAll('script[src],img[src]')).toHaveLength(0);
      } finally {
        dom.window.close();
      }
    }
  }
});

test('published embed shortcodes resolve through the real parser and document layout', () => {
  const examples = [...deliveryExamples.matchAll(/```text\s*([\s\S]*?)```/g)]
    .map(([, source]) => source.trim()).filter(source => source.startsWith('[embed '));
  const stagedIds = new Set(
    [...deliveryExamples.matchAll(/<documentsRoot>\/([^/\r\n]+)\/index\.html/g)]
      .map(([, id]) => id),
  );
  expect(examples.length).toBeGreaterThan(0);
  for (const source of examples) {
    const segments = scanEmbedShortcodes(source);
    expect(segments).toHaveLength(1);
    const segment = segments[0];
    if (segment.type !== 'embed') throw new Error('Example must parse as an embed');
    const preview = previewFromEmbedShortcode(segment);
    const target = resolveWebpageEmbedTarget(preview, 'http://127.0.0.1:18789');
    if (target.kind === 'hosted') {
      expect(stagedIds.has(target.documentId)).toBe(true);
      expect(target.entryPath).toBe('index.html');
    } else {
      expect(new URL(target.url).protocol).toBe('https:');
    }
  }
});

test('the staged HTML example keeps its relative stylesheet and local details interaction', () => {
  const source = deliveryExamples.match(/```html\s*([\s\S]*?)```/)?.[1];
  expect(source).toBeDefined();
  const dom = new JSDOM(source!, { runScripts: 'dangerously' });
  try {
    expect(dom.window.document.querySelector('link[rel="stylesheet"]')?.getAttribute('href'))
      .toBe('./styles.css');
    const button = dom.window.document.querySelector<HTMLButtonElement>('button[aria-controls]')!;
    const details = dom.window.document.getElementById(button.getAttribute('aria-controls')!)!;
    expect(details.hidden).toBe(true);
    button.click();
    expect(details.hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    button.click();
    expect(details.hidden).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  } finally {
    dom.window.close();
  }
});
