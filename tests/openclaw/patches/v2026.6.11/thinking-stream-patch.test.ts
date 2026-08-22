import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { applyPatch } = require('../../../../scripts/patches/v2026.6.11/001-thinking-stream.cjs') as {
  applyPatch: (runtimeDir: string) => string[];
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('001-thinking-stream runtime patch', () => {
  it('adds a bounded thinking preview to websocket diagnostics', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-thinking-patch-'));
    tempDirs.push(runtimeDir);
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(
      bundlePath,
      `const state = {
  streamReasoning: reasoningMode === "stream" && canShowReasoning && typeof params.onReasoningStream === "function"
};
function summarizeAgentEventForWsLog(payload) {
  const stream3 = payload.stream;
  const data = payload.data;
  const extra = {};
  if (stream3 === "assistant") return extra;
  if (stream3 === "tool") {
    return extra;
  }
  return extra;
}
`,
      'utf8',
    );

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    const patched = fs.readFileSync(bundlePath, 'utf8');
    expect(patched).toContain('streamReasoning: reasoningMode === "stream" && canShowReasoning');
    expect(patched).toContain('if (stream3 === "thinking")');
    expect(patched).toContain('extra.text = compactPreview(text2, 80)');
    expect(applyPatch(runtimeDir)).toEqual([]);
  });

  it('fails visibly when the websocket summary shape has changed', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-thinking-patch-'));
    tempDirs.push(runtimeDir);
    fs.writeFileSync(
      path.join(runtimeDir, 'gateway-bundle.mjs'),
      `function summarizeAgentEventForWsLog(payload) {
  return payload;
}
`,
      'utf8',
    );

    expect(() => applyPatch(runtimeDir)).toThrow('Thinking WS log preview target not found');
  });

  it('patches the tab-indented standalone websocket log module', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-thinking-patch-'));
    const distDir = path.join(runtimeDir, 'dist');
    tempDirs.push(runtimeDir);
    fs.mkdirSync(distDir);
    const modulePath = path.join(distDir, 'ws-log.js');
    fs.writeFileSync(
      modulePath,
      `function summarizeAgentEventForWsLog(payload) {
\tconst stream = payload.stream;
\tconst data = payload.data;
\tconst extra = {};
\tif (stream === "assistant") return extra;
\tif (stream === "tool") {
\t\treturn extra;
\t}
\treturn extra;
}
`,
      'utf8',
    );

    expect(applyPatch(runtimeDir)).toEqual([path.join('dist', 'ws-log.js')]);
    const patched = fs.readFileSync(modulePath, 'utf8');
    expect(patched).toContain('if (stream === "thinking")');
    expect(patched).toContain('extra.text = compactPreview(text, 80)');
    expect(applyPatch(runtimeDir)).toEqual([]);
  });
});
