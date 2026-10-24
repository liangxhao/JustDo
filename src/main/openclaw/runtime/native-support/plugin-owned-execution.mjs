/** Native execution support; live accessors preserve the registry actor and current-owner fences. */
export function createPluginOwnedExecutionRuntime(native) {
  const toolPreparationProofs = new WeakMap();
  const sessionChangedMessage = 'Plugin execution session identity changed.';
  // The native registry supplies live actor, persistence and session-identity
  // guards. All records remain in its existing durable store.
  function justDoCreatePluginExecution(params, session) {
    // Opt-in only: preserve native paused follow-up adoption and tool lifetime
    // for every plugin which has not requested managed execution evidence.
    if (params.managedToolsLifetime !== 'run') return undefined;
    if (!params.pluginId) throw new Error('Managed execution requires a trusted plugin owner.');
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

  function justDoPluginExecutionCurrent(entry, pluginId, proof) {
    const meta = entry?.justDoPluginExecution;
    if (!meta || meta.version !== 1 || meta.pluginId !== pluginId)
      throw new Error('Plugin does not own this exact execution.');
    return proof?.isCurrent() === true;
  }

  async function prepareOwnedExecutionSessionProof(
    entry,
    pluginId,
    assertCallerCurrent = () => {},
  ) {
    const meta = entry?.justDoPluginExecution;
    if (!meta || meta.version !== 1 || meta.pluginId !== pluginId)
      throw new Error('Plugin does not own this exact execution.');
    // Copy before the native worker yields; mutable registry rows are never
    // used as the expectation of a later source/commit assertion.
    const expectedSessionEntry = {
      sessionId: meta.sessionId,
      lifecycleRevision: meta.lifecycleRevision,
      pluginOwnerId: pluginId,
    };
    assertCallerCurrent();
    const { agentId, storePath } = native.resolveSubagentChildSessionOwner(
      entry,
      native.getRuntimeConfig(),
    );
    const proof = await native.captureSessionEntryCurrentCheck({
      agentId,
      storePath,
      sessionKey: entry.childSessionKey,
      expectedSessionEntry,
      isActive: () => {
        assertCallerCurrent();
        return true;
      },
      errorMessage: sessionChangedMessage,
    });
    assertCallerCurrent();
    return proof;
  }

  async function justDoDescribePluginRun(runId, pluginId) {
    if (typeof runId !== 'string' || !runId.trim() || !pluginId)
      throw new Error('An exact run identity and trusted plugin owner are required.');
    const prepared = await native.prepareSubagentRunsByRunIds([runId]);
    const selected = prepared.consume(rows => rows.get(runId));
    if (!selected.ready || !selected.value) return { state: 'unknown', runId };
    const original = selected.value;
    const identity = Object.freeze(
      Object.fromEntries(
        ['pluginId', 'sessionId', 'lifecycleRevision', 'epoch'].map(key => [
          key,
          original.justDoPluginExecution?.[key],
        ]),
      ),
    );
    let proof;
    try {
      proof = await prepareOwnedExecutionSessionProof(original, pluginId);
    } catch (error) {
      // A rotated native session cannot revoke already durable settlement.
      // Storage errors and wrong-plugin requests still propagate unchanged.
      if (error?.message !== sessionChangedMessage) throw error;
    }
    const current = await native.prepareSubagentRunsByRunIds([runId]);
    const snapshot = current.consume(rows => {
      const entry = rows.get(runId);
      if (
        !entry ||
        entry.runId !== runId ||
        !native.isSameSubagentRunOwner(entry, original) ||
        Object.keys(identity).some(key => entry.justDoPluginExecution?.[key] !== identity[key])
      )
        return { state: 'unknown', runId };
      const currentSession = justDoPluginExecutionCurrent(entry, pluginId, proof);
      const meta = entry.justDoPluginExecution;
      const currentEpoch = meta.epoch === native.getAgentEventLifecycleGeneration();
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
    if (
      !entry.justDoPluginExecution ||
      !native.getCurrentSubagentRunOwner(native.subagentRuns, entry)
    )
      return;
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
      const outcome = native.classifySubagentTerminalOutcome(
        native.buildAgentRunTerminalOutcomeFromLifecycleEvent({ phase, data: event.data }),
      );
      const next =
        outcome === 'cancellation' ? 'cancelled' : outcome === 'success' ? 'ok' : 'error';
      return {
        ...meta,
        executionSettled: true,
        executionEndedAt:
          meta.executionEndedAt ??
          (typeof event.data.endedAt === 'number' ? event.data.endedAt : Date.now()),
        outcome:
          !meta.outcome || meta.outcome === 'ok' || next === 'cancelled' ? next : meta.outcome,
      };
    });
  }

  async function justDoUpdatePluginExecution(runId, update) {
    const owner = native.subagentRuns.get(runId);
    const originalMeta = owner?.justDoPluginExecution;
    if (!originalMeta) return;
    const identity = Object.freeze(
      Object.fromEntries(
        ['pluginId', 'sessionId', 'lifecycleRevision', 'epoch'].map(key => [
          key,
          originalMeta[key],
        ]),
      ),
    );
    const assertActor = () => {
      const current = native.getCurrentSubagentRunOwner(native.subagentRuns, owner);
      const meta = current?.justDoPluginExecution;
      if (
        !current ||
        identity.epoch !== native.getAgentEventLifecycleGeneration() ||
        !meta ||
        ['pluginId', 'sessionId', 'lifecycleRevision', 'epoch'].some(
          key => meta[key] !== identity[key],
        )
      )
        throw new Error('Plugin execution publication lost its original owner.');
    };
    const proof = await prepareOwnedExecutionSessionProof(owner, identity.pluginId, assertActor);
    const assertOwner = native.composeSessionSourceAssertion([proof.assertCurrent, assertActor]);
    assertOwner();
    // The native actor owns serialization, version-conflict refresh, commit
    // uncertainty and immutable publication. Never mutate a published preimage.
    let intended;
    let published = false;
    let planned = false;
    await native.mutateSubagentRuns(
      [runId],
      rows => {
        planned = true;
        assertOwner();
        const current = rows.get(runId);
        if (!current || !native.isSameSubagentRunOwner(current, owner))
          throw new Error('Plugin execution mutation lost its admitted generation.');
        const previous = current.justDoPluginExecution;
        if (
          !previous ||
          ['pluginId', 'sessionId', 'lifecycleRevision', 'epoch'].some(
            key => previous[key] !== identity[key],
          )
        )
          throw new Error('Plugin execution mutation lost its original metadata.');
        const changed = update(previous);
        intended = changed === previous ? undefined : changed;
        return changed === previous
          ? { value: undefined }
          : {
              value: undefined,
              postimages: new Map([[runId, { ...current, justDoPluginExecution: changed }]]),
            };
      },
      {
        runs: native.subagentRuns,
        context: native.captureOpenClawStateWorkerContext(),
        assertCurrent: assertOwner,
        onPublished: postimages => {
          assertOwner();
          if (
            !intended ||
            !native.isDeepStrictEqual(postimages.get(runId)?.justDoPluginExecution, intended)
          )
            throw new Error('Plugin execution publication lost its committed metadata.');
          published = true;
        },
      },
    );
    if (!planned || (intended && !published))
      throw new native.SubagentRegistryWriteError(
        'committed',
        new Error('Plugin execution publication superseded.'),
        'superseded',
      );
  }

  function justDoRegisterManagedToolCleanup(options, scopeKey, supervisor, waitForScope) {
    const entry = options?.runId ? native.subagentRuns.get(options.runId) : undefined;
    const meta = entry?.justDoPluginExecution;
    if (meta?.managedToolsLifetime !== 'run') return;
    const prepared = toolPreparationProofs.get(options);
    const proof = prepared?.proof;
    if (
      !scopeKey ||
      scopeKey !== entry.childSessionKey ||
      !options.registerRunCleanup ||
      prepared?.runId !== entry.runId ||
      !native.isSameSubagentRunOwner(entry, prepared?.entry) ||
      !prepared.identity ||
      Object.keys(prepared.identity).some(key => meta[key] !== prepared.identity[key]) ||
      options.sessionId !== meta.sessionId ||
      !justDoPluginExecutionCurrent(entry, meta.pluginId, proof) ||
      meta.epoch !== native.getAgentEventLifecycleGeneration()
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

  async function prepareManagedToolOptions(options, assertCallerCurrent = () => {}) {
    const entry = options?.runId ? native.subagentRuns.get(options.runId) : undefined;
    const meta = entry?.justDoPluginExecution;
    if (meta?.managedToolsLifetime !== 'run') return options;
    const runId = options.runId;
    const identity = Object.freeze(
      Object.fromEntries(
        ['pluginId', 'sessionId', 'lifecycleRevision', 'epoch'].map(key => [key, meta[key]]),
      ),
    );
    const assertActor = () => {
      assertCallerCurrent();
      const current = native.getCurrentSubagentRunOwner(
        native.subagentRuns,
        entry,
      )?.justDoPluginExecution;
      if (
        options.runId !== runId ||
        !current ||
        Object.keys(identity).some(key => current[key] !== identity[key]) ||
        identity.epoch !== native.getAgentEventLifecycleGeneration()
      )
        throw new Error('Managed tool preparation lost its original execution.');
    };
    const proof = await prepareOwnedExecutionSessionProof(entry, meta.pluginId, assertActor);
    assertActor();
    proof.assertCurrent();
    toolPreparationProofs.set(options, { proof, entry, runId, identity });
    return options;
  }

  function justDoManagedToolCleanups() {
    const key = Symbol.for('openclaw.pluginOwnedToolCleanups.v1');
    return (globalThis[key] ??= new Map());
  }

  function justDoRequireManagedHarness(runId, harness) {
    if (
      native.subagentRuns.get(runId)?.justDoPluginExecution?.managedToolsLifetime === 'run' &&
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
    return native.subagentRuns.get(runId)?.justDoPluginExecution?.managedToolsLifetime === 'run';
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
    const entry = native.subagentRuns.get(runId);
    const meta = entry?.justDoPluginExecution;
    if (
      !meta ||
      meta.managedToolsLifetime !== 'run' ||
      meta.epoch !== native.getAgentEventLifecycleGeneration()
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
    if (
      !native.getCurrentSubagentRunOwner(native.subagentRuns, entry) ||
      meta.epoch !== native.getAgentEventLifecycleGeneration()
    )
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
    const entry = native.subagentRuns.get(runId);
    if (!entry || entry.runId !== runId) throw new Error('Exact plugin execution is unavailable.');
    const meta = entry.justDoPluginExecution;
    if (
      !meta ||
      meta.pluginId !== pluginId ||
      meta.epoch !== native.getAgentEventLifecycleGeneration()
    )
      throw new Error(
        'Execution ownership is uncertain; cancellation cannot target a replacement session.',
      );
    const identity = Object.freeze(
      Object.fromEntries(
        ['pluginId', 'sessionId', 'lifecycleRevision', 'epoch'].map(key => [key, meta[key]]),
      ),
    );
    const assertActor = () => {
      const current = native.getCurrentSubagentRunOwner(native.subagentRuns, entry);
      const currentMeta = current?.justDoPluginExecution;
      if (
        !currentMeta ||
        Object.keys(identity).some(key => currentMeta[key] !== identity[key]) ||
        identity.epoch !== native.getAgentEventLifecycleGeneration()
      )
        throw new Error('Plugin execution changed before cancellation.');
      if (
        [...native.subagentRuns.values()].some(
          other =>
            !native.isSameSubagentRunOwner(other, entry) &&
            other.childSessionKey === entry.childSessionKey &&
            other.justDoPluginExecution &&
            !other.justDoPluginExecution.executionSettled,
        )
      )
        throw new Error('Another execution owns this session.');
    };
    const proof = await prepareOwnedExecutionSessionProof(entry, pluginId, assertActor);
    const assertCurrent = native.composeSessionSourceAssertion([proof.assertCurrent, assertActor]);
    assertCurrent();
    if (meta.executionSettled && meta.cleanupSettled) return undefined;
    await justDoUpdatePluginExecution(runId, current => ({ ...current, cancelRequested: true }));
    assertCurrent();
    return { sessionKey: entry.childSessionKey, assertCurrent };
  }
  return {
    justDoCreatePluginExecution,
    justDoPluginExecutionCurrent,
    prepareOwnedExecutionSessionProof,
    justDoDescribePluginRun,
    justDoObservePluginLifecycle,
    justDoUpdatePluginExecution,
    justDoRegisterManagedToolCleanup,
    prepareManagedToolOptions,
    justDoManagedToolCleanups,
    justDoRequireManagedHarness,
    justDoAssertManagedPlacement,
    justDoManagedRunEnabled,
    justDoValidateManagedExecPolicy,
    justDoFinishManagedRun,
    justDoPreparePluginCancel,
  };
}
