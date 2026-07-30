import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from 'vitest';

const { applyPatch, __testing } =
  require('../scripts/patches/v2026.6.11/015-live-context-budget-status.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    __testing: Record<string, string>;
  };

test('publishes initial and mid-turn context estimates to session state', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-live-context-patch-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(
      bundlePath,
      [
        __testing.ORIGINAL_ATTEMPT_START,
        __testing.ORIGINAL_MIDTURN_PUBLISH,
        __testing.ORIGINAL_MIDTURN_OPTIONS,
        __testing.ORIGINAL_INITIAL_PUBLISH,
      ].join('\n'),
      'utf8',
    );

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    const patched = fs.readFileSync(bundlePath, 'utf8');

    expect(patched).toContain('persistJustDoLiveContextBudgetStatus');
    expect(patched).toContain(
      'void params.midTurnPrecheck.onContextBudgetStatus?.(precheck, contextMessages.length);',
    );
    expect(patched).toContain('contextBudgetStatus: params.status');
    expect(patched).not.toContain('totalTokensFresh: false');
    expect(applyPatch(runtimeDir)).toEqual([]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('upgrades the earlier freshness-mutating patch revision', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-live-context-upgrade-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(
      bundlePath,
      [
        __testing.LEGACY_PATCHED_ATTEMPT_START,
        __testing.LEGACY_PATCHED_MIDTURN_PUBLISH,
        __testing.LEGACY_PATCHED_MIDTURN_OPTIONS,
        __testing.LEGACY_PATCHED_INITIAL_PUBLISH,
      ].join('\n'),
      'utf8',
    );

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    const patched = fs.readFileSync(bundlePath, 'utf8');
    expect(patched).not.toContain('totalTokensFresh: false');
    expect(patched).toContain('if (params.sessionId && entry.sessionId !== params.sessionId)');
    expect(patched).toContain('void persistJustDoLiveContextBudgetStatus({');
    expect(applyPatch(runtimeDir)).toEqual([]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('live context publisher rejects a stale session id', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-live-context-publisher-'));
  try {
    const harnessPath = path.join(runtimeDir, 'publisher.mjs');
    fs.writeFileSync(
      harnessPath,
      `let currentEntry = {};
let appliedPatch;
function resolveStorePath2() {
  return "sessions.json";
}
async function patchSessionEntry2(_target, updater) {
  const patch = updater(currentEntry, { existingEntry: true });
  if (patch) {
    appliedPatch = patch;
    currentEntry = { ...currentEntry, ...patch };
  }
}
const log41 = { debug() {} };
${__testing.PATCHED_ATTEMPT_START}
}
export { persistJustDoLiveContextBudgetStatus };
export function readAppliedPatch() {
  return appliedPatch;
}
export function setCurrentEntry(entry) {
  currentEntry = entry;
}
`,
      'utf8',
    );

    const harness = (await import(`${pathToFileURL(harnessPath).href}?test=${Date.now()}`)) as {
      persistJustDoLiveContextBudgetStatus: (params: Record<string, unknown>) => Promise<void>;
      readAppliedPatch: () => Record<string, unknown> | undefined;
      setCurrentEntry: (entry: Record<string, unknown>) => void;
    };

    await harness.persistJustDoLiveContextBudgetStatus({
      config: {},
      agentId: 'main',
      sessionKey: 'agent:main:test',
      sessionId: 'session-old',
      status: { estimatedPromptTokens: 15_000 },
    });
    expect(harness.readAppliedPatch()).toBeUndefined();

    harness.setCurrentEntry({ sessionId: 'session-new', totalTokens: 10 });
    await harness.persistJustDoLiveContextBudgetStatus({
      config: {},
      agentId: 'main',
      sessionKey: 'agent:main:test',
      sessionId: 'session-old',
      status: { estimatedPromptTokens: 20_000 },
    });
    expect(harness.readAppliedPatch()).toBeUndefined();

    await harness.persistJustDoLiveContextBudgetStatus({
      config: {},
      agentId: 'main',
      sessionKey: 'agent:main:test',
      sessionId: 'session-new',
      status: { estimatedPromptTokens: 25_000 },
    });
    expect(harness.readAppliedPatch()).toEqual({
      contextBudgetStatus: { estimatedPromptTokens: 25_000 },
    });
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
