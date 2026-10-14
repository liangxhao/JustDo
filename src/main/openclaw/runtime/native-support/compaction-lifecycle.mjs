// Gateway operation custody and recovery observations. Native handlers retain
// execution ownership; their dependencies are supplied at the import seam.
export function justDoCreateCompactionHandlers(nativeHandlers, dependencies) {
  const owners = new WeakMap();
  const capacity = 4096;
  const operationPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const operationsFor = context => {
    const gateway = context.resolveGatewayContext?.() ?? context;
    const identity = gateway.deps ?? gateway;
    let operations = owners.get(identity);
    if (!operations) {
      operations = new Map();
      owners.set(identity, operations);
    }
    return operations;
  };
  const failure = (options, reason) =>
    options.respond(
      false,
      undefined,
      dependencies.errorShape(dependencies.ErrorCodes.INVALID_REQUEST, reason),
    );
  const validate = (options, method, requireId) => {
    if (
      !dependencies.assertValidParams(
        options.params,
        dependencies.validateSessionsCompactParams,
        method,
        options.respond,
      )
    )
      return;
    const params = options.params;
    if (requireId && Object.keys(params).some(key => key !== 'key' && key !== 'operationId')) {
      failure(options, 'Only key and operationId are accepted');
      return;
    }
    const key = typeof params.key === 'string' ? params.key.trim() : '';
    if (
      !key ||
      ((requireId || params.operationId !== undefined) &&
        (typeof params.operationId !== 'string' || !operationPattern.test(params.operationId)))
    ) {
      failure(options, 'A session key and UUID operationId are required');
      return;
    }
    dependencies.readGatewayRequestMutationAuthority(options).assertCurrent();
    return { key, operationId: params.operationId ?? dependencies.randomUUID() };
  };
  const snapshot = record => ({
    operationId: record.operationId,
    key: record.key,
    phase: record.phase,
    admitted: record.admitted,
    ...(record.phase === 'settled' ? record.receipt : {}),
  });
  const unknown = params => ({ ...params, phase: 'unknown' });
  const reserve = (options, operations, params, phase) => {
    // Keep receipts and cancellation tombstones for this Gateway lifetime.
    // Evicting either could admit a delayed or accidentally repeated request.
    if (operations.size >= capacity) {
      options.respond(
        false,
        undefined,
        dependencies.errorShape(
          dependencies.ErrorCodes.UNAVAILABLE,
          'Compaction operation capacity reached; restart the Gateway before admitting more operations',
        ),
      );
      return;
    }
    const record = {
      ...params,
      phase,
      admitted: phase === 'in-progress',
      controller: new AbortController(),
    };
    operations.set(params.operationId, record);
    return record;
  };
  const tokenCount = value =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const settle = (record, response) => {
    const [success, payload, error] = response ?? [false];
    const ok = success === true && payload?.ok !== false;
    // A successful commit wins a late cancellation, matching native custody.
    const reason = typeof payload?.reason === 'string' ? payload.reason.trim().toLowerCase() : '';
    const cancelled = reason === 'compaction cancelled' || reason === 'error: compaction cancelled';
    const benign =
      payload?.compacted !== true &&
      ([
        'already compacted',
        'already_compacted',
        'below threshold',
        'already under target',
        'nothing to compact (session too small)',
      ].includes(reason) ||
        (ok && ['nothing to compact', 'no real conversation messages'].includes(reason)));
    const outcome =
      ok && payload?.compacted
        ? 'completed'
        : record.controller.signal.aborted || cancelled
          ? 'aborted'
          : benign || ok
            ? 'skipped'
            : 'failed';
    const before = tokenCount(payload?.result?.tokensBefore);
    const after = tokenCount(payload?.result?.tokensAfter);
    record.receipt = {
      outcome,
      ok,
      compacted: payload?.compacted === true,
      markerExpected: outcome === 'completed' && payload?.result?.markerExpected === true,
      ...(before !== undefined ? { tokensBefore: before } : {}),
      ...(after !== undefined ? { tokensAfter: after } : {}),
      // Never retain summaries, provider errors, keys embedded in error text,
      // model output or arbitrary backend reasons in operation receipts.
      ...(outcome === 'aborted'
        ? { reason: 'aborted' }
        : outcome === 'failed'
          ? {
              reason:
                error?.code === dependencies.ErrorCodes.INVALID_REQUEST
                  ? 'invalid-request'
                  : 'native-error',
            }
          : outcome === 'skipped'
            ? { reason: 'not-compacted' }
            : {}),
    };
    record.phase = 'settled';
  };
  const emit = (options, record, phase, response) => {
    try {
      dependencies.emitSessionOperation(options.context, {
        operationId: record.operationId,
        operation: 'compact',
        phase,
        sessionKey: record.key,
        ...(phase === 'end'
          ? {
              ...record.receipt,
              completed: record.receipt.outcome === 'completed',
              ...(typeof response?.[1]?.reason === 'string'
                ? { reason: response[1].reason }
                : typeof response?.[2]?.message === 'string'
                  ? { reason: response[2].message }
                  : {}),
            }
          : {}),
      });
    } catch {
      // Event delivery cannot change the authoritative execution result.
    }
  };
  return {
    ...nativeHandlers,
    'sessions.compact': async options => {
      const params = validate(options, 'sessions.compact', false);
      if (!params) return;
      const operations = operationsFor(options.context);
      const prior = operations.get(params.operationId);
      if (prior) {
        if (prior.key !== params.key) return failure(options, 'operationId was already admitted');
        if (prior.phase !== 'settled')
          return failure(options, 'operationId is already in progress');
        options.respond(true, { ...snapshot(prior), ...prior.receipt });
        return;
      }
      const record = reserve(options, operations, params, 'in-progress');
      if (!record) return;
      let response;
      emit(options, record, 'start');
      try {
        const adapted = {
          ...options,
          params: { ...options.params, operationId: record.operationId },
          signal: options.signal
            ? AbortSignal.any([options.signal, record.controller.signal])
            : record.controller.signal,
          respond: (...args) => {
            response = args;
          },
        };
        dependencies.bindGatewayRequestHandlerMutationAuthority(options, adapted, undefined);
        await nativeHandlers['sessions.compact'](adapted);
      } catch {
        response = [
          false,
          undefined,
          dependencies.errorShape(dependencies.ErrorCodes.UNAVAILABLE, 'Native compaction failed'),
        ];
      } finally {
        // Native finally has released the operator authority and lifecycle
        // admission before either this terminal event or the RPC is delivered.
        settle(record, response);
        emit(options, record, 'end', response);
      }
      const [success, payload, error] = response ?? [
        false,
        undefined,
        dependencies.errorShape(
          dependencies.ErrorCodes.UNAVAILABLE,
          'Native compaction produced no result',
        ),
      ];
      options.respond(
        success,
        success
          ? {
              ...payload,
              operationId: record.operationId,
              ...record.receipt,
              ...(typeof payload?.reason === 'string' ? { reason: payload.reason } : {}),
            }
          : payload,
        error,
      );
    },
    'sessions.compaction.status': async options => {
      const params = validate(options, 'sessions.compaction.status', true);
      if (!params) return;
      const record = operationsFor(options.context).get(params.operationId);
      options.respond(true, record?.key === params.key ? snapshot(record) : unknown(params));
    },
    'sessions.compaction.abort': async options => {
      const params = validate(options, 'sessions.compaction.abort', true);
      if (!params) return;
      const operations = operationsFor(options.context);
      let record = operations.get(params.operationId);
      if (record && record.key !== params.key) {
        options.respond(true, unknown(params));
        return;
      }
      if (!record) {
        // The original request may still be in dispatch/preparation. Reserve
        // its ID before confirming cancellation so it cannot start later.
        record = reserve(options, operations, params, 'settled');
        if (!record) return;
        record.controller.abort();
        settle(record);
      } else if (record.phase !== 'settled') record.controller.abort();
      options.respond(true, snapshot(record));
    },
  };
}

export async function justDoRunRecoveryCompaction(nativeCompact, input, recovery) {
  const { runParams } = input;
  const itemId = `recovery:${globalThis.crypto.randomUUID()}`;
  const startedAt = Date.now();
  let pendingDeliveries = 0;
  const emit = (phase, data = {}) => {
    if (phase === 'update' && pendingDeliveries > 0) return;
    try {
      const delivery = runParams.onAgentEvent?.({
        stream: 'compaction',
        data: { phase, itemId, operationId: itemId, trigger: recovery.trigger, ...data },
        ...(runParams.sessionKey ? { sessionKey: runParams.sessionKey } : {}),
      });
      if (delivery && typeof delivery.then === 'function') {
        pendingDeliveries += 1;
        Promise.resolve(delivery)
          .catch(() => {})
          .finally(() => {
            pendingDeliveries -= 1;
          });
      }
    } catch {
      // Observation must not alter transcript custody, compaction or retries.
    }
  };
  const tokenCount = value =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  let terminal = {
    completed: false,
    willRetry: false,
    outcome: 'failed',
    markerExpected: false,
    reason: 'recovery-error',
  };
  emit('start');
  const heartbeat = setInterval(
    () => void emit('update', { elapsedMs: Date.now() - startedAt }),
    5000,
  );
  heartbeat.unref?.();
  try {
    const response = await nativeCompact(
      {
        ...input,
        // Native hook notifications previously masqueraded as lifecycle events
        // and disappeared entirely with no configured notifier. Preserve their
        // messages as updates inside this one authoritative operation instead.
        onCompactionHookMessages: payload =>
          emit('update', {
            messages: payload.messages.filter(message => message.trim().length > 0),
          }),
      },
      recovery,
    );
    const result = response.result;
    const reason = typeof result.reason === 'string' ? result.reason.trim().toLowerCase() : '';
    const cancelled = reason === 'compaction cancelled' || reason === 'error: compaction cancelled';
    const benign =
      !result.compacted &&
      ([
        'already compacted',
        'already_compacted',
        'below threshold',
        'already under target',
      ].includes(reason) ||
        (result.ok &&
          [
            'nothing to compact',
            'nothing to compact (session too small)',
            'no real conversation messages',
          ].includes(reason)));
    const outcome =
      result.ok && result.compacted
        ? 'completed'
        : runParams.abortSignal?.aborted || cancelled
          ? 'aborted'
          : benign || result.ok
            ? 'skipped'
            : 'failed';
    const before = tokenCount(result.result?.tokensBefore);
    const after = tokenCount(result.result?.tokensAfter);
    terminal = {
      completed: outcome === 'completed',
      willRetry: false,
      outcome,
      markerExpected: outcome === 'completed' && result.result?.markerExpected === true,
      ...(before !== undefined ? { tokensBefore: before } : {}),
      ...(after !== undefined ? { tokensAfter: after } : {}),
      ...(outcome === 'failed'
        ? { reason: 'recovery-error' }
        : outcome === 'aborted'
          ? { reason: 'aborted' }
          : {}),
    };
    return response;
  } catch (error) {
    if (runParams.abortSignal?.aborted)
      terminal = {
        completed: false,
        willRetry: false,
        outcome: 'aborted',
        markerExpected: false,
        reason: 'aborted',
      };
    throw error;
  } finally {
    clearInterval(heartbeat);
    emit('end', terminal);
  }
}
