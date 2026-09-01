import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { describe, expect, test, vi } from 'vitest';

type Join = {
  state: string;
  controllerSessionKey: string;
  gatewayRunId?: string;
  toolCallId?: string;
  originalCleanup?: 'keep' | 'delete';
  originalExpectsCompletionMessage?: boolean;
};

type Run = {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  expectsCompletionMessage?: boolean;
  completion?: { required?: boolean; capturedAt?: number; resultText?: string };
  endedAt?: number;
  cleanup?: 'keep' | 'delete';
  cleanupHandled?: boolean;
  cleanupCompletedAt?: number;
  delivery?: { status?: string; justDoManagedJoin?: Join };
};

const patch =
  require('../../../../scripts/patches/v2026.7.1-2/044-managed-terminal-handoff.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    verifyPatch: (runtimeDir: string) => void;
    __testing: {
      isJustDoExplicitWaitingHandoff: (entry: Run, controller: string) => boolean;
      canCorrelateJustDoCompletionSourceEntry: (
        entry: Run,
        params: {
          controllerSessionKey: string;
          sourceSessionKey: string;
          gatewayRunId?: string;
        },
      ) => boolean;
      mutateJustDoManagedJoinEntriesAtomically: (
        runs: Map<string, Run>,
        entries: Run[],
        mutator: (entry: Run) => void,
        persist: (runs: Map<string, Run>) => void,
      ) => void;
      restoreJustDoManagedJoinSnapshotsInPlace: (
        runs: Map<string, Run>,
        snapshots: Map<string, Run>,
      ) => void;
      mutateJustDoSubagentRegistryAtomically: <T extends { changed: boolean }>(
        runs: Map<string, Run>,
        mutation: () => T,
        persist: () => void,
      ) => T;
      shouldAttemptJustDoCodexTerminalHandoff: (params: {
        attemptSucceeded?: boolean;
        hasSessionKey?: boolean;
        aborted?: boolean;
        timedOut?: boolean;
        promptError?: boolean;
        yieldDetected?: boolean;
      }) => boolean;
      resolveJustDoCodexTerminalHandoffOutcome: (
        implicitJoin: { status?: string; prompt?: string; deliveryRestored?: boolean },
        params: { aborted?: boolean; timedOut?: boolean },
      ) => { status: string; prompt?: string };
      transformTools: (content: string, filePath: string) => string;
      transformEmbeddedAttempt: (content: string, filePath: string) => string;
      transformRegistry: (content: string, filePath: string) => string;
      transformCodexAttempt: (content: string, filePath: string) => string;
      transformCodexMirror: (content: string, filePath: string) => string;
      transformPluginLoader: (content: string, filePath: string) => string;
      transformRuntimePluginInstall: (content: string, filePath: string) => string;
      patchJustDoOfficialCodexPlugin: (params: Record<string, unknown>) => {
        status: string;
      };
      computeJustDoCodexTransformInputFingerprint: () => string;
      CODEX_PLUGIN_TRANSFORM_INPUT_SHA256: string;
    };
  };

const controller = 'agent:main:justdo:parent';
const implicitPatch = require('../../../../scripts/patches/v2026.7.1-2/041-managed-implicit-subagent-join.cjs') as {
  __testing: {
    selectJustDoImplicitJoinRuns: (entries: Run[], controller: string) => Run[];
    partitionJustDoImplicitJoinResults: (
      entries: Run[],
      controller: string,
    ) => { completed: Run[]; pending: number };
    isJustDoImplicitJoinCommitState: (state: string) => boolean;
  };
};
const recoveryPatch = require('../../../../scripts/patches/v2026.7.1-2/020-managed-join-recovery.cjs') as {
  __testing: { restoreJustDoManagedJoinEntry: (entry: Run) => boolean };
};

function explicitRun(index: number, state = 'waiting'): Run {
  return {
    runId: `run-${index}`,
    childSessionKey: `agent:main:subagent:${index}`,
    requesterSessionKey: controller,
    expectsCompletionMessage: false,
    completion: { required: false },
    delivery: {
      status: 'not_required',
      justDoManagedJoin: {
        state,
        controllerSessionKey: controller,
        gatewayRunId: 'parent-run',
        toolCallId: 'yield-call',
        originalCleanup: 'delete',
        originalExpectsCompletionMessage: true,
      },
    },
  };
}

describe('managed terminal handoff capability', () => {
  test('takes over only unfinished explicit waits owned by the exact controller', () => {
    const waiting = explicitRun(1);
    expect(patch.__testing.isJustDoExplicitWaitingHandoff(waiting, controller)).toBe(true);
    expect(
      patch.__testing.isJustDoExplicitWaitingHandoff(
        { ...waiting, requesterSessionKey: `${controller}:foreign` },
        controller,
      ),
    ).toBe(false);
    for (const state of ['presented', 'tool_result_committed', 'implicit_waiting', 'consumed']) {
      expect(patch.__testing.isJustDoExplicitWaitingHandoff(explicitRun(1, state), controller)).toBe(
        false,
      );
    }
  });

  test('carries a partial leftover through terminal handoff, completion and continuation commit', () => {
    const completed = explicitRun(0, 'presented');
    const waiting = explicitRun(1);
    const runs = new Map([
      [completed.runId, completed],
      [waiting.runId, waiting],
    ]);
    const persist = vi.fn((current: Map<string, Run>) => {
      expect(current.get(waiting.runId)?.delivery?.justDoManagedJoin?.state).toBe(
        'implicit_waiting',
      );
    });

    patch.__testing.mutateJustDoManagedJoinEntriesAtomically(
      runs,
      [waiting],
      entry => {
        const join = entry.delivery?.justDoManagedJoin;
        if (!join || join.state !== 'waiting') throw new Error('ownership changed');
        if (entry.delivery)
          entry.delivery.justDoManagedJoin = {
            ...join,
            state: 'implicit_waiting',
            gatewayRunId: 'terminal-run',
          };
      },
      persist,
    );
    expect(completed.delivery?.justDoManagedJoin?.state).toBe('presented');
    expect(implicitPatch.__testing.selectJustDoImplicitJoinRuns([...runs.values()], controller)).toEqual([
      waiting,
    ]);
    waiting.endedAt = 20;
    waiting.completion = { required: false, capturedAt: 20, resultText: 'B done' };
    expect(
      implicitPatch.__testing.partitionJustDoImplicitJoinResults([waiting], controller),
    ).toEqual({ completed: [waiting], pending: 0 });
    patch.__testing.mutateJustDoManagedJoinEntriesAtomically(
      runs,
      [waiting],
      entry => {
        if (entry.delivery?.justDoManagedJoin)
          entry.delivery.justDoManagedJoin.state = 'implicit_presented';
      },
      vi.fn(),
    );
    expect(waiting.delivery?.justDoManagedJoin).toMatchObject({
      state: 'implicit_presented',
      originalCleanup: 'delete',
      originalExpectsCompletionMessage: true,
    });
    expect(
      implicitPatch.__testing.isJustDoImplicitJoinCommitState(
        waiting.delivery?.justDoManagedJoin?.state ?? '',
      ),
    ).toBe(true);
    patch.__testing.mutateJustDoSubagentRegistryAtomically(
      runs,
      () => {
        const join = waiting.delivery?.justDoManagedJoin;
        if (!join || !implicitPatch.__testing.isJustDoImplicitJoinCommitState(join.state))
          return { changed: false };
        if (waiting.delivery)
          waiting.delivery.justDoManagedJoin = { ...join, state: 'consumed' };
        waiting.cleanup = join.originalCleanup;
        waiting.cleanupHandled = false;
        return { changed: true };
      },
      vi.fn(),
    );
    expect(waiting.delivery?.justDoManagedJoin?.state).toBe('consumed');
    expect(waiting.cleanup).toBe('delete');

    const interrupted = explicitRun(2);
    const interruptedRuns = new Map([[interrupted.runId, interrupted]]);
    patch.__testing.mutateJustDoManagedJoinEntriesAtomically(
      interruptedRuns,
      [interrupted],
      entry => {
        if (entry.delivery?.justDoManagedJoin)
          entry.delivery.justDoManagedJoin.state = 'implicit_waiting';
      },
      vi.fn(),
    );
    patch.__testing.mutateJustDoSubagentRegistryAtomically(
      interruptedRuns,
      () => ({ changed: recoveryPatch.__testing.restoreJustDoManagedJoinEntry(interrupted) }),
      vi.fn(),
    );
    expect(interrupted).toMatchObject({
      expectsCompletionMessage: true,
      completion: { required: true },
      cleanup: 'delete',
      delivery: { status: 'pending' },
    });
    expect(interrupted.delivery?.justDoManagedJoin).toBeUndefined();
  });

  test('keeps every leftover across batches larger than the presentation limit', () => {
    const entries = Array.from({ length: 18 }, (_, index) => explicitRun(index));
    expect(
      entries.filter(entry => patch.__testing.isJustDoExplicitWaitingHandoff(entry, controller)),
    ).toHaveLength(18);
    const runs = new Map(entries.map(entry => [entry.runId, entry]));
    patch.__testing.mutateJustDoManagedJoinEntriesAtomically(
      runs,
      entries,
      entry => {
        if (entry.delivery?.justDoManagedJoin)
          entry.delivery.justDoManagedJoin.state = 'implicit_waiting';
      },
      vi.fn(),
    );
    expect(
      [...runs.values()].filter(
        entry => entry.delivery?.justDoManagedJoin?.state === 'implicit_waiting',
      ),
    ).toHaveLength(18);
  });

  test('rolls memory back when initial, presentation, mark, commit or restore persistence fails', () => {
    for (const nextState of [
      'implicit_waiting',
      'implicit_presented',
      'tool_result_committed',
      'consumed',
      'native_restored',
    ]) {
      const entry = explicitRun(1);
      const before = structuredClone(entry);
      const runs = new Map([[entry.runId, entry]]);
      const failure = new Error(`persist failed: ${nextState}`);
      const runMutation = () => {
        if (nextState === 'implicit_waiting' || nextState === 'implicit_presented')
          return patch.__testing.mutateJustDoManagedJoinEntriesAtomically(
            runs,
            [entry],
            current => {
              if (current.delivery?.justDoManagedJoin)
                current.delivery.justDoManagedJoin.state = nextState;
            },
            () => {
              throw failure;
            },
          );
        return patch.__testing.mutateJustDoSubagentRegistryAtomically(
          runs,
          () => {
            if (entry.delivery?.justDoManagedJoin)
              entry.delivery.justDoManagedJoin.state = nextState;
            return { changed: true };
          },
          () => {
            throw failure;
          },
        );
      };
      expect(runMutation).toThrow(failure);
      expect(runs.get(entry.runId)).toBe(entry);
      expect(runs.get(entry.runId)).toEqual(before);
    }
  });

  test('keeps a held entry live when the transformed outer rollback runs after persistence failure', () => {
    const entry = explicitRun(1);
    const heldReference = entry;
    const before = structuredClone(entry);
    const runs = new Map([[entry.runId, entry]]);
    const outerSnapshots = new Map([[entry.runId, structuredClone(entry)]]);
    expect(() =>
      patch.__testing.mutateJustDoManagedJoinEntriesAtomically(
        runs,
        [entry],
        current => {
          if (current.delivery?.justDoManagedJoin)
            current.delivery.justDoManagedJoin.state = 'implicit_waiting';
        },
        () => {
          throw new Error('persist failed');
        },
      ),
    ).toThrow('persist failed');
    patch.__testing.restoreJustDoManagedJoinSnapshotsInPlace(runs, outerSnapshots);
    expect(runs.get(entry.runId)).toBe(heldReference);
    expect(heldReference).toEqual(before);
  });

  test('snapshots only managed rows and skips persistence for a no-op transition', () => {
    const managed = explicitRun(1);
    const unrelated = {
      runId: 'unrelated',
      opaqueCallback: () => undefined,
      delivery: { status: 'pending' },
    };
    const runs = new Map<string, Run | typeof unrelated>([
      [managed.runId, managed],
      [unrelated.runId, unrelated],
    ]);
    const persist = vi.fn();
    expect(() =>
      patch.__testing.mutateJustDoSubagentRegistryAtomically(
        runs as Map<string, Run>,
        () => {
          if (managed.delivery?.justDoManagedJoin)
            managed.delivery.justDoManagedJoin.state = 'implicit_waiting';
          return { changed: true };
        },
        persist,
      ),
    ).not.toThrow();
    expect(persist).toHaveBeenCalledOnce();
    expect(runs.get(unrelated.runId)).toBe(unrelated);

    persist.mockClear();
    patch.__testing.mutateJustDoSubagentRegistryAtomically(
      runs as Map<string, Run>,
      () => ({ changed: false }),
      persist,
    );
    expect(persist).not.toHaveBeenCalled();
  });

  test('correlates a same-run presented source but rejects stale and forged sources', () => {
    const source = explicitRun(0, 'presented');
    const correlate = (entry: Run, gatewayRunId = 'parent-run') =>
      patch.__testing.canCorrelateJustDoCompletionSourceEntry(entry, {
        controllerSessionKey: controller,
        sourceSessionKey: entry.childSessionKey,
        gatewayRunId,
      });

    expect(correlate(source)).toBe(true);
    expect(correlate(explicitRun(0, 'tool_result_committed'))).toBe(true);
    expect(correlate(explicitRun(0, 'consumed'))).toBe(false);
    expect(correlate(source, 'stale-run')).toBe(false);
    expect(
      correlate({
        ...source,
        requesterSessionKey: `${controller}:foreign`,
      }),
    ).toBe(false);
    const missingToolCall = explicitRun(0, 'presented');
    if (missingToolCall.delivery?.justDoManagedJoin)
      missingToolCall.delivery.justDoManagedJoin.toolCallId = undefined;
    expect(correlate(missingToolCall)).toBe(false);
  });

  test('guards only a successful Codex terminal candidate', () => {
    const shouldAttempt = patch.__testing.shouldAttemptJustDoCodexTerminalHandoff;
    expect(shouldAttempt({ attemptSucceeded: true, hasSessionKey: true })).toBe(true);
    for (const key of ['aborted', 'timedOut', 'promptError', 'yieldDetected'] as const)
      expect(shouldAttempt({ attemptSucceeded: true, hasSessionKey: true, [key]: true })).toBe(
        false,
      );
    expect(shouldAttempt({ attemptSucceeded: false, hasSessionKey: true })).toBe(false);
    expect(shouldAttempt({ attemptSucceeded: true, hasSessionKey: false })).toBe(false);

    const resolveOutcome = patch.__testing.resolveJustDoCodexTerminalHandoffOutcome;
    expect(resolveOutcome({ status: 'joined', prompt: 'B done' }, {})).toEqual({
      status: 'joined',
      prompt: 'B done',
    });
    expect(resolveOutcome({ status: 'error', deliveryRestored: false }, {})).toEqual({
      status: 'durability_error',
    });
    expect(resolveOutcome({ status: 'error', deliveryRestored: true }, {})).toEqual({
      status: 'terminal',
    });
    expect(resolveOutcome({ status: 'joined', prompt: 'B done' }, { aborted: true })).toEqual({
      status: 'interrupted',
    });
    expect(resolveOutcome({ status: 'joined', prompt: 'B done' }, { timedOut: true })).toEqual({
      status: 'interrupted',
    });
  });

  test('patches embedded paths and Codex companion transforms idempotently', () => {
    const root = path.resolve('vendor/openclaw-runtime/win-x64/dist');
    const cases = [
      ['openclaw-tools-KulZ1cdH.js', patch.__testing.transformTools],
      ['selection-JInn13lc.js', patch.__testing.transformEmbeddedAttempt],
      ['subagent-registry-DexSZ4w1.js', patch.__testing.transformRegistry],
      ['run-attempt-CXZNKJ6y.js', patch.__testing.transformCodexAttempt],
      ['provider-capabilities-CYpG67go.js', patch.__testing.transformCodexMirror],
    ] as const;
    for (const [name, transform] of cases) {
      const filePath = path.join(root, name);
      const original = fs.readFileSync(filePath, 'utf8');
      const transformed = transform(original, filePath);
      expect(transform(transformed, filePath)).toBe(transformed);
      if (name === 'openclaw-tools-KulZ1cdH.js') {
        expect(
          transformed.split(
            'restoreJustDoManagedJoinSnapshotsInPlace(subagentRuns, snapshots);',
          ),
        ).toHaveLength(3);
        expect(transformed).toContain('function restoreJustDoManagedJoinSnapshotsInPlace(');
        expect(transformed).not.toContain(
          'for (const [runId, snapshot] of snapshots) subagentRuns.set(runId, snapshot);',
        );
      }
      if (name === 'selection-JInn13lc.js') {
        expect(transformed).toContain('event: "terminal_handoff_failed"');
        expect(transformed).toContain(
          'reason: typeof implicitJoin.error === "string" && implicitJoin.error ? implicitJoin.error : "unknown"',
        );
        expect(transformed).toContain('deliveryRestored: implicitJoin.deliveryRestored === true');
        expect(transformed).toContain(
          'recovery: implicitJoin.deliveryRestored === true ? "native_delivery_restored" : "native_delivery_not_restored"',
        );
        expect(transformed).toContain(
          'promptError = new Error("Managed subagent terminal handoff could not be persisted.")',
        );
        expect(transformed).toContain('promptErrorSource = "prompt"');
        expect(transformed).not.toContain(
          'JUSTDO_MANAGED_IMPLICIT_JOIN_REVISION_PREFIX + "The runtime could not durably hand off',
        );
      }
      if (name === 'run-attempt-CXZNKJ6y.js') {
        expect(transformed).toContain('event: "terminal_handoff_failed"');
        expect(transformed).toContain('sessionId: params.sessionId');
        expect(transformed).toContain('runId: params.runId');
        expect(transformed).toContain(
          'result.agentHarnessResultClassification === void 0 || toolBridge.telemetry.didDeliverSourceReplyViaMessageTool',
        );
        expect(transformed).toContain(
          'justDoManagedCodexHandoffClaimed = implicitJoin?.status === "joined"',
        );
        expect(transformed).toContain(
          'justDoManagedCodexBridge.restoreImplicitDelivery?.(params.sessionKey, params.runId)',
        );
        expect(transformed.indexOf('waitForRequiredChildren?.({')).toBeLessThan(
          transformed.indexOf('const finalPromptErrorSource ='),
        );
        expect(transformed.indexOf('const finalPromptErrorSource =')).toBeLessThan(
          transformed.indexOf('const finalAborted = isFinalAborted();'),
        );
      }
    }

    const registryPath = path.join(root, 'subagent-registry-DexSZ4w1.js');
    const transformedRegistry = patch.__testing.transformRegistry(
      fs.readFileSync(registryPath, 'utf8'),
      registryPath,
    );
    expect(() =>
      patch.__testing.transformRegistry(
        transformedRegistry.replace(
          'deleteRunIds } = mutateJustDoSubagentRegistryAtomically(',
          'deleteRunIds } = incompleteManagedMutation(',
        ),
        registryPath,
      ),
    ).toThrow(/partial managed terminal handoff registry patch/);

    const mirrorPath = path.join(root, 'provider-capabilities-CYpG67go.js');
    const transformedMirror = patch.__testing.transformCodexMirror(
      fs.readFileSync(mirrorPath, 'utf8'),
      mirrorPath,
    );
    expect(() =>
      patch.__testing.transformCodexMirror(
        transformedMirror.replace(
          'suppressManagedJoinContinuationCommit: params.suppressManagedJoinContinuationCommit === true',
          'suppressManagedJoinContinuationCommit: false',
        ),
        mirrorPath,
      ),
    ).toThrow(/partial managed terminal handoff Codex mirror patch/);

    const embeddedPath = path.join(root, 'selection-JInn13lc.js');
    const transformedEmbedded = patch.__testing.transformEmbeddedAttempt(
      fs.readFileSync(embeddedPath, 'utf8'),
      embeddedPath,
    );
    expect(() =>
      patch.__testing.transformEmbeddedAttempt(
        transformedEmbedded.replace('promptErrorSource = "prompt"', 'promptErrorSource = null'),
        embeddedPath,
      ),
    ).toThrow(/legacy managed terminal handoff embedded patch is unsupported/);

    const legacyEmbedded =
      'if (implicitJoin?.status === "joined" && typeof implicitJoin.prompt === "string" && implicitJoin.prompt) {\n' +
      '\t\t\t\t\t\tbeforeAgentFinalizeRevisionReason = JUSTDO_MANAGED_IMPLICIT_JOIN_REVISION_PREFIX + implicitJoin.prompt;\n' +
      '\t\t\t\t\t\treturn { suppressTerminalDelivery: true };\n' +
      '\t\t\t\t\t}\n' +
      '\t\t\t\t\tpromptError = new Error("Managed subagent terminal handoff could not be persisted.");\n' +
      '\t\t\t\t\tpromptErrorSource = "prompt";';
    expect(() =>
      patch.__testing.transformEmbeddedAttempt(legacyEmbedded, embeddedPath),
    ).toThrow(/legacy managed terminal handoff embedded patch is unsupported/);

    const loaderPath = path.join(root, 'loader-D8d2EvVh.js');
    const transformedLoader = patch.__testing.transformPluginLoader(
      fs.readFileSync(loaderPath, 'utf8'),
      loaderPath,
    );
    expect(patch.__testing.transformPluginLoader(transformedLoader, loaderPath)).toBe(
      transformedLoader,
    );
    expect(transformedLoader.split('phase: "justdo-codex-runtime-patch"')).toHaveLength(3);
    expect(transformedLoader.indexOf('patchJustDoOfficialCodexPlugin({')).toBeLessThan(
      transformedLoader.indexOf('loadPluginModule(safeSource)'),
    );

    const runtimeInstallPath = path.join(root, 'runtime-plugin-install-DIbOhSHk.js');
    const transformedRuntimeInstall = patch.__testing.transformRuntimePluginInstall(
      fs.readFileSync(runtimeInstallPath, 'utf8'),
      runtimeInstallPath,
    );
    expect(transformedRuntimeInstall).toContain(
      'const { clearPluginLoaderCache } = await import("./plugins/loader.js");',
    );
    expect(transformedRuntimeInstall.indexOf('clearPluginLoaderCache();')).toBeLessThan(
      transformedRuntimeInstall.indexOf('const enableResult ='),
    );
  });

  test('normalizes pristine, 019-only and 019-plus-020 Codex provider states', () => {
    const providerPath = path.resolve(
      'vendor/openclaw-runtime/win-x64/dist/provider-capabilities-CYpG67go.js',
    );
    const with019And020 = fs.readFileSync(providerPath, 'utf8');
    const with019Only = with019And020.replace(
      '\n\telse if (finalAssistant?.stopReason === "error" || finalAssistant?.stopReason === "aborted") bridge.restoreDelivery?.(params.sessionKey);',
      '',
    );
    const pristine = with019Only
      .replace(
        /const JUSTDO_MANAGED_JOIN_CODEX_GLOBAL = Symbol\.for\("justdo\.openclaw\.managed-subagent-join\.v2026\.7\.1-2"\);[\s\S]*?\n}\n(?=async function mirrorCodexAppServerTranscript)/,
        '',
      )
      .replace('\tcommitJustDoManagedJoinCodexMirror(params, messages);\n', '');
    expect(pristine).not.toContain('commitJustDoManagedJoinCodexMirror');
    const finalFromPristine = patch.__testing.transformCodexMirror(pristine, providerPath);
    expect(patch.__testing.transformCodexMirror(with019Only, providerPath)).toBe(
      finalFromPristine,
    );
    expect(patch.__testing.transformCodexMirror(with019And020, providerPath)).toBe(
      finalFromPristine,
    );
  });

  test('patches and re-verifies the installed Codex companion before import', () => {
    const runtimeDist = path.resolve('vendor/openclaw-runtime/win-x64/dist');
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-codex-companion-'));
    const fixtureDist = path.join(fixtureRoot, 'dist');
    fs.mkdirSync(fixtureDist, { recursive: true });
    const attemptName = 'run-attempt-FUyOjGCV.js';
    const providerName = 'provider-capabilities-CDnHbmUZ.js';
    const attemptSource = fs.readFileSync(path.join(runtimeDist, 'run-attempt-CXZNKJ6y.js'), 'utf8');
    const providerSource = fs.readFileSync(
      path.join(runtimeDist, 'provider-capabilities-CYpG67go.js'),
      'utf8',
    );
    const attemptPath = path.join(fixtureDist, attemptName);
    const providerPath = path.join(fixtureDist, providerName);
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const patchedAttempt = patch.__testing.transformCodexAttempt(attemptSource, attemptPath);
    const patchedProvider = patch.__testing.transformCodexMirror(providerSource, providerPath);
    const expectedPristineHashes = {
      attempt: hash(attemptSource),
      provider: hash(providerSource),
    };
    const expectedPatchedHashes = {
      attempt: hash(patchedAttempt),
      provider: hash(patchedProvider),
    };
    fs.writeFileSync(attemptPath, attemptSource);
    fs.writeFileSync(providerPath, providerSource);
    fs.writeFileSync(
      path.join(fixtureRoot, 'package.json'),
      JSON.stringify({ name: '@openclaw/codex', version: '2026.7.1' }),
    );
    const params = {
      pluginId: 'codex',
      packageName: '@openclaw/codex',
      trustedOfficialInstall: true,
      origin: 'global',
      pluginRoot: fixtureRoot,
      installRecord: {
        source: 'npm',
        installPath: fixtureRoot,
        resolvedName: '@openclaw/codex',
        version: '2026.7.1',
        resolvedVersion: '2026.7.1',
      },
      resolveInstallPath: (value: string) => value,
      expectedPristineHashes,
      expectedPatchedHashes,
      expectedProviderIntermediateHashes: [],
    };
    try {
      expect(patch.__testing.computeJustDoCodexTransformInputFingerprint()).toBe(
        patch.__testing.CODEX_PLUGIN_TRANSFORM_INPUT_SHA256,
      );
      const freshFingerprint = spawnSync(
        process.execPath,
        [
          '-e',
          "const helper=require('./scripts/patches/v2026.7.1-2/_managed-terminal-handoff-codex.js');process.stdout.write(helper.computeJustDoCodexTransformInputFingerprint())",
        ],
        { cwd: path.resolve('.'), encoding: 'utf8' },
      );
      expect(freshFingerprint.status, freshFingerprint.stderr).toBe(0);
      expect(freshFingerprint.stdout).toBe(patch.__testing.CODEX_PLUGIN_TRANSFORM_INPUT_SHA256);

      expect(patch.__testing.patchJustDoOfficialCodexPlugin(params)).toEqual({
        status: 'patched',
      });
      expect(patch.__testing.patchJustDoOfficialCodexPlugin(params)).toEqual({
        status: 'verified',
      });
      expect(fs.readFileSync(attemptPath, 'utf8')).toBe(patchedAttempt);
      expect(fs.readFileSync(providerPath, 'utf8')).toBe(patchedProvider);

      fs.writeFileSync(attemptPath, attemptSource);
      fs.writeFileSync(providerPath, providerSource);
      const loaderPath = path.join(runtimeDist, 'loader-D8d2EvVh.js');
      const embeddedGate = spawnSync(
        process.execPath,
        [
          '-e',
          [
            "const fs=require('node:fs'),vm=require('node:vm');",
            "const patch=require('./scripts/patches/v2026.7.1-2/044-managed-terminal-handoff.cjs');",
            'const loaderPath=process.argv[1];',
            "const loader=patch.__testing.transformPluginLoader(fs.readFileSync(loaderPath,'utf8'),loaderPath);",
            'const start=loader.indexOf(\'const MARKER = "JUSTDO_MANAGED_TERMINAL_HANDOFF_V2026_7_1_2";\');',
            "const end=loader.indexOf('function loadOpenClawPlugins(options = {})');",
            "if(start<0||end<=start)throw new Error('embedded gate anchors missing');",
            'const sandbox={process};',
            "vm.runInNewContext(loader.slice(start,end)+'\\nglobalThis.patch=patchJustDoOfficialCodexPlugin;',sandbox);",
            'const params=JSON.parse(process.argv[2]);params.resolveInstallPath=value=>value;',
            'process.stdout.write(JSON.stringify(sandbox.patch(params)));',
          ].join(''),
          loaderPath,
          JSON.stringify({ ...params, resolveInstallPath: undefined }),
        ],
        { cwd: path.resolve('.'), encoding: 'utf8' },
      );
      expect(embeddedGate.status, embeddedGate.stderr).toBe(0);
      expect(JSON.parse(embeddedGate.stdout)).toEqual({ status: 'patched' });
      expect(fs.readFileSync(attemptPath, 'utf8')).toBe(patchedAttempt);
      expect(fs.readFileSync(providerPath, 'utf8')).toBe(patchedProvider);

      const roleBackup = `${attemptPath}.justdo-role.bak`;
      fs.copyFileSync(attemptPath, roleBackup);
      fs.writeFileSync(attemptPath, patchedProvider);
      expect(patch.__testing.patchJustDoOfficialCodexPlugin(params)).toEqual({
        status: 'verified',
      });
      expect(fs.readFileSync(attemptPath, 'utf8')).toBe(patchedAttempt);

      const crashedBackup = `${attemptPath}.justdo-crash.bak`;
      fs.renameSync(attemptPath, crashedBackup);
      fs.writeFileSync(path.join(fixtureRoot, '.justdo-managed-codex-patch.lock'), 'stale');
      const staleAt = new Date(Date.now() - 180_000);
      fs.utimesSync(
        path.join(fixtureRoot, '.justdo-managed-codex-patch.lock'),
        staleAt,
        staleAt,
      );
      expect(patch.__testing.patchJustDoOfficialCodexPlugin(params)).toEqual({
        status: 'verified',
      });
      expect(fs.existsSync(crashedBackup)).toBe(false);

      const recoverableBackup = `${providerPath}.justdo-recover.bak`;
      fs.copyFileSync(providerPath, recoverableBackup);
      fs.writeFileSync(providerPath, 'invalid interrupted replacement');
      expect(patch.__testing.patchJustDoOfficialCodexPlugin(params)).toEqual({
        status: 'verified',
      });
      expect(fs.readFileSync(providerPath, 'utf8')).toBe(patchedProvider);

      fs.writeFileSync(attemptPath, attemptSource);
      fs.writeFileSync(providerPath, providerSource);
      expect(patch.__testing.patchJustDoOfficialCodexPlugin(params)).toEqual({
        status: 'patched',
      });
      expect(fs.readdirSync(fixtureRoot).some(name => name.includes('.justdo-'))).toBe(false);

      fs.writeFileSync(attemptPath, attemptSource);
      fs.writeFileSync(providerPath, providerSource);
      const originalRenameSync = fs.renameSync;
      const renameFailure = vi.spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => {
        if (
          String(oldPath).startsWith(providerPath) &&
          String(oldPath).endsWith('.tmp') &&
          newPath === providerPath
        )
          throw new Error('injected provider replacement failure');
        return originalRenameSync(oldPath, newPath);
      });
      expect(() => patch.__testing.patchJustDoOfficialCodexPlugin(params)).toThrow(
        /injected provider replacement failure/,
      );
      renameFailure.mockRestore();
      expect(fs.readFileSync(attemptPath, 'utf8')).toBe(attemptSource);
      expect(fs.readFileSync(providerPath, 'utf8')).toBe(providerSource);

      const originalRmSync = fs.rmSync;
      const cleanupFailure = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
        if (String(target).endsWith('.bak')) throw new Error('injected backup cleanup failure');
        return originalRmSync(target, options);
      });
      expect(patch.__testing.patchJustDoOfficialCodexPlugin(params)).toEqual({
        status: 'patched',
      });
      cleanupFailure.mockRestore();
      expect(fs.readFileSync(attemptPath, 'utf8')).toBe(patchedAttempt);
      expect(fs.readFileSync(providerPath, 'utf8')).toBe(patchedProvider);
      expect(patch.__testing.patchJustDoOfficialCodexPlugin(params)).toEqual({
        status: 'verified',
      });

      expect(() =>
        patch.__testing.patchJustDoOfficialCodexPlugin({
          ...params,
          installRecord: { ...params.installRecord, resolvedVersion: '2026.7.2' },
        }),
      ).toThrow(/version mismatch/);
      expect(() =>
        patch.__testing.patchJustDoOfficialCodexPlugin({
          ...params,
          trustedOfficialInstall: false,
        }),
      ).toThrow(/untrusted/);

      const linkedProvider = path.join(fixtureRoot, 'provider-hardlink-source.js');
      fs.copyFileSync(providerPath, linkedProvider);
      fs.rmSync(providerPath);
      fs.linkSync(linkedProvider, providerPath);
      expect(() => patch.__testing.patchJustDoOfficialCodexPlugin(params)).toThrow(/Unsafe/);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('applies and verifies source plus gateway targets idempotently', () => {
    const sourceRoot = path.resolve('vendor/openclaw-runtime/win-x64');
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-terminal-handoff-patch-'));
    const fixtureDist = path.join(fixtureRoot, 'dist');
    fs.mkdirSync(fixtureDist, { recursive: true });
    const targetFiles = [
      'openclaw-tools-KulZ1cdH.js',
      'selection-JInn13lc.js',
      'subagent-registry-DexSZ4w1.js',
      'loader-D8d2EvVh.js',
      'runtime-plugin-install-DIbOhSHk.js',
    ];
    for (const fileName of targetFiles)
      fs.copyFileSync(path.join(sourceRoot, 'dist', fileName), path.join(fixtureDist, fileName));
    fs.copyFileSync(
      path.join(sourceRoot, 'gateway-bundle.mjs'),
      path.join(fixtureRoot, 'gateway-bundle.mjs'),
    );
    try {
      expect([0, 6]).toContain(patch.applyPatch(fixtureRoot).length);
      expect(() => patch.verifyPatch(fixtureRoot)).not.toThrow();
      expect(patch.applyPatch(fixtureRoot)).toEqual([]);
      expect(() => patch.verifyPatch(fixtureRoot)).not.toThrow();
      for (const filePath of [
        path.join(fixtureDist, 'loader-D8d2EvVh.js'),
        path.join(fixtureRoot, 'gateway-bundle.mjs'),
      ]) {
        const syntax = spawnSync(process.execPath, ['--check', filePath], { encoding: 'utf8' });
        expect(syntax.status, syntax.stderr).toBe(0);
      }
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 20_000);
});
