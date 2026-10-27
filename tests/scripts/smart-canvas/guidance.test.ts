import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JSDOM } from 'jsdom';
import { expect, test } from 'vitest';

import { resolveWebpageEmbedTarget } from '../../../src/main/chat/embed/webpageEmbedMounts';
import { previewFromEmbedShortcode } from '../../../src/renderer/libs/openclaw-chat/pipeline/embed-presentation';
import { scanEmbedShortcodes } from '../../../src/renderer/libs/openclaw-chat/pipeline/embed-shortcodes';

const deliveryExamples = fs.readFileSync(
  'plugins/extensions/smart-canvas/skills/visualize/references/delivery-examples.md',
  'utf8',
);
const html = deliveryExamples.match(/```html\s*([\s\S]*?)```/)?.[1];
const css = deliveryExamples.match(/```css\s*([\s\S]*?)```/)?.[1];
const stage = deliveryExamples.match(/```javascript\s*([\s\S]*?)```/)?.[1];

function resolveExample(source: string) {
  const segments = scanEmbedShortcodes(source);
  expect(segments).toHaveLength(1);
  const segment = segments[0];
  if (segment.type !== 'embed') throw new Error('Example must parse as an embed');
  return resolveWebpageEmbedTarget(
    previewFromEmbedShortcode(segment),
    'http://127.0.0.1:18789',
  );
}

test('published compact Widget arguments deliver a working counter without remote resources', () => {
  const examples = [...deliveryExamples.matchAll(/```json\s*([\s\S]*?)```/g)]
    .map(([, source]) => JSON.parse(source));
  expect(examples.length).toBeGreaterThan(0);
  for (const example of examples) {
    expect(example.kind).toBe('html');
    expect(typeof example.title).toBe('string');
    expect(typeof example.widget_code).toBe('string');
    expect(example.capabilities).toBeUndefined();
    expect(example.pin).toBeUndefined();
    const dom = new JSDOM(example.widget_code, { runScripts: 'dangerously' });
    try {
      expect(dom.window.document.querySelectorAll('script[src],img[src],link')).toHaveLength(0);
      const button = dom.window.document.querySelector('button')!;
      const output = dom.window.document.querySelector('output')!;
      expect(output.textContent).toBe('0');
      button.click();
      button.click();
      expect(output.textContent).toBe('2');
    } finally {
      dom.window.close();
    }
  }
});

test('published URL embeds resolve through the real parser', () => {
  const examples = [...deliveryExamples.matchAll(/```text\s*([\s\S]*?)```/g)]
    .map(([, source]) => source.trim());
  expect(examples.length).toBeGreaterThan(0);
  for (const source of examples) {
    const target = resolveExample(source);
    if (target.kind !== 'web') throw new Error('Expected the existing website');
    expect(new URL(target.url).protocol).toBe('https:');
  }
});

test('the hosted HTML example has a relative stylesheet and working local controls', () => {
  expect(html).toBeDefined();
  expect(css).toBeDefined();
  const dom = new JSDOM(html!, { runScripts: 'dangerously' });
  try {
    expect(dom.window.document.querySelector('link[rel="stylesheet"]')?.getAttribute('href'))
      .toBe('./styles.css');
    const input = dom.window.document.querySelector<HTMLInputElement>('input[type="range"]')!;
    const output = dom.window.document.querySelector('output')!;
    input.value = '7';
    input.dispatchEvent(new dom.window.Event('input'));
    expect(output.textContent).toBe('7');
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

test('the staging example publishes real relative files under fresh hosted refs', () => {
  expect(stage).toBeDefined();
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-guidance-'));
  try {
    const state = path.join(fixture, 'gateway-state');
    const authored = path.join(fixture, 'authored');
    fs.mkdirSync(state);
    fs.mkdirSync(authored);
    fs.writeFileSync(path.join(authored, 'index.html'), html!);
    fs.writeFileSync(path.join(authored, 'styles.css'), css!);
    const ids = new Set<string>();
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = spawnSync(process.execPath, ['-e', stage!], {
        cwd: authored,
        env: { ...process.env, OPENCLAW_STATE_DIR: state },
        encoding: 'utf8',
        windowsHide: true,
      });
      expect(result.status, result.stderr).toBe(0);
      const target = resolveExample(result.stdout.trim());
      if (target.kind !== 'hosted') throw new Error('Expected an actually staged document');
      expect(target.entryPath).toBe('index.html');
      ids.add(target.documentId);
      const destination = path.join(state, 'canvas/documents', target.documentId);
      expect(fs.readFileSync(path.join(destination, 'index.html'), 'utf8')).toBe(html);
      expect(fs.readFileSync(path.join(destination, 'styles.css'), 'utf8')).toBe(css);
    }
    expect(ids.size).toBe(2);
    const missingState = spawnSync(process.execPath, ['-e', stage!], {
      cwd: authored,
      env: { ...process.env, OPENCLAW_STATE_DIR: '' },
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(missingState.status).not.toBe(0);
    expect(missingState.stdout).toBe('');
    expect(fs.readdirSync(path.join(state, 'canvas/documents'))).toHaveLength(2);
  } finally {
    expect(path.dirname(fixture)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(fixture)).toMatch(/^canvas-guidance-/);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
