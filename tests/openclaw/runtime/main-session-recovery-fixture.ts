/* eslint-disable @typescript-eslint/no-explicit-any -- Execute locked native declarations with explicit I/O and admission seams. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import vm from 'node:vm';

import ts from 'typescript';
import { expect } from 'vitest';

export const recoveryOwner = 'dist/main-session-restart-recovery-BePtcRv6.mjs';
export const orphanOwner = 'dist/main-session-restart-recovery-marking-D6u8nmJ_.mjs';

export function nativeSource(root: string, file: string): string {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  expect({ name: metadata.name, version: metadata.version }).toEqual({ name: 'openclaw', version: '2026.10.7' });
  return fs.readFileSync(path.join(root, file), 'utf8');
}

export function nativeDeclarations(source: string, names?: readonly string[], constants: readonly string[] = []): string {
  const ast = ts.createSourceFile('native.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  expect((ast as ts.SourceFile & { parseDiagnostics: readonly unknown[] }).parseDiagnostics).toEqual([]);
  const selected = ast.statements.filter(statement => {
    if (ts.isFunctionDeclaration(statement) && statement.name) return !names || names.includes(statement.name.text);
    return ts.isVariableStatement(statement) && statement.declarationList.declarations.every(declaration =>
      ts.isIdentifier(declaration.name) && constants.includes(declaration.name.text));
  });
  if (names) expect(selected.filter(ts.isFunctionDeclaration)).toHaveLength(names.length);
  return selected.map(statement => statement.getText(ast)).join('\n');
}

// Compile in the calling realm so node:util compares ordinary native objects;
// a fresh vm.Context would give cloned expected facts different prototypes.
export function executeNative(source: string, dependencies: Record<string, any>, exports: readonly string[]): any {
  return vm.compileFunction(`const {${Object.keys(dependencies).join(',')}} = dependencies;\n${source}\nreturn {${exports.join(',')}};`, ['dependencies'], {
    importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  })(dependencies);
}

export function nativeAlgorithms(root: string): Record<string, any> {
  const declaration = (file: string, names?: readonly string[], constants?: readonly string[]) =>
    nativeDeclarations(nativeSource(root, `dist/${file}`), names, constants);
  const publication = ['normalizeMainSessionRecoveryRunFences', 'recordLifecycleFence', 'isMainRestartRecoveryCandidate',
    'normalizeRestartRecoveryTerminalRunIds', 'mergeRestartRecoveryTerminalRunIds', 'hasRestartRecoveryTerminalRun',
    'isRetryableUnadoptedChatClaim', 'hasMainSessionRecoveryClaim', 'buildRestartRecoveryClaimCleanupPatch'];
  const state = declaration('main-session-recovery-state-Bm0aF5ZV.mjs');
  const algorithmNames = ['deriveGatewaySessionLifecycleSnapshot', 'transitionMainSessionRecovery',
    'isMainSessionRecoveryPending', 'hasMainSessionRecoveryClaim', 'isMainRestartRecoveryCandidate',
    'isMainRestartRecoveryTerminalOnly', 'isTerminalSessionStatus', 'buildMainSessionRecoverySettlementPatch',
    'buildRestartRecoveryExpectedState', 'getMainSessionRecoveryRetryCount', 'normalizeOptionalString',
    'hasCompletedMainSessionRecoveryOutcome', 'isRetryableUnadoptedChatClaim', 'resolveRestartRecoveryTerminalClientRunId'];
  const program = [
    declaration('string-coerce-1VuiLaaR.mjs', ['normalizeNullableString', 'normalizeOptionalString',
      'normalizeOptionalLowercaseString', 'normalizeLowercaseStringOrEmpty']),
    declaration('session-key-CmZ4o9-l.mjs', ['parseAgentSessionKeyParts']),
    declaration('session-key-utils-CDyBC9Gn.mjs', undefined, ['SIGNAL_GROUP_ID_PATTERN', 'MATRIX_ROOM_KEY_PATTERN',
      'NORMALIZED_SESSION_KEY_CACHE_MAX_ENTRIES', 'NORMALIZED_SESSION_KEY_CACHE_MAX_LENGTH', 'normalizedSessionKeyCache']),
    declaration('session-accessor.sqlite-entry-worker-publication-CvWHlmO2.mjs', publication),
    declaration('types-BGDhC4_W.mjs', ['isTerminalSessionStatus']),
    declaration('main-session-recovery-clear-DVPOqSuB.mjs', undefined, ['MAIN_SESSION_RECOVERY_CLEAR_PATCH']),
    declaration('session-transcript-turn-state-BDqq7zcw.mjs', ['buildRestartRecoveryExpectedState']),
    state,
    declaration('main-session-restart-recovery-shared-D3biIs8_.mjs', ['resolveRestartRecoveryTerminalClientRunId']),
    declaration('session-event-payload-Cq41wHZJ.mjs', ['isFiniteTimestamp', 'resolveLifecyclePhase',
      'resolveLifecycleTimestamp', 'deriveGatewaySessionLifecycleSnapshot']),
  ].join('\n');
  return executeNative(program, {}, algorithmNames);
}

const nativeImport = vm.compileFunction('return import(url)', ['url'], {
  importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
}) as (url: string) => Promise<Record<string, any>>;

export async function recoveryFixture(root: string, options: {
  liveOwner?: boolean;
  replaceBeforeObserve?: boolean;
  rejectDispatch?: boolean;
} = {}) {
  const algorithms = nativeAlgorithms(root);
  const raw = (file: string, names?: readonly string[], constants?: readonly string[]) =>
    nativeDeclarations(nativeSource(root, `dist/${file}`), names, constants);
  const key = 'agent:main:conversation';
  const sourceRunId = 'accepted-source-run';
  let entry: Record<string, any> = {
    sessionId: 'physical-session', lifecycleRevision: 'physical-revision',
    ...algorithms.deriveGatewaySessionLifecycleSnapshot({
      event: { runId: sourceRunId, ts: 50, data: { phase: 'start' } },
    }),
    lifecycleRunId: sourceRunId, restartRecoveryDeliveryRunId: sourceRunId,
    restartRecoveryDeliverySourceRunId: sourceRunId, restartRecoverySourceIngress: 'control-ui',
    restartRecoveryBeforeAgentReplyState: 'pending',
  };
  expect(entry.status).toBeUndefined();
  algorithms.transitionMainSessionRecovery(entry, { kind: 'mark_interrupted', cycleId: 'native-cycle', now: 80,
    runs: [{ runId: sourceRunId, lifecycleGeneration: 'previous-gateway' }] });
  const interrupted = structuredClone(entry);
  const generation = 'current-gateway';
  let sequence = 0;
  const dispatches: Record<string, any>[] = [];
  const logs: string[] = [];
  const commands: string[] = [];
  const sanitizer = await nativeImport(pathToFileURL(path.join(root, 'dist/pending-final-delivery-state-DyvoZRc2.mjs')).href);
  const transport = await nativeImport(pathToFileURL(path.join(root, 'dist/request-error-DgMXHa-w.mjs')).href);
  const purePolicy = executeNative([
    raw('record-coerce-TIsquoVR.mjs'),
    raw('message-visibility-DzWRqiaV.mjs', ['getTranscriptMessageRole', 'readTerminalSourceReplyDeliveryMirror']),
    raw('run-termination-5c-0T0hN.mjs', [], ['AGENT_RUN_RESTART_ABORT_ERROR', 'AGENT_RUN_RESTART_ABORT_ERROR_CODE']),
    raw('main-session-restart-recovery-resume-policy-1L5Q04-X.mjs', undefined,
      ['LEGACY_RESTART_ABORT_ERROR_MESSAGES', 'CODE_MODE_RESTART_ABORT_ERROR']),
  ].join('\n'), algorithms, ['resolveMainSessionResumePolicy', 'hasReplaySafeCodeModeCheckpointInCurrentTurn']);
  const exactWrite = async (params: any) => {
    const original = structuredClone(entry);
    const staged = { sessionKey: key, entry: structuredClone(entry) };
    const operation = await params.update([staged]);
    params.assertCommitAllowed?.();
    if (operation.replacements?.length) {
      if (!isDeepStrictEqual(original, entry)) throw new Error('Native row changed before commit');
      entry = structuredClone(operation.replacements[0].entry);
    }
    return operation.result;
  };
  const commit = async ({ command }: any) => {
    commands.push(command.kind);
    if (options.replaceBeforeObserve && command.kind === 'observe') entry = {
      sessionId: 'replacement-session', lifecycleRevision: 'replacement-revision', status: 'done',
    };
    return exactWrite({ update: (rows: any[]) => {
      const current = rows[0];
      return { result: { entry: current.entry, sessionKey: key,
        transition: algorithms.transitionMainSessionRecovery(current.entry, command) }, replacements: [current] };
    } });
  };
  const dependencies = {
    ...algorithms, ...purePolicy,
    normalizeDeliveryContext: executeNative(raw('delivery-context.shared-DhM_VJwb.mjs', ['normalizeDeliveryContext']), {},
      ['normalizeDeliveryContext']).normalizeDeliveryContext,
    sanitizePendingFinalDeliveryText: sanitizer.r,
    GatewayClientRequestError: transport.t,
    promiseWithResolvers: Promise,
    getAgentEventLifecycleGeneration: () => generation,
    randomUUID: () => `native-recovery-${++sequence}`,
    createCurrentProcessOwnerLookup: () => () => options.liveOwner === true,
    readSessionEntrySummariesInWorker: async () => [{ sessionKey: key, entry: structuredClone(entry) }],
    loadExactSessionEntry: () => ({ sessionKey: key, entry: structuredClone(entry) }),
    applySessionEntryExactReplacements: exactWrite,
    commitMainSessionRecovery: commit,
    // Resolved configuration, history and registry reads are explicit fixture
    // inputs. Their policy/permission implementations are outside this contract.
    resolveExecDefaults: () => ({ mode: 'guarded', security: 'allowlist', ask: 'on-miss' }),
    resolveRestartRecoveryDispatchTarget: () => ({ agentId: 'main', sessionKey: key }),
    resolveSessionWorkStartBlock: () => undefined,
    canPrepareAgentSessionWorktree: () => false,
    readSessionMessagesAsync: async () => [{ role: 'user', content: 'Continue the accepted task' }],
    readSessionTranscriptSummaryAsync: async () => ({ checkpoint: { source: 'external_user', replaySafe: false } }),
    preparePhysicalSessionStorePath: async () => 'controlled-memory-store',
    listSubagentRunsForRequester: () => [],
    retryMainSessionRecoveryMutation: async (mutation: () => Promise<any>) => mutation(),
    mainSessionRecoveryLog: { info: (line: string) => logs.push(line), warn: (line: string) => logs.push(line) },
  };
  const mainSource = nativeSource(root, recoveryOwner);
  expect(mainSource).not.toContain('RUNTIME_APP_STARTUP_MAIN_RECOVERY_BOUNDARY');
  const program = [
    raw('deferred-D0La5CRk.mjs'),
    raw('audit-config-BXFCjLO0.mjs'),
    raw('subagent-restart-recovery-prompt-CRy0um7d.mjs', undefined,
      ['MAX_RECOVERY_CHILDREN', 'MAX_RECOVERY_LABEL_CHARS', 'SUBAGENT_RESTART_RECOVERY_INSTRUCTION']),
    raw('restart-recovery-prompt-DapLmbKm.mjs', [], ['RESTART_RECOVERY_INTERRUPTION_NOTE']),
    raw('tool-outcome-instructions-D1-OxlK6.mjs', [], ['TOOL_FAILURE_INSTRUCTION']),
    raw('system-turn-prompt-CqPm0DzY.mjs', undefined, ['SYSTEM_TURN_PROMPT_PREFIX']),
    raw('input-provenance-B5YZS2Do.mjs', [], ['MAIN_SESSION_RESTART_RECOVERY_SOURCE_TOOL']),
    raw('main-session-recovery-admission-B6aPJZHg.mjs', undefined, ['MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER']),
    raw('main-session-restart-recovery-diagnostics-TpTMS6VK.mjs', ['skippedMainSessionRecoveryDecision']),
    nativeDeclarations(mainSource, undefined, ['RESTART_RECOVERY_START_OBSERVATION_MS',
      'RESTART_RECOVERY_RESUME_MESSAGE', 'RESTART_SAFE_TOOLS_NOTICE']),
  ].join('\n');
  const owners = executeNative(program, dependencies, ['recoverStore']);
  const gatewayRuntime = {
    dispatchAgent: (params: any, _timeout: unknown, callbacks: any) => {
      callbacks.assertAdmissionCurrent();
      dispatches.push(structuredClone(params));
      if (options.rejectDispatch) throw new transport.t({ code: 'UNAVAILABLE', message: 'Controlled dispatch rejection' });
      callbacks.onAccepted();
      callbacks.onStartOwner({ observe: () => ({ executionStarted: true }), abort: () => false });
      callbacks.onExecutionStarted();
      return new Promise(() => {});
    },
  };
  const handled = new Set<string>();
  return { algorithms, interrupted, sourceRunId, key, logs, commands, dispatches, entry: () => entry,
    run: () => owners.recoverStore({ storeAgentId: 'main', storePath: 'controlled-memory-store',
      gatewayRuntime, handledSessionKeys: handled, lifecycleGeneration: generation,
      recoveryAdmission: { handoffId: 'admitted-fixture-handoff', shouldContinue: () => true, beginDispatch: () => true },
    }) };
}
