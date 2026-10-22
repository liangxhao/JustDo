const toolCallRecoveryFactsRejectionDiagnostic = 'tool_call_pre_dispatch_rejection';
const toolCallRecoveryFactsRejectionErrorCode = 'malformed_tool_call_arguments';

const toolCallRecoveryFactsIsRecord = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const toolCallRecoveryFactsIsNonNegativeSafeInteger = value =>
  Number.isSafeInteger(value) && value >= 0;

const toolCallRecoveryFeedbackKinds = [
  'missing_tool_name', 'empty_arguments', 'non_object_arguments', 'invalid_json', 'native_rejected',
];
const toolCallRecoveryFeedbackDetails = [
  'xml_like_input', 'unterminated_string', 'invalid_escape', 'unexpected_token',
];

// JSON-only projection: neither names, parser messages nor argument previews survive.
function toolCallRecoveryFactsReadFeedback(value) {
  try {
    if (!toolCallRecoveryFactsIsRecord(value) || value.version !== 1 ||
      !toolCallRecoveryFactsIsNonNegativeSafeInteger(value.batchCallCount) || value.batchCallCount === 0 ||
      !Array.isArray(value.issues) || value.issues.length > 3 || typeof value.omitted !== 'boolean' ||
      value.localization !== (value.issues.length ? 'located' : 'unlocalized')) return undefined;
    const issues = [];
    let previous = -1;
    for (const issue of value.issues) {
      if (!toolCallRecoveryFactsIsRecord(issue) ||
        !toolCallRecoveryFactsIsNonNegativeSafeInteger(issue.callIndex) ||
        issue.callIndex <= previous || issue.callIndex >= value.batchCallCount ||
        !toolCallRecoveryFeedbackKinds.includes(issue.kind) ||
        !toolCallRecoveryFactsIsNonNegativeSafeInteger(issue.argumentChars) ||
        (issue.detail !== undefined && (issue.kind !== 'invalid_json' || !toolCallRecoveryFeedbackDetails.includes(issue.detail))) ||
        (issue.position !== undefined && (issue.kind !== 'invalid_json' ||
          !toolCallRecoveryFactsIsNonNegativeSafeInteger(issue.position) || issue.position > issue.argumentChars))) return undefined;
      previous = issue.callIndex;
      issues.push({ callIndex: issue.callIndex, kind: issue.kind, argumentChars: issue.argumentChars,
        ...(issue.detail === undefined ? {} : { detail: issue.detail }),
        ...(issue.position === undefined ? {} : { position: issue.position }) });
    }
    return { version: 1, batchCallCount: value.batchCallCount, issues,
      omitted: value.omitted, localization: value.localization };
  } catch { return undefined; }
}

/** Called only inside native batch rejection; the validator receives a disposable dummy. */
export function projectToolCallRecoveryRejectionFeedback(calls, finalizeArguments) {
  try {
    if (!Array.isArray(calls) || !calls.length || typeof finalizeArguments !== 'function') return undefined;
    const issues = [];
    let remaining = 16 * 1024;
    let omitted = calls.length > 16;
    for (let callIndex = 0; callIndex < Math.min(calls.length, 16); callIndex += 1) {
      if (issues.length === 3) { omitted = true; break; }
      const call = calls[callIndex];
      if (!toolCallRecoveryFactsIsRecord(call)) { omitted = true; continue; }
      const raw = call.partialArgs;
      const argumentChars = typeof raw === 'string' ? raw.length : 0;
      // Reserve eight full-input passes (including the native parser) before any scan.
      const cost = (typeof call.name === 'string' ? call.name.length : 0) + argumentChars * 8;
      if (cost > remaining) { omitted = true; continue; }
      remaining -= cost;
      const issue = { callIndex, argumentChars };
      if (typeof call.name !== 'string' || !call.name.trim()) issue.kind = 'missing_tool_name';
      else if (typeof raw !== 'string' || !raw.trim()) issue.kind = 'empty_arguments';
      else {
        try {
          finalizeArguments([{ arguments: {}, partialArgs: raw }], dummy => dummy.partialArgs);
          continue;
        } catch (error) {
          if (error?.errorCode !== toolCallRecoveryFactsRejectionErrorCode) { omitted = true; continue; }
        }
        issue.kind = 'native_rejected';
        // Integer preprocessing can change both acceptance and the first error position.
        if (!/[0-9]{16}/.test(raw)) {
          try {
            const parsed = JSON.parse(raw);
            if (!toolCallRecoveryFactsIsRecord(parsed)) issue.kind = 'non_object_arguments';
          } catch (error) {
            issue.kind = 'invalid_json';
            const message = typeof error?.message === 'string' ? error.message : '';
            if (raw.trimStart().startsWith('<')) issue.detail = 'xml_like_input';
            else if (message.startsWith('Unterminated string')) issue.detail = 'unterminated_string';
            else if (/^Bad (?:escaped character|Unicode escape)/.test(message)) issue.detail = 'invalid_escape';
            else if (/^(?:Unexpected token|Expected |Unexpected non-whitespace)/.test(message)) issue.detail = 'unexpected_token';
            // Read only the engine's numeric suffix, never the input excerpt in its message.
            const position = /\bin JSON at position (\d+)(?: \(line \d+ column \d+\))?$/.exec(message);
            if (position && Number(position[1]) <= raw.length) issue.position = Number(position[1]);
          }
        }
      }
      issues.push(issue);
    }
    return toolCallRecoveryFactsReadFeedback({ version: 1, batchCallCount: calls.length, issues,
      omitted, localization: issues.length ? 'located' : 'unlocalized' });
  } catch { return undefined; }
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

/** Bound by streamAgentResponse to the actual final response, before persistence. */
export function observeToolCallRecoveryResponse(assistant) {
  const content = toolCallRecoveryFactsObserveAssistant(assistant);
  const producers = Array.isArray(assistant?.diagnostics)
    ? assistant.diagnostics.filter(entry => toolCallRecoveryFactsIsRecord(entry) &&
      entry.type === toolCallRecoveryFactsRejectionDiagnostic) : [];
  const details = producers.length === 1 ? producers[0].details : undefined;
  const rejected = content.valid && !content.residualCalls &&
    Array.isArray(assistant?.diagnostics) && assistant.diagnostics.every(entry =>
      toolCallRecoveryFactsIsRecord(entry) && entry.type === toolCallRecoveryFactsRejectionDiagnostic) &&
    assistant.stopReason === 'error' && assistant.errorCode === toolCallRecoveryFactsRejectionErrorCode &&
    toolCallRecoveryFactsIsNonNegativeSafeInteger(producers[0]?.timestamp) &&
    toolCallRecoveryFactsIsRecord(details) && details.batchRejected === true &&
    details.streamComplete === true && details.dispatchCount === 0;
  return { rejected, streamComplete: rejected, dispatchCount: rejected ? 0 : undefined,
    feedback: rejected ? toolCallRecoveryFactsReadFeedback(details.feedback) : undefined,
    hasVisibleText: content.hasVisibleText, commentaryOnly: content.commentaryOnly };
}
