import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

const progressPatch =
  require('../../../../scripts/patches/v2026.7.1-2/032-sanitized-run-progress-events.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    verifyPatch: (runtimeDir: string) => void;
    __testing: {
      isJustDoRunProgressSession: (params: Record<string, unknown>) => boolean;
    };
  };

const PRISTINE_TARGET = `function runAgentAttempt(params) {
  const isRawModelRun = params.opts.modelRun === true || params.opts.promptMode === "none";
  const embeddedAgentProvider = params.providerOverride;
  const runCliWithSession = () => runCliAgent({
      toolsAllow: params.opts.toolsAllow,
      cleanupBundleMcpOnRunEnd: params.opts.cleanupBundleMcpOnRunEnd,
  });
  if (params.useCli) return runCliWithSession();
  return runEmbeddedAgent({
    disableTools: params.opts.modelRun === true,
    onAgentEvent: params.onAgentEvent,
  });
}`;

function createRuntime(): { runtimeDir: string; targetPath: string } {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-run-progress-patch-'));
  const distDir = path.join(runtimeDir, 'dist');
  fs.mkdirSync(distDir);
  const targetPath = path.join(distDir, 'attempt.js');
  fs.writeFileSync(targetPath, PRISTINE_TARGET, 'utf8');
  return { runtimeDir, targetPath };
}

test('records the pristine target gap before adding the scoped projection', () => {
  expect(PRISTINE_TARGET).not.toContain('phase: "progress"');
  expect(PRISTINE_TARGET).not.toContain('onExecutionPhase:');
  expect(PRISTINE_TARGET).not.toContain('onLaneWait:');
});

test('classifies only complete persisted JustDo ancestry', () => {
  const classify = progressPatch.__testing.isJustDoRunProgressSession;
  const root = 'agent:main:justdo:root';
  const child = 'agent:main:subagent:child';
  const nested = 'agent:main:subagent:nested';

  expect(classify({ sessionKey: root, sessionEntry: {} })).toBe(true);
  expect(
    classify({
      sessionKey: nested,
      sessionEntry: { spawnedBy: child },
      sessionStore: { [child]: { spawnedBy: root }, [root]: {} },
    }),
  ).toBe(true);
  expect(classify({ sessionKey: 'agent:main:main', sessionEntry: {} })).toBe(false);
  expect(classify({ sessionKey: 'agent:main:cron:job', sessionEntry: {} })).toBe(false);
  expect(
    classify({ sessionKey: nested, sessionEntry: { spawnedBy: child }, sessionStore: {} }),
  ).toBe(false);
  expect(
    classify({
      sessionKey: child,
      spawnedBy: root,
      sessionEntry: { spawnedBy: 'agent:main:main' },
      sessionStore: { [root]: {} },
    }),
  ).toBe(false);
  expect(
    classify({
      sessionKey: child,
      sessionEntry: { spawnedBy: nested },
      sessionStore: { [nested]: { spawnedBy: child } },
    }),
  ).toBe(false);

  const deepStore: Record<string, { spawnedBy?: string }> = { [root]: {} };
  for (let index = 1; index <= 33; index += 1) {
    deepStore[`agent:main:subagent:depth-${index}`] = {
      spawnedBy: index === 33 ? root : `agent:main:subagent:depth-${index + 1}`,
    };
  }
  expect(
    classify({
      sessionKey: 'agent:main:subagent:depth-0',
      sessionEntry: { spawnedBy: 'agent:main:subagent:depth-1' },
      sessionStore: deepStore,
    }),
  ).toBe(false);
});

test('emits sanitized stages for JustDo ancestry and stays silent for native sessions', () => {
  const { runtimeDir, targetPath } = createRuntime();
  try {
    expect(progressPatch.applyPatch(runtimeDir)).toEqual([path.join('dist', 'attempt.js')]);
    expect(progressPatch.applyPatch(runtimeDir)).toEqual([]);
    expect(() => progressPatch.verifyPatch(runtimeDir)).not.toThrow();

    const patched = fs.readFileSync(targetPath, 'utf8');
    expect(patched).toContain('if (!shouldEmitJustDoRunProgress) return;');
    expect(patched).not.toContain('prompt: params');

    const harness = new Function(
      `const events = [];
       const embeddedOptions = [];
       const cliOptions = [];
       const emitAgentEvent = event => events.push(event);
       const runEmbeddedAgent = options => { embeddedOptions.push(options); return {}; };
       const runCliAgent = options => { cliOptions.push(options); return {}; };
       ${patched}
       return { runAgentAttempt, events, embeddedOptions, cliOptions };`,
    )() as {
      runAgentAttempt: (params: Record<string, unknown>) => unknown;
      events: Array<Record<string, unknown>>;
      embeddedOptions: Array<{
        onExecutionPhase: (info: Record<string, unknown>) => void;
        onLaneWait: (info: Record<string, unknown>) => void;
      }>;
      cliOptions: Array<{
        onExecutionPhase: (info: Record<string, unknown>) => void;
      }>;
    };

    const base = {
      lifecycleGeneration: 'generation-1',
      isFallbackRetry: true,
      providerOverride: 'provider-1',
      modelOverride: 'model-1',
      opts: {},
    };
    harness.runAgentAttempt({
      ...base,
      runId: 'native-run',
      sessionKey: 'agent:main:main',
      sessionEntry: {},
    });
    harness.embeddedOptions[0].onExecutionPhase({
      phase: 'process_spawned',
      provider: 'provider-1',
      model: 'model-1',
      secret: 'must-not-leak',
    });
    harness.embeddedOptions[0].onLaneWait({ waiting: true });
    expect(harness.events).toEqual([]);

    harness.runAgentAttempt({
      ...base,
      runId: 'justdo-run',
      sessionKey: 'agent:main:subagent:child',
      sessionEntry: { spawnedBy: 'agent:main:justdo:root' },
      sessionStore: { 'agent:main:justdo:root': {} },
    });
    harness.embeddedOptions[1].onExecutionPhase({
      phase: 'process_spawned',
      provider: `provider-${'p'.repeat(200)}`,
      model: `model-${'m'.repeat(200)}`,
      secret: 'must-not-leak',
    });
    harness.embeddedOptions[1].onLaneWait({ waiting: true });

    expect(harness.events.map(event => (event.data as { stage: string }).stage)).toEqual([
      'retrying',
      'waiting_model',
      'queued',
    ]);
    for (const event of harness.events) {
      expect(event).toMatchObject({
        runId: 'justdo-run',
        sessionKey: 'agent:main:subagent:child',
        stream: 'lifecycle',
      });
      expect(event.data).not.toHaveProperty('secret');
    }
    expect((harness.events[1].data as { provider: string; model: string }).provider).toHaveLength(
      128,
    );
    expect((harness.events[1].data as { provider: string; model: string }).model).toHaveLength(128);

    harness.runAgentAttempt({
      ...base,
      useCli: true,
      isFallbackRetry: false,
      runId: 'justdo-cli-run',
      sessionKey: 'agent:main:justdo:root',
      sessionEntry: {},
    });
    harness.cliOptions[0].onExecutionPhase({ phase: 'runner_entered' });
    expect(harness.events.at(-1)).toMatchObject({
      runId: 'justdo-cli-run',
      data: { phase: 'progress', stage: 'preparing' },
    });
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('fails atomically when the target control flow changes', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-run-progress-mismatch-'));
  try {
    const distDir = path.join(runtimeDir, 'dist');
    fs.mkdirSync(distDir);
    fs.writeFileSync(path.join(distDir, 'attempt.js'), 'function runAgentAttempt() {}', 'utf8');
    expect(() => progressPatch.applyPatch(runtimeDir)).toThrow('run progress target count');
    expect(fs.readFileSync(path.join(distDir, 'attempt.js'), 'utf8')).toBe(
      'function runAgentAttempt() {}',
    );
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
