import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

const { applyPatch, verifyPatch } =
  require('../scripts/patches/v2026.6.11/020-run-progress-events.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    verifyPatch: (runtimeDir: string) => boolean;
  };

const FIXTURE = `function runAgentAttempt(params) {
  const isRawModelRun = params.opts.modelRun === true || params.opts.promptMode === "none";
  const runCliWithSession = () => runCliAgent({
      toolsAllow: params.opts.toolsAllow,
      cleanupBundleMcpOnRunEnd: params.opts.cleanupBundleMcpOnRunEnd,
  });
  return runEmbeddedAgent({
    disableTools: params.opts.modelRun === true,
    onAgentEvent: params.onAgentEvent,
  });
}
function describeSession({ cfg, storePath, store2, target, entry, p4, key, context, respond }) {
        respond(true, { session: buildGatewaySessionRow({
          cfg,
          storePath,
          store: store2,
          key: target.canonicalKey,
          entry,
          includeDerivedTitles: p4.includeDerivedTitles,
          includeLastMessage: p4.includeLastMessage,
          transcriptUsageMaxBytes: 64 * 1024
        }) }, void 0);
}`;

test('adds only sanitized run progress fields and is idempotent', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-run-progress-patch-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(bundlePath, FIXTURE, 'utf8');

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    expect(applyPatch(runtimeDir)).toEqual([]);
    expect(verifyPatch(runtimeDir)).toBe(true);

    const patched = fs.readFileSync(bundlePath, 'utf8');
    expect(patched).toContain('stage,');
    expect(patched).toContain('at: Date.now()');
    expect(patched).toContain('emitAgentEvent({');
    expect(patched).not.toContain('params.onAgentEvent({');
    expect(patched).toContain('onLaneWait:');
    expect(patched).toContain('session.hasActiveRun = hasTrackedActiveSessionRun({');
    expect(patched).not.toContain('fallbackStepFromFailureDetail');
    expect(patched).not.toContain('prompt: params');

    const harness = new Function(
      `const events = [];
       let embeddedOptions;
       const emitAgentEvent = event => events.push(event);
       const runEmbeddedAgent = options => { embeddedOptions = options; return {}; };
       const runCliAgent = () => ({});
       ${patched}
       return { runAgentAttempt, events, getEmbeddedOptions: () => embeddedOptions };`,
    )() as {
      runAgentAttempt: (params: Record<string, unknown>) => unknown;
      events: Array<Record<string, unknown>>;
      getEmbeddedOptions: () => {
        onExecutionPhase: (info: Record<string, unknown>) => void;
        onLaneWait: (info: Record<string, unknown>) => void;
      };
    };
    harness.runAgentAttempt({
      runId: 'run-1',
      sessionKey: 'session-1',
      lifecycleGeneration: 'generation-1',
      isFallbackRetry: true,
      providerOverride: 'provider-1',
      modelOverride: 'model-1',
      opts: {},
    });
    harness.getEmbeddedOptions().onExecutionPhase({
      phase: 'process_spawned',
      provider: 'provider-1',
      model: 'model-1',
      secret: 'must-not-leak',
    });
    expect(harness.events).toEqual([
      expect.objectContaining({
        runId: 'run-1',
        sessionKey: 'session-1',
        lifecycleGeneration: 'generation-1',
        stream: 'lifecycle',
        data: expect.objectContaining({ phase: 'progress', stage: 'retrying' }),
      }),
      expect.objectContaining({
        stream: 'lifecycle',
        data: expect.objectContaining({
          phase: 'progress',
          stage: 'waiting_model',
          provider: 'provider-1',
          model: 'model-1',
        }),
      }),
    ]);
    expect(harness.events[1]).not.toHaveProperty('data.secret');
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('fails visibly if the targeted OpenClaw implementation changes', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-run-progress-patch-'));
  try {
    fs.writeFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'export {};', 'utf8');
    expect(() => applyPatch(runtimeDir)).toThrow('patch target not found');
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('defers safely until the gateway bundle has been generated', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-run-progress-patch-'));
  try {
    expect(applyPatch(runtimeDir)).toEqual([]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
