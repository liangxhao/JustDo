import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

import { describe, expect, test } from 'vitest';

const patch =
  require('../../../../scripts/patches/v2026.7.1-2/046-app-startup-task-recovery-boundary.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    verifyPatch: (runtimeDir: string) => void;
    __testing: {
      APP_STARTED_AT_ENV: string;
      isCreatedBeforeJustDoAppStart: (
        createdAt: unknown,
        appStartedAtMs: number | undefined,
      ) => boolean;
      readJustDoAppStartedAtMs: (value: unknown) => number | undefined;
      transformMain: (content: string, filePath: string) => string;
      transformSubagent: (content: string, filePath: string) => string;
    };
  };

const runtimeRoot = path.resolve('vendor/openclaw-runtime/current');
const runtimeDist = path.join(runtimeRoot, 'dist');

function findDistFile(needle: string): string {
  const candidate = fs.readdirSync(runtimeDist).find(fileName => {
    if (!fileName.endsWith('.js')) return false;
    return fs.readFileSync(path.join(runtimeDist, fileName), 'utf8').includes(needle);
  });
  if (!candidate) throw new Error(`Runtime file containing ${needle} was not found`);
  return path.join(runtimeDist, candidate);
}

function extractNamedFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Function ${name} was not found`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] !== '}') continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Function ${name} was not complete`);
}

const mainSourcePath = findDistFile(
  'async function recoverStartupOrphanedMainSessions(params = {})',
);
const subagentSourcePath = findDistFile('function restoreSubagentRunsOnce()');
const bundlePath = path.join(runtimeRoot, 'gateway-bundle.mjs');

type MainRecoveryModule = {
  i: (params: {
    stateDir: string;
    appStartedAtMs: number;
    activeSessionIds: string[];
    activeSessionKeys: string[];
  }) => Promise<{ recovered: number; failed: number; skipped: number }>;
};

async function loadMainRecoveryModule(): Promise<MainRecoveryModule> {
  return (await import(pathToFileURL(mainSourcePath).href)) as MainRecoveryModule;
}

function createSessionStore(
  entries: Record<string, Record<string, unknown>>,
): { root: string; storePath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-main-recovery-'));
  const sessionsDir = path.join(root, 'agents', 'main', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const storePath = path.join(sessionsDir, 'sessions.json');
  fs.writeFileSync(storePath, JSON.stringify(entries), 'utf8');
  return { root, storePath };
}

describe('OpenClaw app-start task recovery boundary', () => {
  test('parses the stable app-start timestamp and treats missing legacy timestamps as prior-app', () => {
    expect(patch.__testing.APP_STARTED_AT_ENV).toBe('JUSTDO_APP_STARTED_AT_MS');
    expect(patch.__testing.readJustDoAppStartedAtMs('1800000000000')).toBe(1800000000000);
    expect(patch.__testing.readJustDoAppStartedAtMs('0')).toBeUndefined();
    expect(patch.__testing.readJustDoAppStartedAtMs('invalid')).toBeUndefined();

    expect(patch.__testing.isCreatedBeforeJustDoAppStart(99, 100)).toBe(true);
    expect(patch.__testing.isCreatedBeforeJustDoAppStart(undefined, 100)).toBe(true);
    expect(patch.__testing.isCreatedBeforeJustDoAppStart(100, 100)).toBe(false);
    expect(patch.__testing.isCreatedBeforeJustDoAppStart(101, 100)).toBe(false);
    expect(patch.__testing.isCreatedBeforeJustDoAppStart(99, undefined)).toBe(false);
  });

  test('keeps the generated source and bundle contracts complete and idempotent', () => {
    const mainSource = fs.readFileSync(mainSourcePath, 'utf8');
    const subagentSource = fs.readFileSync(subagentSourcePath, 'utf8');
    const bundle = fs.readFileSync(bundlePath, 'utf8');

    expect(patch.__testing.transformMain(mainSource, mainSourcePath)).toBe(mainSource);
    expect(patch.__testing.transformSubagent(subagentSource, subagentSourcePath)).toBe(
      subagentSource,
    );
    expect(patch.__testing.transformMain(bundle, bundlePath)).toBe(bundle);
    expect(patch.__testing.transformSubagent(bundle, bundlePath)).toBe(bundle);

    expect(mainSource).not.toContain('preservePriorAppUpdatedAt');
    expect(mainSource).toContain('entry.updatedAt !== params.expectedUpdatedAt');
    expect(subagentSource).toContain('suppressTaskDelivery: true');
    expect(subagentSource).not.toContain('entry.endedHookEmittedAt ??= Date.now();');
    expect(subagentSource.indexOf('retireJustDoPriorAppSubagentRuns();')).toBeLessThan(
      subagentSource.indexOf('recoverJustDoManagedJoinsAfterRestart();'),
    );
  });

  test('suppresses prior-app subagent delivery before terminating active runs', () => {
    const subagentSource = fs.readFileSync(subagentSourcePath, 'utf8');
    const helperSource = [
      extractNamedFunction(subagentSource, 'readJustDoSubagentAppStartedAtMs'),
      extractNamedFunction(subagentSource, 'isSubagentCreatedBeforeJustDoAppStart'),
      extractNamedFunction(subagentSource, 'retireJustDoPriorAppSubagentRuns'),
    ].join('\n');
    const runs = new Map<string, Record<string, unknown>>([
      ['old-active', { createdAt: 100 }],
      ['old-ended', { createdAt: 100, endedAt: 150 }],
      ['current-active', { createdAt: 300 }],
    ]);
    const events: string[] = [];

    vm.runInNewContext(`${helperSource}\nretireJustDoPriorAppSubagentRuns();`, {
      process: { env: { JUSTDO_APP_STARTED_AT_MS: '200' } },
      subagentRuns: runs,
      persistSubagentRuns: () => events.push('persist'),
      subagentRunManager: {
        markSubagentRunTerminated: (params: {
          runId: string;
          suppressTaskDelivery: boolean;
        }) => events.push(`terminate:${params.runId}:${params.suppressTaskDelivery}`),
      },
    });

    expect(events).toEqual(['persist', 'terminate:old-active:true']);
    expect(runs.get('old-active')).toMatchObject({ suppressCompletionDelivery: true });
    expect(runs.get('old-ended')).toMatchObject({ suppressCompletionDelivery: true });
    expect(runs.get('old-ended')).not.toHaveProperty('endedHookEmittedAt');
    expect(runs.get('current-active')).not.toHaveProperty('suppressCompletionDelivery');
    expect(extractNamedFunction(subagentSource, 'retireJustDoPriorAppSubagentRuns')).not.toContain(
      'runSubagentAnnounceFlow',
    );
  });

  test('rejects a partially forwarded main-session cutoff contract', () => {
    const mainSource = fs.readFileSync(mainSourcePath, 'utf8');
    const partial = mainSource.replace(
      'appStartedAtMs: params.appStartedAtMs',
      'appStartedAtMs: undefined',
    );

    expect(() => patch.__testing.transformMain(partial, mainSourcePath)).toThrow(
      'count=1, expected=2',
    );
  });

  test('marks prior-app main sessions failed without entering normal resume', async () => {
    const { root, storePath } = createSessionStore({
      'agent:main:justdo:prior': {
        sessionId: 'prior',
        status: 'running',
        abortedLastRun: true,
        updatedAt: 100,
      },
      'agent:main:justdo:legacy': {
        sessionId: 'legacy',
        status: 'running',
        abortedLastRun: true,
      },
    });

    try {
      const runtime = await loadMainRecoveryModule();
      const result = await runtime.i({
        stateDir: root,
        appStartedAtMs: 200,
        activeSessionIds: [],
        activeSessionKeys: [],
      });
      const store = JSON.parse(fs.readFileSync(storePath, 'utf8')) as Record<
        string,
        { status: string }
      >;

      expect(result).toEqual({ recovered: 0, failed: 0, skipped: 2 });
      expect(store['agent:main:justdo:prior']?.status).toBe('failed');
      expect(store['agent:main:justdo:legacy']?.status).toBe('failed');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test('leaves current-app main sessions on the normal Gateway-restart recovery path', async () => {
    const { root } = createSessionStore({
      'agent:main:justdo:current': {
        sessionId: 'current',
        status: 'running',
        abortedLastRun: true,
        updatedAt: 300,
      },
    });

    try {
      const runtime = await loadMainRecoveryModule();
      const result = await runtime.i({
        stateDir: root,
        appStartedAtMs: 200,
        activeSessionIds: [],
        activeSessionKeys: [],
      });

      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test('verifies all source and bundle targets in a cross-platform runtime fixture', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-app-start-recovery-'));
    const fixtureDist = path.join(fixtureRoot, 'dist');
    fs.mkdirSync(fixtureDist, { recursive: true });
    fs.copyFileSync(mainSourcePath, path.join(fixtureDist, path.basename(mainSourcePath)));
    fs.copyFileSync(subagentSourcePath, path.join(fixtureDist, path.basename(subagentSourcePath)));
    fs.copyFileSync(bundlePath, path.join(fixtureRoot, 'gateway-bundle.mjs'));

    try {
      expect(patch.applyPatch(fixtureRoot)).toEqual([]);
      expect(() => patch.verifyPatch(fixtureRoot)).not.toThrow();
      expect(patch.applyPatch(fixtureRoot)).toEqual([]);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
