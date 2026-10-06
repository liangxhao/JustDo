'use strict';

// These functions are emitted into the native registry, beside its existing
// actor, persistence and session-identity guards. They never create another DB.
function justDoCreatePluginExecution(params) {
  // Opt-in only: preserve native paused follow-up adoption and tool lifetime
  // for every plugin which has not requested managed execution evidence.
  if (params.managedToolsLifetime !== 'run') return undefined;
  if (!params.pluginId) throw new Error('Managed execution requires a trusted plugin owner.');
  const session = loadSubagentSessionEntry({ childSessionKey: params.childSessionKey });
  if (!session?.sessionId || !session.lifecycleRevision)
    throw new Error('Plugin execution requires an admitted native session.');
  if (params.managedToolsLifetime === 'run' && session.pluginOwnerId !== params.pluginId)
    throw new Error('Managed tools require a session owned by the calling plugin.');
  return {
    version: 1,
    pluginId: params.pluginId,
    sessionId: session.sessionId,
    lifecycleRevision: session.lifecycleRevision,
    managedToolsLifetime: params.managedToolsLifetime === 'run' ? 'run' : 'session',
  };
}

function justDoPluginExecutionCurrent(entry, pluginId) {
  const meta = entry?.justDoPluginExecution;
  if (!meta || meta.version !== 1 || meta.pluginId !== pluginId)
    throw new Error('Plugin does not own this exact execution.');
  const session = loadSubagentSessionEntry({ childSessionKey: entry.childSessionKey });
  return Boolean(
    session?.sessionId === meta.sessionId &&
    session?.lifecycleRevision === meta.lifecycleRevision &&
    (meta.managedToolsLifetime !== 'run' || session?.pluginOwnerId === pluginId),
  );
}

async function justDoDescribePluginRun(runId, pluginId) {
  if (typeof runId !== 'string' || !runId.trim() || !pluginId)
    throw new Error('An exact run identity and trusted plugin owner are required.');
  const prepared = await prepareSubagentRunsByRunIds([runId]);
  const snapshot = prepared.consume(rows => {
    const entry = rows.get(runId);
    if (!entry || entry.runId !== runId) return { state: 'unknown', runId };
    const currentSession = justDoPluginExecutionCurrent(entry, pluginId);
    const meta = entry.justDoPluginExecution;
    const currentEpoch = meta.epoch === getAgentEventLifecycleGeneration();
    return {
      runId,
      sessionKey: entry.childSessionKey,
      state:
        meta.executionSettled === true && meta.cleanupSettled === true
          ? 'settled'
          : !currentSession || !currentEpoch
            ? 'unknown'
            : meta.executionStartedAt
              ? 'running'
              : 'accepted',
      executionSettled: meta.executionSettled === true,
      cleanupSettled: meta.cleanupSettled === true,
      executionStartedAt: meta.executionStartedAt,
      executionEndedAt: meta.executionEndedAt,
      acceptedAt: meta.acceptedAt,
      epoch: meta.epoch,
      currentEpoch,
      currentSession,
      cancelled: meta.outcome === 'cancelled',
      outcome: meta.outcome,
    };
  });
  return snapshot.ready ? snapshot.value : { state: 'unknown', runId };
}

async function justDoObservePluginLifecycle(entry, event) {
  if (!entry.justDoPluginExecution || subagentRuns.get(entry.runId) !== entry) return;
  const phase = event.data?.phase;
  if (
    phase !== 'start' &&
    !(event.data?.executionSettled === true && ['end', 'error'].includes(phase))
  )
    return;
  await justDoUpdatePluginExecution(entry.runId, meta => {
    if (phase === 'start')
      return meta.executionStartedAt
        ? meta
        : {
            ...meta,
            executionStartedAt:
              typeof event.data.startedAt === 'number' ? event.data.startedAt : Date.now(),
          };
    const outcome = classifySubagentTerminalOutcome(
      buildAgentRunTerminalOutcomeFromLifecycleEvent({ phase, data: event.data }),
    );
    const next = outcome === 'cancellation' ? 'cancelled' : outcome === 'success' ? 'ok' : 'error';
    return {
      ...meta,
      executionSettled: true,
      executionEndedAt:
        meta.executionEndedAt ??
        (typeof event.data.endedAt === 'number' ? event.data.endedAt : Date.now()),
      outcome: !meta.outcome || meta.outcome === 'ok' || next === 'cancelled' ? next : meta.outcome,
    };
  });
}

async function justDoUpdatePluginExecution(runId, update) {
  const owner = subagentRuns.get(runId);
  const identity = owner?.justDoPluginExecution;
  if (!identity) return;
  const assertOwner = () => {
    const current = owner.justDoPluginExecution;
    if (
      subagentRuns.get(runId) !== owner ||
      identity.epoch !== getAgentEventLifecycleGeneration() ||
      !current ||
      ['pluginId', 'sessionId', 'lifecycleRevision', 'epoch'].some(
        key => current[key] !== identity[key],
      ) ||
      !justDoPluginExecutionCurrent(owner, identity.pluginId)
    )
      throw new Error('Plugin execution publication lost its original owner.');
  };
  const queues = (globalThis[Symbol.for('openclaw.pluginExecutionPublications.v1')] ??= new Map());
  const prior = queues.get(runId) ?? Promise.resolve();
  const publishing = prior
    .catch(() => undefined)
    .then(async () => {
      // Native terminal writers can restore a cloned preimage. Compare values,
      // including the complete row, rather than metadata object identity. Only a
      // conclusively uncommitted write may be recaptured; never retry an unknown
      // commit or replay the execution itself.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        assertOwner();
        const entry = subagentRuns.get(runId);
        const previous = entry?.justDoPluginExecution;
        if (!previous || previous.epoch !== getAgentEventLifecycleGeneration()) return;
        const next = update(previous);
        if (next === previous) return;
        const context = captureOpenClawStateWorkerContext();
        const previousSnapshot = structuredClone(entry);
        const nextSnapshot = { ...previousSnapshot, justDoPluginExecution: next };
        const matches = snapshot =>
          subagentRuns.get(runId) === entry && isDeepStrictEqual(entry, snapshot);
        let capturing = true;
        let published = false;
        let publication;
        entry.justDoPluginExecution = next;
        try {
          publication = persistSubagentRunsAsyncOrThrow(
            context,
            {
              assertCurrent: () => {
                assertOwner();
                if (
                  previous.epoch !== getAgentEventLifecycleGeneration() ||
                  !matches(capturing ? nextSnapshot : previousSnapshot)
                )
                  throw new Error('Plugin execution changed before metadata publication.');
              },
              onCommitted: () => {
                assertOwner();
                if (!matches(previousSnapshot))
                  throw new Error('Plugin execution publication lost its preimage.');
                entry.justDoPluginExecution = next;
                published = true;
              },
            },
            runId,
          );
        } finally {
          if (subagentRuns.get(runId) === entry && entry.justDoPluginExecution === next)
            entry.justDoPluginExecution = previous;
          capturing = false;
        }
        try {
          await publication;
          if (!published)
            throw new SubagentRegistryWriteError(
              'committed',
              new Error('Plugin execution publication superseded.'),
              'superseded',
            );
          return;
        } catch (error) {
          if (error?.outcome !== 'not-committed' || attempt === 7) throw error;
          const prepared = await prepareSubagentRunsByRunIds([runId]);
          if (!prepared.consume(() => undefined).ready) throw error;
        }
      }
    });
  queues.set(runId, publishing);
  const release = () => {
    if (queues.get(runId) === publishing) queues.delete(runId);
  };
  publishing.then(release, release);
  return publishing;
}

function justDoRegisterManagedToolCleanup(options, scopeKey, supervisor, waitForScope) {
  const entry = options?.runId ? subagentRuns.get(options.runId) : undefined;
  const meta = entry?.justDoPluginExecution;
  if (meta?.managedToolsLifetime !== 'run') return;
  if (
    !scopeKey ||
    scopeKey !== entry.childSessionKey ||
    !options.registerRunCleanup ||
    options.sessionId !== meta.sessionId ||
    !justDoPluginExecutionCurrent(entry, meta.pluginId) ||
    meta.epoch !== getAgentEventLifecycleGeneration()
  )
    throw new Error('Managed tool scope does not match the admitted plugin execution.');
  const cleanup = supervisor.acquireScopeCleanup(scopeKey, { processTree: 'owned-only' });
  const scopes = justDoManagedToolCleanups();
  const key = meta.epoch + '\u0000' + entry.runId;
  const state = scopes.get(key) ?? { cleanups: [], sealed: false };
  if (state.sealed) throw new Error('Managed run cleanup admission is closed.');
  scopes.set(key, state);
  let joining;
  const join = () =>
    (joining ??= (async () => {
      const results = await Promise.allSettled([cleanup(), waitForScope(scopeKey)]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    })());
  state.cleanups.push(join);
  options.registerRunCleanup(join);
}

function justDoManagedToolCleanups() {
  const key = Symbol.for('openclaw.pluginOwnedToolCleanups.v1');
  return (globalThis[key] ??= new Map());
}

function justDoRequireManagedHarness(runId, harness) {
  if (
    subagentRuns.get(runId)?.justDoPluginExecution?.managedToolsLifetime === 'run' &&
    harness.id !== 'openclaw'
  )
    throw new Error('Managed execution requires the local OpenClaw harness.');
  return harness;
}

function justDoAssertManagedPlacement(enabled, context, sessionId, harness, acp) {
  if (!enabled) return;
  const placement = context.workerSessionPlacementService?.getMany([sessionId]).get(sessionId);
  if (acp || harness !== 'openclaw' || (placement && placement.state !== 'local'))
    throw new Error(
      'Managed execution requires local OpenClaw execution; ACP and remote workers are unsupported.',
    );
}

function justDoManagedRunEnabled(runId) {
  return subagentRuns.get(runId)?.justDoPluginExecution?.managedToolsLifetime === 'run';
}

function justDoValidateManagedExecPolicy(runId, policy, sandbox) {
  if (
    justDoManagedRunEnabled(runId) &&
    (sandbox || (policy.host && policy.host !== 'gateway' && policy.host !== 'auto'))
  )
    throw new Error('Managed tools currently require local Gateway execution.');
  return policy;
}

async function justDoFinishManagedRun(runId) {
  const entry = subagentRuns.get(runId);
  const meta = entry?.justDoPluginExecution;
  if (
    !meta ||
    meta.managedToolsLifetime !== 'run' ||
    meta.epoch !== getAgentEventLifecycleGeneration()
  )
    return;
  if (meta.cleanupSettled) return;
  // The real whole-run terminal closes execution/tool construction admission.
  // Retained async release can run later and swallow errors, so independently
  // join the exact callbacks, including every tool-preparation generation.
  const scopes = justDoManagedToolCleanups();
  const key = meta.epoch + '\u0000' + runId;
  const state = scopes.get(key);
  if (state) {
    state.sealed = true;
    await Promise.all(state.cleanups.map(cleanup => cleanup()));
  }
  if (subagentRuns.get(runId) !== entry || meta.epoch !== getAgentEventLifecycleGeneration())
    throw new Error('Managed execution changed while joining tool cleanup.');
  await justDoUpdatePluginExecution(runId, current =>
    current.cleanupSettled
      ? current
      : {
          ...current,
          executionSettled: true,
          cleanupSettled: true,
          executionEndedAt: current.executionEndedAt ?? Date.now(),
          outcome: current.outcome ?? 'error',
        },
  );
  scopes.delete(key);
}

async function justDoPreparePluginCancel(runId, pluginId) {
  const entry = subagentRuns.get(runId);
  if (!entry || entry.runId !== runId) throw new Error('Exact plugin execution is unavailable.');
  const meta = entry.justDoPluginExecution;
  if (
    !justDoPluginExecutionCurrent(entry, pluginId) ||
    meta.epoch !== getAgentEventLifecycleGeneration()
  )
    throw new Error(
      'Execution ownership is uncertain; cancellation cannot target a replacement session.',
    );
  if (meta.executionSettled && meta.cleanupSettled) return undefined;
  if (
    [...subagentRuns.values()].some(
      other =>
        other !== entry &&
        other.childSessionKey === entry.childSessionKey &&
        other.justDoPluginExecution &&
        !other.justDoPluginExecution.executionSettled,
    )
  )
    throw new Error('Another execution owns this session.');
  const assertCurrent = () => {
    if (
      subagentRuns.get(runId) !== entry ||
      !justDoPluginExecutionCurrent(entry, pluginId) ||
      meta.epoch !== getAgentEventLifecycleGeneration()
    )
      throw new Error('Plugin execution changed before cancellation.');
  };
  assertCurrent();
  await justDoUpdatePluginExecution(runId, current => ({ ...current, cancelRequested: true }));
  assertCurrent();
  return { sessionKey: entry.childSessionKey, assertCurrent };
}

module.exports = {
  justDoCreatePluginExecution,
  justDoPluginExecutionCurrent,
  justDoDescribePluginRun,
  justDoObservePluginLifecycle,
  justDoUpdatePluginExecution,
  justDoRegisterManagedToolCleanup,
  justDoManagedToolCleanups,
  justDoRequireManagedHarness,
  justDoAssertManagedPlacement,
  justDoManagedRunEnabled,
  justDoValidateManagedExecPolicy,
  justDoFinishManagedRun,
  justDoPreparePluginCancel,
};
