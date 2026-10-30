import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

import { nativePlanningConstraint, PlanningConstraint } from '@app-plugin/sdk/planning';
import { createExecutionAdmissionClient } from '@runtime-services/sdk/admission-client';
import { withCodexSessionTranscriptMirrorWriteLock } from 'openclaw/plugin-sdk/codex-session-transcript-runtime';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

import { AgentTeamLaunchLedger } from './agent-team-launch-ledger';
import {
  assertNativeIdentity,
  type Identity,
  type Launch,
  type LaunchState,
  managed,
  MAX_CORRECTIONS,
  NAMESPACE,
  nativeEntry,
  OPERATIONS,
  OWNER,
  parseLaunch,
  readLaunch,
  record,
  type RecordValue,
} from './agent-team-launch-state';

export { blocksWorkflowStartDuringTeamLaunch } from './agent-team-launch-state';

const POLICY_ID = 'agent-team-launch';
type TranscriptFactsLock = {
  readMessageFacts(params: { idempotencyKeys: readonly string[] }): Promise<{
    messagesByIdempotencyKey: Map<string, unknown>;
    anchorsByIdempotencyKey: Map<string, { sessionKey: string; sessionId: string; entryId: string; generation: string }>;
  }>;
};
const TEAM_LAUNCH_CONFLICT_TOOLS: ReadonlySet<string> = new Set([
  'swarm_workflow_start',
  'team_discussion',
  'task_assistants',
  'sessions_send',
]);

function sameRequest(left: Launch, right: Launch): boolean {
  return [
    'sessionKey',
    'nativeSessionId',
    'lifecycleRevision',
    'clientTurnId',
    'promptSha256',
    'mode',
    'generation',
  ].every(key => left[key as keyof Launch] === right[key as keyof Launch]);
}
function assertLaunchEligible(launch: Launch): void {
  const entry = nativeEntry(launch.sessionKey);
  if (
    !entry ||
    entry.goal != null ||
    entry.permissionMode === 'read-only' ||
    // A native schema mismatch cannot make an otherwise restricted launch safe.
    (entry.permissionMode != null &&
      !['guarded', 'workspace', 'full'].includes(String(entry.permissionMode))) ||
    nativePlanningConstraint(entry) !== PlanningConstraint.Unrestricted
  )
    throw new Error('Agent Team launch is unavailable for this native session state.');
}
function inputText(message: RecordValue): string | undefined {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const texts = message.content.flatMap(part =>
    record(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
  );
  return texts.length === 1 ? texts[0] : undefined;
}
function enabled(api: OpenClawPluginApi): boolean {
  const plugins = api.runtime.config.current().plugins;
  return (
    plugins?.enabled !== false &&
    plugins?.entries?.['agent-team']?.enabled === true &&
    !plugins?.deny?.includes('agent-team') &&
    (!plugins?.allow?.length || plugins.allow.includes('agent-team'))
  );
}

/** A launch intent checks source identity and Team operations. It never grants tools. */
export function registerAgentTeamLaunchGuard(api: OpenClawPluginApi): void {
  const ledger = new AgentTeamLaunchLedger(api.runtime.state.resolveStateDir());
  const writeAuthority = new AsyncLocalStorage<(() => void) | undefined>();
  let retired = false;
  let stopped = true;
  let serviceRevision = 0;
  const admission = createExecutionAdmissionClient(api);
  // Hot replacement starts candidate services before publishing their proof RPC.
  // Published control requests bind the owner below, before any business write.
  api.registerService({
    id: 'agent-team-launch',
    start() {
      serviceRevision++;
      if (retired || api.lifecycle.signal?.aborted !== false)
        throw new Error('Agent Team launch guard registration was retired.');
      stopped = false;
    },
    stop() { stopped = true; serviceRevision++; },
  });
  const updateAdmission = async (launch: Launch, operation: Parameters<typeof admission.update>[1],
    evidence: Parameters<typeof admission.update>[2] = {}) => {
    let reference = launch.executionAdmission;
    if (!reference) {
      const snapshot = await admission.inspect({ sessionKey: launch.sessionKey, sessionId: launch.nativeSessionId });
      if (operation === 'abandon' && snapshot.state === 'clear') return;
      if (snapshot.state !== 'held' || snapshot.receipt.runId !== launch.clientTurnId ||
          snapshot.receipt.sessionId !== launch.nativeSessionId) throw new Error('Execution admission is unconfirmed.');
      reference = snapshot.receipt;
    }
    await admission.update({ sessionKey: launch.sessionKey, ...reference }, operation, evidence);
  };
  const operationKey = (sessionKey: string) => `${ledger.directory}:${sessionKey}`;
  const read = (sessionKey: string) =>
    OPERATIONS.uncertain.has(operationKey(sessionKey))
      ? { raw: { unconfirmedWrite: true }, launch: undefined }
      : readLaunch(sessionKey, ledger);
  api.session.state.registerSessionExtension({
    namespace: NAMESPACE,
    description: 'Content-free verification and correction state for an explicit Team launch.',
    cleanup(ctx) {
      // Session reset/delete does not erase an unsettled durable execution.
      // Instance retirement only revokes this registration's late writers.
      if (!ctx.sessionKey && ['disable', 'restart'].includes(ctx.reason)) {
        retired = true;
        admission.dispose();
      }
    },
  });
  const { locks, revoked } = OPERATIONS;
  const revocationKey = (launch: Launch) => `${launch.nativeSessionId}:${launch.clientTurnId}`;
  const serial = async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const scopedKey = operationKey(key);
    const previous = locks.get(scopedKey) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(work);
    locks.set(scopedKey, pending);
    try {
      return await pending;
    } finally {
      if (locks.get(scopedKey) === pending) locks.delete(scopedKey);
    }
  };
  const save = async (launch: Launch): Promise<void> => {
    if (retired) throw new Error('Agent Team launch guard registration was retired.');
    writeAuthority.getStore()?.();
    const scopedKey = operationKey(launch.sessionKey);
    OPERATIONS.uncertain.add(scopedKey);
    // Persist closed metadata before acknowledging any native projection. A
    // normal plugin retirement clears pluginExtensions, but never this ledger.
    ledger.write(launch.sessionKey, launch);
    OPERATIONS.uncertain.delete(scopedKey);
    const result = await api.runtime.gateway.request<{ ok?: boolean }>(
      'sessions.pluginPatch',
      {
        key: launch.sessionKey,
        pluginId: 'agent-team',
        namespace: NAMESPACE,
        value: launch,
      },
      { scopes: ['operator.admin'] },
    );
    if (retired) throw new Error('Agent Team launch guard registration was retired.');
    writeAuthority.getStore()?.();
    if (result.ok !== true) throw new Error('Agent Team launch state could not be committed.');
  };
  const assertLive = (launch: Launch): void => {
    const current = read(launch.sessionKey).launch;
    if (
      retired ||
      !current ||
      !sameRequest(current, launch) ||
      current.owner !== OWNER ||
      revoked.get(operationKey(launch.sessionKey)) === revocationKey(current) ||
      current.state === 'cancelled' ||
      current.state === 'released'
    )
      throw new Error('Agent Team launch is no longer current.');
    assertNativeIdentity(current);
    assertLaunchEligible(current);
  };
  const facts = async (launch: Launch, ctx: Identity) => {
    assertNativeIdentity(launch, ctx);
    const key = `${launch.clientTurnId}:user`;
    const result = await withCodexSessionTranscriptMirrorWriteLock(
      {
        agentId: launch.sessionKey.split(':')[1],
        sessionKey: launch.sessionKey,
        sessionId: launch.nativeSessionId,
      },
      (locked: TranscriptFactsLock) => locked.readMessageFacts({ idempotencyKeys: [key] }),
    );
    const message = result.messagesByIdempotencyKey.get(key) as unknown;
    const anchor = result.anchorsByIdempotencyKey.get(key);
    const text = record(message) ? inputText(message) : undefined;
    if (
      !record(message) ||
      message.role !== 'user' ||
      message.provenance != null ||
      !record(message.__openclaw) ||
      message.__openclaw.senderIsOwner !== true ||
      text === undefined ||
      createHash('sha256').update(text).digest('hex') !== launch.promptSha256 ||
      !anchor ||
      anchor.sessionKey !== launch.sessionKey ||
      anchor.sessionId !== launch.nativeSessionId ||
      (launch.entryId && launch.entryId !== anchor.entryId) ||
      (launch.transcriptGeneration && launch.transcriptGeneration !== anchor.generation)
    )
      throw new Error('The exact explicit Agent Team input could not be verified.');
    assertLive(launch);
    return anchor;
  };
  const rpc = (operation: string, params: RecordValue) =>
    api.runtime.gateway.request(`agentTeam.launch.${operation}`, params, {
      scopes: ['operator.admin'],
    });
  const method = (name: string, handler: (params: RecordValue) => Promise<unknown>) => {
    api.registerGatewayMethod(
      `agentTeam.launch.${name}`,
      async ({
        params,
        respond,
        client,
        signal,
        hasCurrentClientAuthority,
        sessionMutationCommitGuard,
      }) => {
        try {
          const revision = serviceRevision;
          const assertAuthority = () => {
            if (
              retired ||
              stopped || revision !== serviceRevision ||
              api.lifecycle.signal?.aborted !== false ||
              signal?.aborted ||
              client?.connect.client.mode !== 'backend' ||
              hasCurrentClientAuthority?.() === false
            )
              throw new Error('Agent Team launch control requires the trusted backend.');
            sessionMutationCommitGuard?.();
          };
          assertAuthority();
          if (!await admission.bind()) throw new Error('Execution admission owner is unavailable.');
          assertAuthority();
          if (!managed(params.sessionKey)) throw new Error('Invalid Agent Team source.');
          if (name === 'cancel') {
            const current = currentFor(params);
            revoked.set(operationKey(current.sessionKey), revocationKey(current));
          } else if (['verify', 'attempt', 'status', 'confirm', 'revise'].includes(name)) {
            // Cancellation closes admission before any queued metadata write or
            // asynchronous native input read can complete.
            assertLive(currentFor(params));
          }
          const value = await serial(params.sessionKey, () =>
            writeAuthority.run(assertAuthority, async () => {
              assertAuthority();
              const result = await handler(params);
              assertAuthority();
              return result;
            }),
          );
          respond(true, value);
        } catch (error) {
          respond(false, undefined, {
            code: 'invalid_request',
            message: error instanceof Error ? error.message : 'Agent Team launch control failed.',
          });
        }
      },
      { scope: 'operator.admin', profileAccess: 'independent' },
    );
  };
  const stopEvents = api.runtime.events.onAgentEvent(event => {
    if (
      retired ||
      !managed(event.sessionKey) ||
      event.stream !== 'lifecycle' ||
      event.data?.executionSettled !== true ||
      !['end', 'error'].includes(String(event.data.phase))
    )
      return;
    const launch = read(event.sessionKey).launch;
    if (
      !launch ||
      launch.owner !== OWNER ||
      event.runId !== launch.clientTurnId ||
      event.sessionId !== launch.nativeSessionId
    )
      return;
    void writeAuthority
      .run(undefined, () =>
        serial(launch.sessionKey, async () => {
          const current = read(launch.sessionKey).launch;
          if (!current || !sameRequest(current, launch) || current.owner !== OWNER) return;
          assertNativeIdentity(current);
          // Publication establishes a whole-run outcome; it is deliberately not a
          // dispatcher-cleanup receipt. Main still needs a fresh native idle read.
          await save({
            ...current,
            wholeSettled: {
              runId: event.runId,
              nativeSessionId: launch.nativeSessionId,
              phase: event.data.phase as 'end' | 'error',
              seq: event.seq,
            },
          });
        }),
      )
      .catch(() => undefined);
  });
  api.lifecycle.onDispose?.(() => {
    retired = true;
    admission.dispose();
    stopEvents();
  });
  method('inspect', async params => {
    let state = read(String(params.sessionKey));
    if (state.launch?.executionAdmission) {
      const snapshot = await admission.inspect({ sessionKey: state.launch.sessionKey, sessionId: state.launch.nativeSessionId });
      if (snapshot.state === 'clear' && snapshot.receipt?.id === state.launch.executionAdmission.id &&
          snapshot.receipt.generation === state.launch.executionAdmission.generation && snapshot.receipt.state === 'released') {
        await save({ ...state.launch, state: 'released' });
        state = read(String(params.sessionKey));
      }
    }
    if (state.raw === undefined) return { state: 'absent', generation: 0 };
    if (!state.launch) return { state: 'unknown' };
    const launch = state.launch;
    const entry = nativeEntry(launch.sessionKey);
    const currentIdentityMatches =
      entry?.sessionId === launch.nativeSessionId &&
      (entry.lifecycleRevision ?? null) === launch.lifecycleRevision;
    if (launch.state === 'released') {
      // A released tombstone closes its old incarnation. Historical receipts
      // remain readable after reset, and the current native incarnation can
      // read its next generation without inheriting any execution proof.
      if (
        params.nativeSessionId !== launch.nativeSessionId &&
        (!entry?.sessionId || params.nativeSessionId !== entry.sessionId)
      )
        throw new Error('Agent Team launch source changed.');
    } else {
      if (params.nativeSessionId !== launch.nativeSessionId)
        throw new Error('Agent Team launch source changed.');
      assertNativeIdentity(launch);
    }
    return {
      generation: launch.generation,
      state: launch.owner === OWNER || launch.state === 'released' ? launch.state : 'unknown',
      wholeSettled:
        currentIdentityMatches &&
        params.nativeSessionId === launch.nativeSessionId &&
        launch.wholeSettled?.runId === launch.clientTurnId &&
        launch.wholeSettled?.nativeSessionId === launch.nativeSessionId &&
        ['end', 'error'].includes(String(launch.wholeSettled?.phase)),
      launch: {
        generation: launch.generation,
        sessionKey: launch.sessionKey,
        nativeSessionId: launch.nativeSessionId,
        lifecycleRevision: launch.lifecycleRevision,
        clientTurnId: launch.clientTurnId,
        promptSha256: launch.promptSha256,
        mode: launch.mode,
        state: launch.state,
        corrections: launch.corrections,
        executionAdmission: launch.executionAdmission,
      },
    };
  });
  method('register', async params => {
    if (
      !Number.isSafeInteger(params.expectedGeneration) ||
      Number(params.expectedGeneration) < 0 ||
      Number(params.expectedGeneration) >= Number.MAX_SAFE_INTEGER
    )
      throw new Error('Missing exact Agent Team launch generation.');
    const entry = managed(params.sessionKey) ? nativeEntry(params.sessionKey) : undefined;
    const proposed = parseLaunch({
      ...params,
      lifecycleRevision:
        params.lifecycleRevision === undefined
          ? (entry?.lifecycleRevision ?? null)
          : params.lifecycleRevision,
      generation: Number(params.expectedGeneration) + 1,
      owner: OWNER,
      state: 'pending',
      corrections: 0,
    });
    if (!proposed) throw new Error('Invalid Agent Team launch intent.');
    assertNativeIdentity(proposed);
    assertLaunchEligible(proposed);
    if (!enabled(api)) throw new Error('Agent Team is disabled.');
    const current = read(proposed.sessionKey);
    if (current.raw !== undefined && !current.launch)
      throw new Error('Agent Team launch state is unconfirmed.');
    if (current.launch) {
      if (sameRequest(current.launch, proposed) && current.launch.state !== 'released')
        return {
          state: current.launch.owner === OWNER ? current.launch.state : 'unknown',
          nativeSessionId: current.launch.nativeSessionId,
          lifecycleRevision: current.launch.lifecycleRevision,
          generation: current.launch.generation,
          executionAdmission: current.launch.executionAdmission,
        };
      if (
        current.launch.state !== 'released' ||
        current.launch.clientTurnId === proposed.clientTurnId
      )
        throw new Error('Previous Agent Team launch requires reconciliation.');
    }
    if ((current.launch?.generation ?? 0) !== params.expectedGeneration)
      throw new Error('Agent Team launch generation changed.');
    assertLaunchEligible(proposed);
    const available = await admission.inspect({ sessionKey: proposed.sessionKey, sessionId: proposed.nativeSessionId });
    if (available.state !== 'clear') throw new Error('An execution admission is already held or unknown.');
    const reserved = await admission.reserve({
      sessionKey: proposed.sessionKey, sessionId: proposed.nativeSessionId,
      lifecycleRevision: proposed.lifecycleRevision, runId: proposed.clientTurnId,
      expectedGeneration: available.generation,
    });
    proposed.executionAdmission = { id: reserved.id, generation: reserved.generation };
    await save(proposed);
    assertNativeIdentity(proposed);
    assertLaunchEligible(proposed);
    revoked.delete(operationKey(proposed.sessionKey));
    return {
      state: 'pending',
      nativeSessionId: proposed.nativeSessionId,
      lifecycleRevision: proposed.lifecycleRevision,
      generation: proposed.generation,
      executionAdmission: proposed.executionAdmission,
    };
  });
  const currentFor = (params: RecordValue): Launch => {
    const current = read(String(params.sessionKey)).launch;
    if (
      !current ||
      current.clientTurnId !== params.clientTurnId ||
      current.nativeSessionId !== params.nativeSessionId
    )
      throw new Error('Agent Team launch request changed.');
    return current;
  };
  const verifyCurrent = async (params: RecordValue): Promise<Launch> => {
    const current = currentFor(params);
    assertLive(current);
    if (!['pending', 'verified', 'attempted', 'launched'].includes(current.state))
      throw new Error('Unverified Agent Team launch.');
    const anchor = await facts(current, {
      sessionKey: current.sessionKey,
      sessionId: current.nativeSessionId,
      runId: String(params.runId),
    });
    if (current.state !== 'pending') return current;
    const verified: Launch = {
      ...current,
      state: 'verified',
      entryId: anchor.entryId,
      transcriptGeneration: anchor.generation,
    };
    await updateAdmission(current, 'verify');
    await save(verified);
    assertLive(verified);
    return verified;
  };
  method('verify', async params => {
    const current = await verifyCurrent(params);
    return { state: current.state };
  });
  method('attempt', async params => {
    const current = currentFor(params);
    assertLive(current);
    if (!['verified', 'attempted', 'launched'].includes(current.state))
      throw new Error('Unverified Agent Team launch.');
    await facts(current, {
      sessionKey: current.sessionKey,
      sessionId: current.nativeSessionId,
      runId: String(params.runId),
    });
    if (current.state === 'verified') {
      await updateAdmission(current, 'issued');
      await save({ ...current, state: 'attempted' });
      assertLive(current);
    }
    return { state: current.state === 'verified' ? 'attempted' : current.state };
  });
  method('status', async params => {
    // A normal input can become durable after prompt enrichment. Re-check only
    // this registered run/input pair; a native queued UUID remains unverified.
    const current = await verifyCurrent(params);
    return { state: current.state };
  });
  method('confirm', async params => {
    const current = currentFor(params);
    assertLive(current);
    if (
      !['verified', 'attempted', 'launched'].includes(current.state) ||
      params.mode !== current.mode ||
      typeof params.receiptId !== 'string' ||
      !params.receiptId
    )
      throw new Error('Missing exact accepted Agent Team receipt.');
    await updateAdmission(current, 'accepted', { receiptId: String(params.receiptId) });
    await save({ ...current, state: 'launched' });
    return { state: 'launched' };
  });
  method('cancel', async params => {
    const current = currentFor(params);
    if (current.state !== 'released') {
      await updateAdmission(current, 'revoke');
      await save({ ...current, state: 'cancelled' });
    }
    return { state: current.state === 'released' ? 'released' : 'cancelled' };
  });
  method('abandon', async params => {
    const state = read(String(params.sessionKey));
    if (state.raw !== undefined && !state.launch)
      throw new Error('Agent Team launch state is unconfirmed.');
    const entry = nativeEntry(String(params.sessionKey));
    const current =
      state.launch ??
      parseLaunch({
        ...params,
        generation: Number(params.expectedGeneration) + 1,
        lifecycleRevision:
          params.lifecycleRevision === undefined
            ? (entry?.lifecycleRevision ?? null)
            : params.lifecycleRevision,
        owner: OWNER,
        state: 'pending',
        corrections: 0,
      });
    if (
      !current ||
      (state.launch ? current.generation - 1 : 0) !== params.expectedGeneration ||
      (state.launch &&
        (current.nativeSessionId !== params.nativeSessionId ||
          current.clientTurnId !== params.clientTurnId))
    )
      throw new Error('Agent Team launch generation changed.');
    assertNativeIdentity(current);
    if (
      params.neverSubmitted !== true ||
      !['pending', 'cancelled'].includes(current.state) ||
      current.entryId ||
      current.transcriptGeneration ||
      current.corrections !== 0 ||
      current.wholeSettled
    )
      throw new Error('Only a proven never-submitted Agent Team intent can be abandoned.');
    const absent = async () => {
      const key = `${current.clientTurnId}:user`;
      const result = await withCodexSessionTranscriptMirrorWriteLock(
        {
          agentId: current.sessionKey.split(':')[1],
          sessionKey: current.sessionKey,
          sessionId: current.nativeSessionId,
        },
        (locked: TranscriptFactsLock) => locked.readMessageFacts({ idempotencyKeys: [key] }),
      );
      if (result.messagesByIdempotencyKey.has(key) || result.anchorsByIdempotencyKey.has(key))
        throw new Error('Agent Team input already exists.');
      assertNativeIdentity(current);
    };
    await absent();
    const history = await api.runtime.gateway.request<RecordValue>(
      'chat.history',
      {
        sessionKey: current.sessionKey,
        limit: 1,
        inputRunIds: [current.clientTurnId],
      },
      { scopes: ['operator.admin'] },
    );
    if (
      !record(history.sessionInfo) ||
      history.sessionInfo.sessionId !== current.nativeSessionId ||
      history.sessionInfo.hasActiveRun !== false ||
      !record(history.pendingInputs) ||
      history.pendingInputs.total !== 0 ||
      !Array.isArray(history.pendingInputs.items) ||
      history.pendingInputs.items.length !== 0 ||
      !Array.isArray(history.inputReceipts) ||
      history.inputReceipts.length !== 0 ||
      !Array.isArray(history.inputConsumptions) ||
      history.inputConsumptions.length !== 0
    )
      throw new Error('Agent Team source is active, queued, or unconfirmed.');
    await absent();
    // Main's durable submission-start fence must remain closed through this
    // commit. Missing/lost send acknowledgments never satisfy neverSubmitted.
    await updateAdmission(current, 'abandon', { neverSubmitted: true });
    await save({ ...current, state: 'released' });
    return { state: 'released', generation: current.generation };
  });
  method('release', async params => {
    const current = currentFor(params);
    assertNativeIdentity(current);
    // Main owns durable terminal reconciliation and dispatcher cleanup. Neither
    // cancellation nor elapsed time is a substitute for both confirmations.
    if (params.executionSettled !== true || params.dispatchCleanupComplete !== true)
      throw new Error('Agent Team launch still requires terminal evidence and cleanup.');
    const cleanupReceiptId = `${current.clientTurnId}:${current.generation}:dispatcher-cleanup`;
    await updateAdmission(current, 'cleanup', { receiptId: cleanupReceiptId });
    await updateAdmission(current, 'release', { receiptId: cleanupReceiptId });
    await save({ ...current, state: 'released' });
    return {
      state: 'released',
      generation: current.generation,
      sessionKey: current.sessionKey,
      nativeSessionId: current.nativeSessionId,
      lifecycleRevision: current.lifecycleRevision,
      clientTurnId: current.clientTurnId,
    };
  });
  method('revise', async params => {
    if (!enabled(api)) return { revise: false };
    const current = await verifyCurrent(params);
    if (current.state !== 'verified' || current.corrections >= MAX_CORRECTIONS)
      return { revise: false };
    await facts(current, {
      sessionKey: current.sessionKey,
      sessionId: current.nativeSessionId,
      runId: String(params.runId),
    });
    await save({ ...current, corrections: current.corrections + 1 });
    assertLive(current);
    return { revise: true, mode: current.mode };
  });
  const verify = async (
    ctx: Identity & { inputProvenance?: unknown; hookInvocation?: { assertActive(): void } },
  ) => {
    if (!managed(ctx.sessionKey) || ctx.inputProvenance != null) return;
    const launch = read(ctx.sessionKey).launch;
    if (
      !launch ||
      launch.state !== 'pending' ||
      ctx.runId !== launch.clientTurnId ||
      ctx.sessionId !== launch.nativeSessionId
    )
      return;
    try {
      ctx.hookInvocation?.assertActive();
      await rpc('verify', {
        sessionKey: launch.sessionKey,
        nativeSessionId: launch.nativeSessionId,
        clientTurnId: launch.clientTurnId,
        runId: ctx.runId,
      });
      ctx.hookInvocation?.assertActive();
    } catch {
      /* Pending stays restrictive. Missing inputs are never guessed. */
    }
  };
  api.on('before_prompt_build', async (_event, ctx) => {
    await verify(ctx);
  });
  api.on('llm_input', async (_event, ctx) => {
    await verify(ctx);
  });
  api.registerTrustedToolPolicy({
    id: POLICY_ID,
    description: 'Fail-closed explicit Team launch protection, including Code Mode inner tools.',
    async evaluate(event, ctx) {
      if (!managed(ctx.sessionKey)) return;
      const state = read(ctx.sessionKey);
      if (state.raw === undefined || state.launch?.state === 'released') return;
      const launch = state.launch;
      const deny = {
        allow: false,
        reason: 'Explicit Agent Team launch is unconfirmed or this tool conflicts with its mode.',
      };
      // This intent protects one exact launch turn. Once an accepted Team and
      // that turn's whole-run terminal are both proven, a later native run (for
      // example a summary or organizer participation) uses its own native policy.
      // This is not cleanup/release, and the original run never gets this bypass.
      if (
        !retired &&
        launch?.owner === OWNER &&
        launch.state === 'launched' &&
        launch.wholeSettled?.runId === launch.clientTurnId &&
        launch.wholeSettled?.nativeSessionId === launch.nativeSessionId &&
        ctx.sessionKey === launch.sessionKey &&
        ctx.sessionId === launch.nativeSessionId &&
        typeof ctx.runId === 'string' &&
        ctx.runId.length > 0 &&
        ctx.runId !== launch.clientTurnId
      ) {
        try {
          if (ctx.abortSignal?.aborted) return deny;
          assertNativeIdentity(launch);
          return;
        } catch {
          return deny;
        }
      }
      if (
        !launch ||
        !['pending', 'verified', 'attempted', 'launched'].includes(launch.state) ||
        !enabled(api)
      )
        return deny;
      try {
        if (ctx.abortSignal?.aborted) return deny;
        const status = (await rpc('status', {
          sessionKey: launch.sessionKey,
          nativeSessionId: launch.nativeSessionId,
          clientTurnId: launch.clientTurnId,
          runId: ctx.runId,
        })) as { state?: LaunchState };
        if (!status.state || !['verified', 'attempted', 'launched'].includes(status.state))
          return deny;
        if (ctx.abortSignal?.aborted) return deny;
        const current = read(launch.sessionKey).launch;
        if (
          !current ||
          current.state === 'cancelled' ||
          current.state === 'released' ||
          !sameRequest(current, launch)
        )
          return deny;
        // Preparation uses the native tool policy, including shell and Code Mode
        // inner tools. It must not mark a Team attempt or grant additional access.
        if (event.toolName === 'team_discussion' && event.params.action === 'read') return;
        const discovery =
          event.toolName === 'task_assistants' &&
          !event.params.agentId &&
          event.params.seal !== true &&
          !event.params.review;
        if (discovery) return;
        const selectedLaunch =
          launch.mode === 'discussion'
            ? event.toolName === 'team_discussion' &&
              ['create', 'stop'].includes(String(event.params.action))
            : ['task_assistants', 'sessions_send', 'assistants_create'].includes(event.toolName);
        if (!selectedLaunch) {
          return TEAM_LAUNCH_CONFLICT_TOOLS.has(event.toolName) ? deny : undefined;
        }
        await rpc('attempt', {
          sessionKey: launch.sessionKey,
          nativeSessionId: launch.nativeSessionId,
          clientTurnId: launch.clientTurnId,
          runId: ctx.runId,
        });
        const admitted = read(launch.sessionKey).launch;
        if (
          ctx.abortSignal?.aborted ||
          !admitted ||
          !sameRequest(admitted, launch) ||
          !['attempted', 'launched'].includes(admitted.state)
        )
          return deny;
      } catch {
        return deny;
      }
    },
  });
  const finalizeOptions: NonNullable<Parameters<typeof api.on<'before_agent_finalize'>>[2]> & {
    appliesToAgentRun: (ctx: Readonly<Identity>) => boolean;
  } = {
    appliesToAgentRun(ctx) {
      try {
        if (!ctx.sessionKey || !ctx.sessionId || !ctx.runId || retired) return true;
        // Exclusion only removes this hook's delivery hold. It never grants
        // tools or revision authority, which still use the exact live ledger.
        const current = nativeEntry(ctx.sessionKey);
        if (current?.sessionId !== ctx.sessionId) return true;
        if (!managed(ctx.sessionKey)) return false;
        const state = read(ctx.sessionKey);
        if (state.raw === undefined || state.launch?.state === 'released') return false;
        const launch = state.launch;
        if (!launch || launch.owner !== OWNER) return true;
        assertNativeIdentity(launch);
        if (
          launch.state === 'launched' &&
          launch.wholeSettled?.runId === launch.clientTurnId &&
          launch.wholeSettled?.nativeSessionId === launch.nativeSessionId &&
          ctx.sessionId === launch.nativeSessionId &&
          ctx.runId !== launch.clientTurnId
        )
          return false;
        return true;
      } catch {
        // Missing, corrupt or uncertain admission keeps the native protection.
        return true;
      }
    },
  };
  api.on(
    'before_agent_finalize',
    async (_event, ctx) => {
      if (!managed(ctx.sessionKey)) return;
      const launch = read(ctx.sessionKey).launch;
      if (
        !launch ||
        !['pending', 'verified'].includes(launch.state) ||
        ctx.runId !== launch.clientTurnId ||
        ctx.sessionId !== launch.nativeSessionId
      )
        return;
      try {
        const result = (await rpc('revise', {
          sessionKey: launch.sessionKey,
          nativeSessionId: launch.nativeSessionId,
          clientTurnId: launch.clientTurnId,
          runId: ctx.runId,
        })) as { revise?: boolean };
        if (!result.revise) return;
        const current = read(launch.sessionKey).launch;
        if (!current || current.state !== 'verified' || !sameRequest(current, launch)) return;
        return {
          action: 'revise' as const,
          reason: 'The explicitly requested Agent Team has not been started.',
          retry: {
            instruction: `Start the explicitly requested ${launch.mode === 'discussion' ? 'group discussion' : 'task collaboration'} using the enabled Agent Team tools. If it cannot be started, explain the blocker. Do not claim success without an accepted Team operation.`,
            idempotencyKey: `agent-team-launch:${launch.clientTurnId}`,
            maxAttempts: MAX_CORRECTIONS,
          },
        };
      } catch {
        return;
      }
    },
    finalizeOptions,
  );
}
