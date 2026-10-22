/** Conditional Goal ingress. Native owners supply every live fact and writer. */
export function createGoalContinuationRuntime(native) {
  const deferred = reason => {
    throw native.admissionError({
      code: 'INVALID_REQUEST',
      message: `Goal continuation deferred: ${reason}`,
      details: { code: 'GOAL_CONTINUATION_DEFERRED', reason },
    });
  };

  function validate(request, backend) {
    if (request.goalContinuation === undefined) return;
    const value = request.goalContinuation;
    if (
      !backend ||
      !request.sessionKey ||
      !request.expectedExistingSessionId ||
      typeof request.expectedExistingSessionLifecycleRevision !== 'string' ||
      request.suppressPromptPersistence !== true ||
      request.modelRun === true ||
      request.lane === 'subagent' ||
      value.automatic !== true ||
      !Number.isSafeInteger(value.maxAutomaticContinuations) ||
      value.maxAutomaticContinuations < 0
    )
      throw new Error('Goal continuation requires backend automatic ingress and an exact existing session.');
  }

  function terminal(params, phase, runId) {
    const entry = params.entry;
    const event = params.event;
    if (phase === 'start') return { goalContinuationTerminal: undefined };
    if (
      !entry?.goal ||
      !runId ||
      event.data?.executionSettled !== true ||
      event.data?.executionStarted === false ||
      event.sessionId !== entry.sessionId ||
      event.lifecycleGeneration !== native.generation() ||
      (phase !== 'end' && phase !== 'error')
    )
      return {};
    return {
      goalContinuationTerminal: {
        runId,
        executionRunId: event.runId,
        goalId: entry.goal.id,
        sessionId: entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision,
        lifecycleGeneration: event.lifecycleGeneration,
        executionSettled: true,
        yielded: event.data?.yielded === true,
        phase,
      },
    };
  }

  function replay(request, entry) {
    const condition = request.goalContinuation;
    const receipt = entry?.goalContinuationAccepted;
    if (
      !condition ||
      !receipt ||
      receipt.runId !== request.idempotencyKey ||
      entry.sessionId !== request.expectedExistingSessionId ||
      entry.lifecycleRevision !== request.expectedExistingSessionLifecycleRevision ||
      receipt.sessionId !== entry.sessionId ||
      receipt.lifecycleRevision !== entry.lifecycleRevision
    )
      return undefined;
    if (receipt.goalId !== condition.goalId || receipt.predecessorRunId !== condition.predecessorRunId)
      deferred('stale-predecessor');
    return receipt;
  }

  function nativeBlocked(params) {
    const key = params.resolvedSessionKey;
    const id = params.getAdmittedSessionId();
    const agentId = params.activeSessionAgentId;
    const sameSession = entry =>
      entry.sessionId === id && entry.sessionKey === key && entry.agentId === agentId;
    if (
      native.competingWork(params.lifecycleStorePath, [key, id]) ||
      [...params.context.chatAbortControllers.entries()].some(
        ([runId, entry]) => runId !== params.runId && sameSession(entry),
      ) ||
      native.replyActive(key)
    )
      return 'main-running';
    if (
      native.pendingQueue([key, id]) ||
      [...(params.context.chatQueuedTurns?.values() ?? [])].some(sameSession)
    )
      return 'queued-input';
    if (native.nativeHandoff(key, agentId)) return 'native-handoff';
    return undefined;
  }

  function assertAdmission(params, entry) {
    const request = params.request;
    const condition = request.goalContinuation;
    if (!condition) return;
    if (
      entry?.sessionId !== request.expectedExistingSessionId ||
      entry?.lifecycleRevision !== request.expectedExistingSessionLifecycleRevision
    )
      deferred('stale-predecessor');
    if (replay(request, entry)) return;
    if (entry.goal?.id !== condition.goalId || entry.goal?.status !== 'active')
      deferred('goal-inactive');
    const accepted = entry.goalContinuationAccepted;
    if (accepted?.goalId === condition.goalId && accepted.predecessorRunId === condition.predecessorRunId)
      deferred('stale-predecessor');
    const predecessor = entry.goalContinuationTerminal;
    if (
      !predecessor ||
      predecessor.executionSettled !== true ||
      predecessor.goalId !== condition.goalId ||
      predecessor.sessionId !== entry.sessionId ||
      predecessor.lifecycleRevision !== entry.lifecycleRevision
    )
      deferred('predecessor-unconfirmed');
    if (predecessor.runId !== condition.predecessorRunId) deferred('stale-predecessor');
    const blocked = nativeBlocked(params);
    if (blocked) deferred(blocked);
    const ownsPredecessor = runId =>
      runId === condition.predecessorRunId ||
      (typeof predecessor.executionRunId === 'string' && runId === predecessor.executionRunId);
    if (
      (entry.lifecycleRunId && !ownsPredecessor(entry.lifecycleRunId)) ||
      (entry.activeWriterRunId && !ownsPredecessor(entry.activeWriterRunId))
    )
      deferred('native-handoff');
    if (
      entry.lastRunId !== condition.predecessorRunId &&
      !(predecessor.yielded === true && entry.lifecycleRunId && ownsPredecessor(entry.lifecycleRunId))
    )
      deferred('stale-predecessor');
    if (entry.goal.continuationTurns >= condition.maxAutomaticContinuations) deferred('limit-reached');
  }

  async function commit(params, accepted, publish) {
    if (!params.request.goalContinuation) {
      publish();
      return undefined;
    }
    return await params.admission.run(() =>
      native.withLifecycleLock({
        scope: params.lifecycleStorePath,
        identities: [params.resolvedSessionKey, params.getAdmittedSessionId()],
        signal: params.signal,
        run: async () => {
          const assertOwner = () => {
            params.assertCurrent();
            if (params.lifecycleGeneration !== native.generation())
              throw new Error('Goal continuation admission belongs to a retired Gateway generation.');
            params.signal.throwIfAborted();
          };
          const assertCurrent = () => {
            assertOwner();
            const blocked = nativeBlocked(params);
            if (blocked) deferred(blocked);
          };
          assertOwner();
          const entry = params.readEntry();
          const previous = replay(params.request, entry);
          if (previous) return previous;
          assertCurrent();
          assertAdmission(params, entry);
          let committed;
          await native.patchEntry(
            {
              agentId: params.activeSessionAgentId,
              storePath: params.lifecycleStorePath,
              target: { canonicalKey: params.resolvedSessionKey, storeKeys: [params.resolvedSessionKey] },
            },
            current => {
              assertAdmission(params, current);
              const condition = params.request.goalContinuation;
              const continuationTurns = current.goal.continuationTurns + 1;
              return {
                goal: { ...current.goal, continuationTurns },
                goalContinuationAccepted: {
                  runId: params.runId,
                  sessionKey: params.resolvedSessionKey,
                  agentId: params.activeSessionAgentId,
                  sessionId: current.sessionId,
                  lifecycleRevision: current.lifecycleRevision,
                  goalId: condition.goalId,
                  predecessorRunId: condition.predecessorRunId,
                  continuationTurns,
                  acceptedAt: accepted.acceptedAt,
                },
              };
            },
            {
              workerGuard: { assertCurrent },
              onCommitted: current => {
                committed = current.goalContinuationAccepted;
                accepted.goalContinuation = publicReceipt(committed);
                // This callback is the native commit edge, before observers or another ingress.
                publish();
              },
            },
          );
          if (!committed) throw new Error('Goal continuation commit was not confirmed.');
          return undefined;
        },
      }),
    );
  }

  function publicReceipt(receipt) {
    return {
      goalId: receipt.goalId,
      predecessorRunId: receipt.predecessorRunId,
      continuationTurns: receipt.continuationTurns,
      acceptedAt: receipt.acceptedAt,
    };
  }

  function describe(entry) {
    if (!entry.goal) return undefined;
    const predecessor = entry.goalContinuationTerminal;
    const receipt = entry.goalContinuationAccepted;
    return {
      continuationTurns: entry.goal.continuationTurns,
      ...(predecessor?.goalId === entry.goal.id &&
      predecessor.sessionId === entry.sessionId &&
      predecessor.lifecycleRevision === entry.lifecycleRevision
        ? { predecessor: { ...predecessor } }
        : {}),
      ...(receipt?.goalId === entry.goal.id &&
      receipt.sessionId === entry.sessionId &&
      receipt.lifecycleRevision === entry.lifecycleRevision
        ? { lastAccepted: { runId: receipt.runId, ...publicReceipt(receipt) } }
        : {}),
    };
  }

  function hasNativeHandoff(sessionKey, agentId, runs, controller, unsettled, restored = true, currentCustody) {
    if (!restored) return true;
    if (unsettled({ requesterSessionKey: sessionKey, requesterAgentId: agentId, runs }).length) return true;
    // The session presentation selects one latest child. Delivery custody is
    // task-scoped: an older task can still owe its own parent wake or result.
    for (const entry of runs.values()) {
      if (
        entry.requesterSessionKey !== sessionKey ||
        entry.requesterAgentId !== agentId ||
        entry.collect === true ||
        entry.expectsCompletionMessage !== true ||
        entry.suppressCompletionDelivery === true
      )
        continue;
      const wake = entry.requesterSettleWake;
      const owesWake = wake?.status === 'pending' || wake?.status === 'dispatching';
      const owesDelivery = !entry.killIntent && !entry.killReconciliation &&
        (entry.delivery?.status === 'pending' || entry.delivery?.status === 'in_progress');
      if ((owesWake || owesDelivery) && (!currentCustody || currentCustody(entry))) return true;
    }
    for (const pending of controller.pendingRequesterSettleWakeCommits.values()) {
      if (
        pending.entries.some(
          entry =>
            entry.requesterSessionKey === sessionKey &&
            entry.requesterAgentId === agentId &&
            (pending.isCurrent(entry) ||
              pending.ownsRetirement(entry) ||
              pending.initialTransfer?.blocked === true ||
              pending.inFlight !== undefined),
        )
      )
        return true;
    }
    return false;
  }

  return { validate, terminal, replay, assertAdmission, commit, describe, publicReceipt, hasNativeHandoff };
}
