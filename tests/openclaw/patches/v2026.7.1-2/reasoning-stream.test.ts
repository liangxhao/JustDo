import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, test } from 'vitest';

const patch = require('../../../../scripts/patches/v2026.7.1-2/002-live-thinking-stream.cjs') as {
  applyPatch: (runtimeRoot: string) => string[];
  verifyPatch: (runtimeRoot: string) => void;
};

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('OpenClaw v2026.7.1-2 live reasoning delivery', () => {
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
    const agentCommandTarget = path.join(distDir, 'agent-command.js');
    fs.writeFileSync(
      agentCommandTarget,
      `function agentCommandFixture() {
  const requestedThinkLevel = thinkOnce ?? thinkOverride ?? persistedThinking;
  const resolvedVerboseLevel = verboseOverride ?? persistedVerbose ?? agentCfg?.verboseDefault;
  return runAgentAttempt({
    resolvedThinkLevel: candidateThinkLevel,
    fastMode,
  });
}
`,
    );
    const attemptExecutionTarget = path.join(distDir, 'attempt-execution.js');
    fs.writeFileSync(
      attemptExecutionTarget,
      `function runAgentAttempt(params) {
  return runEmbeddedAgent({
    thinkLevel: params.resolvedThinkLevel,
    fastMode: params.fastMode,
  });
}
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

    expect(patch.applyPatch(runtimeRoot)).toEqual([
      path.join('dist', 'selection.js'),
      path.join('dist', 'agent-command.js'),
      path.join('dist', 'attempt-execution.js'),
    ]);
    patch.verifyPatch(runtimeRoot);
    const once = fs.readFileSync(target);
    const agentCommandOnce = fs.readFileSync(agentCommandTarget);
    const attemptExecutionOnce = fs.readFileSync(attemptExecutionTarget);
    expect(agentCommandOnce.toString()).toContain(
      'const resolvedReasoningLevel = sessionEntry?.reasoningLevel ?? resolveAgentConfig(',
    );
    expect(agentCommandOnce.toString()).toContain(
      'resolvedThinkLevel: candidateThinkLevel,\n    resolvedReasoningLevel,',
    );
    expect(attemptExecutionOnce.toString()).toContain(
      'thinkLevel: params.resolvedThinkLevel,\n    reasoningLevel: params.resolvedReasoningLevel,',
    );
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
function agentCommandFixture() {
  const requestedThinkLevel = thinkOnce ?? thinkOverride ?? persistedThinking;
  const resolvedVerboseLevel = verboseOverride ?? persistedVerbose ?? agentCfg?.verboseDefault;
  return runAgentAttempt({
    resolvedThinkLevel: candidateThinkLevel,
    fastMode,
  });
}
function runAgentAttempt(params) {
  return runEmbeddedAgent({
    thinkLevel: params.resolvedThinkLevel,
    fastMode: params.fastMode,
  });
}
`,
    );

    expect(patch.applyPatch(runtimeRoot)).toEqual(['gateway-bundle.mjs']);
    patch.verifyPatch(runtimeRoot);
    const bundleOnce = fs.readFileSync(bundleTarget);
    expect(patch.applyPatch(runtimeRoot)).toEqual([]);
    expect(fs.readFileSync(target)).toEqual(once);
    expect(fs.readFileSync(agentCommandTarget)).toEqual(agentCommandOnce);
    expect(fs.readFileSync(attemptExecutionTarget)).toEqual(attemptExecutionOnce);
    expect(fs.readFileSync(bundleTarget)).toEqual(bundleOnce);
  });

  test('rejects partial direct-agent propagation before writing any target', () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-reasoning-atomic-'));
    temporaryRoots.push(runtimeRoot);
    const distDir = path.join(runtimeRoot, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    const selectionTarget = path.join(distDir, 'selection.js');
    const agentCommandTarget = path.join(distDir, 'agent-command.js');
    const attemptExecutionTarget = path.join(distDir, 'attempt-execution.js');
    fs.writeFileSync(
      selectionTarget,
      `function subscribeEmbeddedAgentSession(params) {
  const state = {
    streamReasoning: (params.streamReasoningInNonStreamModes === true ? reasoningMode !== "on" : reasoningMode === "stream") && canShowReasoning && typeof params.onReasoningStream === "function",
  };
}
`,
    );
    fs.writeFileSync(
      agentCommandTarget,
      `function agentCommandFixture() {
  const requestedThinkLevel = thinkOnce ?? thinkOverride ?? persistedThinking;
  const resolvedReasoningLevel = sessionEntry?.reasoningLevel ?? resolveAgentConfig(cfg, sessionAgentId)?.reasoningDefault ?? agentCfg?.reasoningDefault ?? "off";
  const resolvedVerboseLevel = verboseOverride ?? persistedVerbose ?? agentCfg?.verboseDefault;
  return runAgentAttempt({
    resolvedThinkLevel: candidateThinkLevel,
    fastMode,
  });
}
`,
    );
    fs.writeFileSync(
      attemptExecutionTarget,
      `function runAgentAttempt(params) {
  return runEmbeddedAgent({
    thinkLevel: params.resolvedThinkLevel,
    fastMode: params.fastMode,
  });
}
`,
    );
    const before = new Map(
      [selectionTarget, agentCommandTarget, attemptExecutionTarget].map(file => [
        file,
        fs.readFileSync(file),
      ]),
    );

    expect(() => patch.applyPatch(runtimeRoot)).toThrow(
      /direct agent reasoning propagation is incomplete/,
    );
    for (const [file, bytes] of before) expect(fs.readFileSync(file)).toEqual(bytes);
  });
});
