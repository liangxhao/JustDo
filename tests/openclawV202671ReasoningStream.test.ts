import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, test } from 'vitest';

const patch = require('../scripts/patches/v2026.7.1-2/002-live-thinking-stream.cjs') as {
  applyPatch: (runtimeRoot: string) => string[];
  verifyPatch: (runtimeRoot: string) => void;
};

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('OpenClaw v2026.7.1-2 reasoning event callback independence', () => {
  test('pristine callback gate suppresses events and the rewrite preserves optional callback safety', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-reasoning-stream-'));
    temporaryRoots.push(runtimeRoot);
    const distDir = path.join(runtimeRoot, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'package.json'), '{"type":"module"}');
    const target = path.join(distDir, 'selection.js');
    fs.writeFileSync(
      target,
      `function subscribeEmbeddedAgentSession(params) {
  const reasoningMode = params.reasoningMode ?? "off";
  const canShowReasoning = params.thinkingLevel !== "off";
  const state = {
    streamReasoning: (params.streamReasoningInNonStreamModes === true ? reasoningMode !== "on" : reasoningMode === "stream") && canShowReasoning && typeof params.onReasoningStream === "function",
  };
  const events = [];
  const emitAgentEvent = (event) => events.push(event);
  const emitReasoningStream = (text) => {
    if (!state.streamReasoning) return;
    emitAgentEvent({ runId: params.runId, stream: "thinking", data: { text } });
    if (state.streamReasoning && params.onReasoningStream) params.onReasoningStream({ text });
  };
  emitReasoningStream("private chain");
  return { state, events };
}
export { subscribeEmbeddedAgentSession };
`,
    );

    const pristine = (await import(`${pathToFileURL(target).href}?pristine=${Date.now()}`)) as {
      subscribeEmbeddedAgentSession: (params: Record<string, unknown>) => {
        state: { streamReasoning: boolean };
        events: unknown[];
      };
    };
    expect(
      pristine.subscribeEmbeddedAgentSession({
        runId: 'run-1',
        reasoningMode: 'stream',
        thinkingLevel: 'high',
      }),
    ).toEqual({ state: { streamReasoning: false }, events: [] });

    expect(patch.applyPatch(runtimeRoot)).toEqual([path.join('dist', 'selection.js')]);
    patch.verifyPatch(runtimeRoot);
    const once = fs.readFileSync(target);
    const rewritten = (await import(`${pathToFileURL(target).href}?patched=${Date.now()}`)) as {
      subscribeEmbeddedAgentSession: (params: Record<string, unknown>) => {
        state: { streamReasoning: boolean };
        events: Array<{ stream: string }>;
      };
    };
    const result = rewritten.subscribeEmbeddedAgentSession({
      runId: 'run-1',
      reasoningMode: 'stream',
      thinkingLevel: 'high',
    });
    expect(result.state.streamReasoning).toBe(true);
    expect(result.events).toEqual([
      { runId: 'run-1', stream: 'thinking', data: { text: 'private chain' } },
    ]);

    const bundleTarget = path.join(runtimeRoot, 'gateway-bundle.mjs');
    fs.writeFileSync(
      bundleTarget,
      `function subscribeEmbeddedAgentSession(params) {
  const reasoningMode = params.reasoningMode ?? "off";
  const canShowReasoning = params.thinkingLevel !== "off";
  const state5 = {
    streamReasoning: (params.streamReasoningInNonStreamModes === true ? reasoningMode !== "on" : reasoningMode === "stream") && canShowReasoning && typeof params.onReasoningStream === "function",
  };
  const emitAgentEvent = (event) => event;
  const hasMessageToolOnlySourceDelivery2 = () => false;
  emitAgentEvent({ stream: "thinking" });
  if (state5.streamReasoning && !hasMessageToolOnlySourceDelivery2() && params.onReasoningStream) params.onReasoningStream({ text: "bundle" });
}
`,
    );

    expect(patch.applyPatch(runtimeRoot)).toEqual(['gateway-bundle.mjs']);
    patch.verifyPatch(runtimeRoot);
    const bundleOnce = fs.readFileSync(bundleTarget);
    expect(patch.applyPatch(runtimeRoot)).toEqual([]);
    expect(fs.readFileSync(target)).toEqual(once);
    expect(fs.readFileSync(bundleTarget)).toEqual(bundleOnce);
  });
});
