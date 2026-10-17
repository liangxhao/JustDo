const toolCallRecoveryFactsRejectionDiagnostic = 'tool_call_pre_dispatch_rejection';
const toolCallRecoveryFactsRejectionErrorCode = 'malformed_tool_call_arguments';

const toolCallRecoveryFactsOptionalExclusionFlags = [
  'yieldDetected',
  'yieldMessageWaitRegistered',
  'didSendDeterministicApprovalPrompt',
  'didDeliverSourceReplyViaMessageTool',
  'sourceReplyDelivered',
  'toolAudioAsVoice',
  'toolTrustedLocalMedia',
  'hasToolMediaBlockReply',
  'runtimeContinuationStarted',
];
const toolCallRecoveryFactsRequiredDeliveryArrays = [
  'messagingToolSentTexts',
  'messagingToolSentMediaUrls',
  'messagingToolSentTargets',
];
const toolCallRecoveryFactsOptionalDeliveryArrays = [
  'messagingToolSourceReplyPayloads',
  'toolMediaUrls',
  'hostOwnedToolMediaUrls',
  'acceptedSessionSpawns',
];
const toolCallRecoveryFactsToolExclusionFlags = ['asyncStarted', 'codeModeSuspended', 'terminate'];
const toolCallRecoveryFactsToolAsyncIdentities = ['asyncTaskId', 'asyncTaskRunId', 'asyncTaskIds'];

const toolCallRecoveryFactsIsRecord = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const toolCallRecoveryFactsIsNonNegativeSafeInteger = value =>
  Number.isSafeInteger(value) && value >= 0;
const toolCallRecoveryFactsIsIdentity = value =>
  typeof value === 'string' && value.trim().length > 0;
const toolCallRecoveryFactsHasOptionalFlag = value => value !== undefined && value !== false;
const toolCallRecoveryFactsHasArrayActivity = value => !Array.isArray(value) || value.length > 0;

/** Project native accepted rows only; never retain tool arguments or result payloads. */
export function projectToolCallRecoveryNestedEvidence(scope, toolMetas, activities) {
  if (!toolCallRecoveryFactsIsRecord(scope) || !Array.isArray(toolMetas) || !Array.isArray(activities))
    return null;
  return {
    runId: scope.runId,
    sessionId: scope.sessionId,
    scopeId: scope.scopeId,
    toolMetas: toolMetas.map(meta => toolCallRecoveryFactsIsRecord(meta) ? {
      toolCallId: meta.toolCallId, toolName: meta.toolName,
      parentToolCallId: meta.parentToolCallId, isError: meta.isError,
    } : null),
    activities: activities.map(activity => {
      if (!toolCallRecoveryFactsIsRecord(activity) || activity.role !== 'custom' ||
        activity.customType !== 'openclaw.nested-tool.v1' || activity.excludeFromContext !== true ||
        !toolCallRecoveryFactsIsRecord(activity.details)) return null;
      const details = activity.details;
      return {
        runId: details.runId, scopeId: details.scopeId,
        toolCallId: details.toolCallId, toolName: details.toolName,
        parentToolCallId: details.parentToolCallId, isError: details.isError,
      };
    }),
  };
}

function toolCallRecoveryFactsAddNestedHistory(attempt, runId, calls, results) {
  const evidence = attempt.toolCallRecoveryNestedEvidence;
  if (evidence === undefined) return true;
  if (!toolCallRecoveryFactsIsRecord(evidence) ||
    !toolCallRecoveryFactsIsIdentity(runId) || evidence.runId !== runId ||
    !toolCallRecoveryFactsIsIdentity(evidence.sessionId) || evidence.sessionId !== attempt.sessionIdUsed ||
    !toolCallRecoveryFactsIsIdentity(evidence.scopeId) ||
    !Array.isArray(evidence.toolMetas) || evidence.toolMetas.length !== attempt.toolMetas.length ||
    !Array.isArray(evidence.activities) || evidence.activities.length === 0) return false;
  const metas = new Map();
  for (const meta of evidence.toolMetas) {
    if (!toolCallRecoveryFactsIsRecord(meta) ||
      !toolCallRecoveryFactsIsIdentity(meta.toolCallId) ||
      !toolCallRecoveryFactsIsIdentity(meta.toolName) ||
      metas.has(meta.toolCallId) ||
      (meta.parentToolCallId !== undefined && !toolCallRecoveryFactsIsIdentity(meta.parentToolCallId))) return false;
    metas.set(meta.toolCallId, meta);
  }
  if (!attempt.toolMetas.every(meta => {
    if (!toolCallRecoveryFactsIsRecord(meta)) return false;
    const original = metas.get(meta.toolCallId);
    return original && original.toolName === meta.toolName && original.isError === meta.isError;
  })) return false;
  const nested = new Map();
  for (const activity of evidence.activities) {
    if (!toolCallRecoveryFactsIsRecord(activity) || activity.runId !== runId ||
      activity.scopeId !== evidence.scopeId || !toolCallRecoveryFactsIsIdentity(activity.parentToolCallId) ||
      typeof activity.isError !== 'boolean' || nested.has(activity.toolCallId) || calls.has(activity.toolCallId)) return false;
    const meta = metas.get(activity.toolCallId);
    if (!meta || meta.toolName !== activity.toolName || meta.parentToolCallId !== activity.parentToolCallId ||
      meta.isError !== activity.isError) return false;
    nested.set(activity.toolCallId, activity);
  }
  for (const [id, meta] of metas) {
    if (meta.parentToolCallId === undefined) {
      if (calls.get(id) !== meta.toolName || !results.has(id)) return false;
      continue;
    }
    if (!nested.has(id)) return false;
    const visited = new Set([id]);
    let parent = meta.parentToolCallId;
    while (true) {
      if (visited.has(parent)) return false;
      visited.add(parent);
      const owner = metas.get(parent);
      if (!owner) return false;
      if (owner.parentToolCallId === undefined) {
        if (calls.get(parent) !== owner.toolName || !results.has(parent)) return false;
        break;
      }
      if (!nested.has(parent)) return false;
      parent = owner.parentToolCallId;
    }
  }
  for (const [id, activity] of nested) {
    calls.set(id, activity.toolName);
    results.add(id);
  }
  return true;
}

function toolCallRecoveryFactsExcludesAttempt(attempt) {
  if (typeof attempt.didSendViaMessagingTool !== 'boolean' || attempt.didSendViaMessagingTool) {
    return true;
  }
  if (
    toolCallRecoveryFactsOptionalExclusionFlags.some(key =>
      toolCallRecoveryFactsHasOptionalFlag(attempt[key]),
    )
  )
    return true;
  if (
    toolCallRecoveryFactsRequiredDeliveryArrays.some(key =>
      toolCallRecoveryFactsHasArrayActivity(attempt[key]),
    )
  )
    return true;
  if (
    toolCallRecoveryFactsOptionalDeliveryArrays.some(
      key => attempt[key] !== undefined && toolCallRecoveryFactsHasArrayActivity(attempt[key]),
    )
  ) {
    return true;
  }
  if (
    attempt.clientToolCalls !== undefined ||
    attempt.heartbeatToolResponse !== undefined ||
    attempt.lastToolError !== undefined
  ) {
    return true;
  }
  if (
    attempt.sourceReplyDeliveryState !== undefined &&
    attempt.sourceReplyDeliveryState !== 'missing'
  ) {
    return true;
  }
  if (
    attempt.successfulCronAdds !== undefined &&
    (!toolCallRecoveryFactsIsNonNegativeSafeInteger(attempt.successfulCronAdds) ||
      attempt.successfulCronAdds !== 0)
  ) {
    return true;
  }
  if (!Array.isArray(attempt.toolMetas)) return true;
  return attempt.toolMetas.some(
    meta =>
      !toolCallRecoveryFactsIsRecord(meta) ||
      !toolCallRecoveryFactsIsIdentity(meta.toolName) ||
      toolCallRecoveryFactsToolExclusionFlags.some(key =>
        toolCallRecoveryFactsHasOptionalFlag(meta[key]),
      ) ||
      toolCallRecoveryFactsToolAsyncIdentities.some(key => meta[key] !== undefined) ||
      (meta.isError !== undefined && typeof meta.isError !== 'boolean'),
  );
}

/** Verify the entire current user turn, including settled batches from earlier attempts. */
function toolCallRecoveryFactsHasSettledToolHistory(attempt, runId) {
  const lifecycle = attempt.itemLifecycle;
  if (
    !toolCallRecoveryFactsIsRecord(lifecycle) ||
    !['startedCount', 'completedCount', 'activeCount'].every(key =>
      toolCallRecoveryFactsIsNonNegativeSafeInteger(lifecycle[key]),
    ) ||
    lifecycle.startedCount !== lifecycle.completedCount ||
    lifecycle.activeCount !== 0 ||
    !Array.isArray(attempt.toolMetas) ||
    attempt.toolMetas.length !== lifecycle.completedCount ||
    !Array.isArray(attempt.messagesSnapshot)
  ) {
    return false;
  }
  const snapshot = attempt.messagesSnapshot;
  const userIndex = snapshot.findLastIndex(
    message => toolCallRecoveryFactsIsRecord(message) && message.role === 'user',
  );
  if (userIndex < 0) return false;
  const calls = new Map();
  const results = new Set();
  for (let index = userIndex + 1; index < snapshot.length; index += 1) {
    const message = snapshot[index];
    if (!toolCallRecoveryFactsIsRecord(message) || typeof message.role !== 'string') return false;
    if (message.role === 'assistant') {
      if (!Array.isArray(message.content)) return false;
      for (const block of message.content) {
        if (!toolCallRecoveryFactsIsRecord(block) || typeof block.type !== 'string') return false;
        if (block.type === 'thinking' && typeof block.thinking === 'string') continue;
        if (
          ['text', 'input_text', 'output_text'].includes(block.type) &&
          typeof block.text === 'string'
        ) {
          continue;
        }
        if (block.type !== 'toolCall') return false;
        if (
          !toolCallRecoveryFactsIsIdentity(block.id) ||
          !toolCallRecoveryFactsIsIdentity(block.name) ||
          calls.has(block.id)
        )
          return false;
        // Async work is excluded separately; it cannot establish ordinary settled history.
        if (block.async !== undefined && block.async !== false) return false;
        calls.set(block.id, block.name);
      }
    } else if (message.role === 'toolResult') {
      if (
        !toolCallRecoveryFactsIsIdentity(message.toolCallId) ||
        !toolCallRecoveryFactsIsIdentity(message.toolName) ||
        calls.get(message.toolCallId) !== message.toolName ||
        results.has(message.toolCallId) ||
        (message.isError !== undefined && typeof message.isError !== 'boolean')
      ) {
        return false;
      }
      results.add(message.toolCallId);
    }
  }
  if (calls.size !== results.size) return false;
  if (!toolCallRecoveryFactsAddNestedHistory(attempt, runId, calls, results)) return false;
  const observed = new Set();
  return attempt.toolMetas.every(meta => {
    if (
      !toolCallRecoveryFactsIsRecord(meta) ||
      !toolCallRecoveryFactsIsIdentity(meta.toolCallId) ||
      !toolCallRecoveryFactsIsIdentity(meta.toolName) ||
      observed.has(meta.toolCallId) ||
      calls.get(meta.toolCallId) !== meta.toolName ||
      !results.has(meta.toolCallId)
    ) {
      return false;
    }
    observed.add(meta.toolCallId);
    return true;
  });
}

function toolCallRecoveryFactsReadTextPhase(block) {
  const signature = block.textSignature;
  if (typeof signature !== 'string' || !signature.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(signature);
    return toolCallRecoveryFactsIsRecord(parsed) && parsed.v === 1 ? parsed.phase : undefined;
  } catch {
    return undefined;
  }
}

function toolCallRecoveryFactsObserveAssistant(assistant) {
  if (
    !toolCallRecoveryFactsIsRecord(assistant) ||
    assistant.role !== 'assistant' ||
    !Array.isArray(assistant.content)
  ) {
    return { valid: false, residualCalls: true, hasVisibleText: false, commentaryOnly: false };
  }
  let valid = true;
  let residualCalls = false;
  let hasVisibleText = false;
  let allCommentary = assistant.phase === undefined || assistant.phase === 'commentary';
  for (const block of assistant.content) {
    if (!toolCallRecoveryFactsIsRecord(block)) {
      valid = false;
    } else if (block.type === 'toolCall') {
      residualCalls = true;
    } else if (block.type === 'thinking') {
      valid &&= typeof block.thinking === 'string';
    } else if (['text', 'input_text', 'output_text'].includes(block.type)) {
      if (typeof block.text !== 'string') {
        valid = false;
      } else if (block.text.trim().length > 0) {
        hasVisibleText = true;
        allCommentary &&= toolCallRecoveryFactsReadTextPhase(block) === 'commentary';
      }
    } else {
      valid = false;
    }
  }
  return {
    valid,
    residualCalls,
    hasVisibleText,
    commentaryOnly: valid && hasVisibleText && allCommentary,
  };
}

// Native model observations are cloned before transcript projection. Compare
// their producer receipt and native response identity, never object identity.
function toolCallRecoveryFactsSameObservation(completed, current) {
  if (!toolCallRecoveryFactsIsRecord(current) || !toolCallRecoveryFactsIsRecord(completed))
    return false;
  if (
    !['role', 'stopReason', 'errorCode', 'timestamp', 'provider', 'model', 'responseId'].every(
      key => completed[key] === current[key],
    )
  )
    return false;
  const receipt = assistant =>
    Array.isArray(assistant.diagnostics)
      ? assistant.diagnostics.filter(
          entry =>
            toolCallRecoveryFactsIsRecord(entry) &&
            entry.type === toolCallRecoveryFactsRejectionDiagnostic,
        )
      : [];
  const expected = receipt(completed);
  const actual = receipt(current);
  return (
    expected.length === 1 &&
    actual.length === 1 &&
    toolCallRecoveryFactsIsNonNegativeSafeInteger(expected[0].timestamp) &&
    expected[0].timestamp === actual[0].timestamp &&
    toolCallRecoveryFactsIsRecord(actual[0].details) &&
    actual[0].details.batchRejected === true &&
    actual[0].details.streamComplete === true &&
    actual[0].details.dispatchCount === 0
  );
}

/**
 * Projects current native observations without granting authority or changing input.
 * The native caller must bind the producer diagnostic to its live model call and
 * retain the returned exclusion bit across all attempts of the same runner.
 */
export function observeToolCallRecoveryAttempt(attempt, previousExcluded = false, runId) {
  const source = toolCallRecoveryFactsIsRecord(attempt) ? attempt : {};
  const assistant = Object.hasOwn(source, 'currentAttemptCompletedAssistant')
    ? source.currentAttemptCompletedAssistant
    : undefined;
  const content = toolCallRecoveryFactsObserveAssistant(assistant);
  const diagnostics = assistant?.diagnostics;
  const diagnosticArrayValid =
    diagnostics === undefined ||
    (Array.isArray(diagnostics) &&
      diagnostics.every(
        entry =>
          toolCallRecoveryFactsIsRecord(entry) && toolCallRecoveryFactsIsIdentity(entry.type),
      ));
  const producers = Array.isArray(diagnostics)
    ? diagnostics.filter(
        entry =>
          toolCallRecoveryFactsIsRecord(entry) &&
          entry.type === toolCallRecoveryFactsRejectionDiagnostic,
      )
    : [];
  const details = producers.length === 1 ? producers[0].details : undefined;
  const producerConfirmed =
    toolCallRecoveryFactsIsRecord(details) &&
    toolCallRecoveryFactsIsNonNegativeSafeInteger(producers[0].timestamp) &&
    details.batchRejected === true &&
    details.streamComplete === true &&
    details.dispatchCount === 0;
  const latestSnapshotAssistant = Array.isArray(source.messagesSnapshot)
    ? source.messagesSnapshot.findLast(
        message => toolCallRecoveryFactsIsRecord(message) && message.role === 'assistant',
      )
    : undefined;
  const currentObservation = source.currentAttemptAssistant ?? latestSnapshotAssistant;
  const observationMatches =
    assistant !== undefined &&
    (currentObservation === undefined ||
      toolCallRecoveryFactsSameObservation(assistant, currentObservation));
  const rejected =
    content.valid &&
    !content.residualCalls &&
    diagnosticArrayValid &&
    producerConfirmed &&
    observationMatches &&
    assistant.stopReason === 'error' &&
    assistant.errorCode === toolCallRecoveryFactsRejectionErrorCode;
  const malformedAssistant = assistant !== undefined && !content.valid;
  const allToolsSettled = toolCallRecoveryFactsHasSettledToolHistory(source, runId);
  return {
    excluded:
      previousExcluded !== false ||
      !toolCallRecoveryFactsIsRecord(attempt) ||
      toolCallRecoveryFactsExcludesAttempt(source) ||
      !allToolsSettled ||
      malformedAssistant ||
      (producerConfirmed && !observationMatches) ||
      !diagnosticArrayValid ||
      producers.length > 1,
    allToolsSettled,
    assistant,
    rejected,
    streamComplete: rejected,
    dispatchCount: rejected ? 0 : undefined,
    hasVisibleText: content.hasVisibleText,
    commentaryOnly: content.commentaryOnly,
  };
}
