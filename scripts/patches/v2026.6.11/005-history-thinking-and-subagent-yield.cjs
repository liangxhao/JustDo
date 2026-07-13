'use strict';

// Purpose: Preserve streamed thinking blocks after chat.history refreshes,
// keep reasoning-only display turns visible, treat sessions_yield completion
// handoffs as committed outbound delivery evidence for session-only subagent
// completion announcements, accept intentional silent completion turns that
// reply NO_REPLY, and retry zero/missing-usage visible stop turns that are
// usually provider-aborted partial assistant snapshots.
// Affected OpenClaw version: v2026.6.11.
// Risk: Chat history may show thinking blocks that upstream currently projects
// out; subagent completion delivery may accept a sessions_yield side effect as
// successful even when the completion agent does not emit visible text.
// Remove when: OpenClaw preserves display thinking in chat.history, treats
// reasoning-only assistant turns as visible display content, records
// sessions_yield handoffs as committed delivery evidence natively, accepts
// intentional silent completion turns for subagent announcements, and retries
// zero/missing-token visible stop turns after provider stream aborts.
// Upstream tracking: TODO(openclaw): file issue/PR with JustDo long-task
// thinking refresh and subagent sessions_yield announce reproductions.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

function walkJsFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsFiles(fullPath, out);
    } else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) {
      out.push(fullPath);
    }
  }
  return out;
}

function replaceOnce(content, from, to) {
  if (content.includes(to)) return { content, changed: false };
  if (!content.includes(from)) {
    return { content, changed: false };
  }
  return { content: content.replace(from, to), changed: true };
}

function collapseOnce(content, from, to) {
  if (!content.includes(from)) {
    return { content, changed: false };
  }
  return { content: content.replace(from, to), changed: true };
}

function patchFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  let content = fs.readFileSync(filePath, 'utf8');
  let changed = false;

  const mixedToolProjectionBefore = `function projectAssistantTextFromMixedToolContent(content, maxChars) {
	if (!content.some((block) => {
		if (!block || typeof block !== "object") return false;
		return isToolHistoryBlockType(block.type);
	})) return null;
	const textBlocks = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const entry = block;
		if (entry.type !== "text" || typeof entry.text !== "string" || !entry.text.trim()) continue;
		const truncated = truncateChatHistoryText(stripInlineDirectiveTagsForDisplay(entry.text).text, maxChars);
		if (truncated.text.trim()) textBlocks.push({
			type: "text",
			text: truncated.text
		});
	}
	return textBlocks.length > 0 ? {
		content: textBlocks,
		changed: true
	} : null;
}`;

  const mixedToolProjectionAfter = `function projectAssistantTextFromMixedToolContent(content, maxChars) {
	if (!content.some((block) => {
		if (!block || typeof block !== "object") return false;
		return isToolHistoryBlockType(block.type);
	})) return null;
	const displayBlocks = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const entry = block;
		if (entry.type === "thinking" || entry.type === "reasoning" || entry.type === "redacted_thinking") {
			displayBlocks.push(block);
			continue;
		}
		if (entry.type !== "text" || typeof entry.text !== "string" || !entry.text.trim()) continue;
		const truncated = truncateChatHistoryText(stripInlineDirectiveTagsForDisplay(entry.text).text, maxChars);
		if (truncated.text.trim()) displayBlocks.push({
			type: "text",
			text: truncated.text
		});
	}
	return displayBlocks.length > 0 ? {
		content: displayBlocks,
		changed: true
	} : null;
}`;

  let result = replaceOnce(content, mixedToolProjectionBefore, mixedToolProjectionAfter);
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    'function hasAssistantNonTextContent(message) {\n\tif (!message || typeof message !== "object") return false;\n\tconst content = message.content;\n\tif (!Array.isArray(content)) return false;\n\treturn content.some((block) => block && typeof block === "object" && !isAssistantTextContentType(block.type));\n}',
    'function isAssistantReasoningContentType(type) {\n\treturn type === "thinking" || type === "reasoning" || type === "redacted_thinking";\n}\nfunction hasAssistantNonTextContent(message) {\n\tif (!message || typeof message !== "object") return false;\n\tconst content = message.content;\n\tif (!Array.isArray(content)) return false;\n\treturn content.some((block) => block && typeof block === "object" && !isAssistantTextContentType(block.type) && !isAssistantReasoningContentType(block.type));\n}',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    'function hasAssistantNonTextContent(message2) {\n  if (!message2 || typeof message2 !== "object") return false;\n  const content = message2.content;\n  if (!Array.isArray(content)) return false;\n  return content.some((block3) => block3 && typeof block3 === "object" && !isAssistantTextContentType(block3.type));\n}',
    'function isAssistantReasoningContentType(type) {\n  return type === "thinking" || type === "reasoning" || type === "redacted_thinking";\n}\nfunction hasAssistantNonTextContent(message2) {\n  if (!message2 || typeof message2 !== "object") return false;\n  const content = message2.content;\n  if (!Array.isArray(content)) return false;\n  return content.some((block3) => block3 && typeof block3 === "object" && !isAssistantTextContentType(block3.type) && !isAssistantReasoningContentType(block3.type));\n}',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '\t\tif (isAssistantTextContentType(entry.type) && typeof entry.text === "string" && entry.text.trim()) hasText = true;',
    '\t\tif (isAssistantTextContentType(entry.type) && typeof entry.text === "string" && entry.text.trim()) hasText = true;\n\t\tif (isAssistantReasoningContentType(entry.type) && typeof entry.thinking === "string" && entry.thinking.trim()) hasText = true;',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '    if (isAssistantTextContentType(entry.type) && typeof entry.text === "string" && entry.text.trim()) hasText = true;',
    '    if (isAssistantTextContentType(entry.type) && typeof entry.text === "string" && entry.text.trim()) hasText = true;\n    if (isAssistantReasoningContentType(entry.type) && typeof entry.thinking === "string" && entry.thinking.trim()) hasText = true;',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '\treturn text !== void 0 && !isSuppressedControlReplyText(text);',
    '\tif (text !== void 0) return !isSuppressedControlReplyText(text);\n\tconst content = message.content;\n\treturn Array.isArray(content) && content.some((block) => block && typeof block === "object" && isAssistantReasoningContentType(block.type) && typeof block.thinking === "string" && block.thinking.trim());',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '  return text !== void 0 && !isSuppressedControlReplyText(text);',
    '  if (text !== void 0) return !isSuppressedControlReplyText(text);\n  const content = message2.content;\n  return Array.isArray(content) && content.some((block3) => block3 && typeof block3 === "object" && isAssistantReasoningContentType(block3.type) && typeof block3.thinking === "string" && block3.thinking.trim());',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '\t\treturn type !== "thinking" && type !== "reasoning" && type !== "redacted_thinking";',
    '\t\treturn true;',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '    return type !== "thinking" && type !== "reasoning" && type !== "redacted_thinking";',
    '    return true;',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    'function isZeroUsageEmptyStopAssistantTurn(message2) {\n  return Boolean(message2 && message2.stopReason === "stop" && Array.isArray(message2.content) && message2.content.length === 0 && hasZeroTokenUsageSnapshot(message2.usage));\n}',
    'function isZeroOrMissingUsageSnapshot(usage) {\n  return usage == null || hasZeroTokenUsageSnapshot(usage);\n}\nfunction isZeroUsageEmptyStopAssistantTurn(message2) {\n  return Boolean(message2 && message2.stopReason === "stop" && Array.isArray(message2.content) && (message2.content.length === 0 || hasOnlyAssistantReasoningContent(message2)) && hasZeroTokenUsageSnapshot(message2.usage));\n}\nfunction isZeroUsageVisibleStopAssistantTurn(message2) {\n  return Boolean(message2 && message2.stopReason === "stop" && Array.isArray(message2.content) && message2.content.some((block3) => block3 && typeof block3 === "object" && isAssistantTextContentType(block3.type) && typeof block3.text === "string" && block3.text.trim()) && isZeroOrMissingUsageSnapshot(message2.usage));\n}',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    'function isZeroUsageEmptyStopAssistantTurn(message2) {\n  return Boolean(message2 && message2.stopReason === "stop" && Array.isArray(message2.content) && (message2.content.length === 0 || hasOnlyAssistantReasoningContent(message2)) && hasZeroTokenUsageSnapshot(message2.usage));\n}\nfunction isZeroUsageVisibleStopAssistantTurn(message2) {\n  return Boolean(message2 && message2.stopReason === "stop" && Array.isArray(message2.content) && message2.content.some((block3) => block3 && typeof block3 === "object" && isAssistantTextContentType(block3.type) && typeof block3.text === "string" && block3.text.trim()) && hasZeroTokenUsageSnapshot(message2.usage));\n}',
    'function isZeroOrMissingUsageSnapshot(usage) {\n  return usage == null || hasZeroTokenUsageSnapshot(usage);\n}\nfunction isZeroUsageEmptyStopAssistantTurn(message2) {\n  return Boolean(message2 && message2.stopReason === "stop" && Array.isArray(message2.content) && (message2.content.length === 0 || hasOnlyAssistantReasoningContent(message2)) && hasZeroTokenUsageSnapshot(message2.usage));\n}\nfunction isZeroUsageVisibleStopAssistantTurn(message2) {\n  return Boolean(message2 && message2.stopReason === "stop" && Array.isArray(message2.content) && message2.content.some((block3) => block3 && typeof block3 === "object" && isAssistantTextContentType(block3.type) && typeof block3.text === "string" && block3.text.trim()) && isZeroOrMissingUsageSnapshot(message2.usage));\n}',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    'function resolveEmptyResponseRetryInstruction(params) {\n  if (shouldSkipNonVisibleTurnRetry(params)) return null;\n  if (!isEmptyResponseAssistantTurn({\n    payloadCount: params.payloadCount,\n    attempt: params.attempt\n  })) return null;\n  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant ?? null;\n  if (assistant?.stopReason === "stop" && OLLAMA_INCOMPLETE_TURN_PROVIDER_ID_PATTERN.test(normalizeLowercaseStringOrEmpty(params.provider ?? "")) && !hasPositiveOutputTokenUsage(assistant)) return null;\n  if (shouldApplyNonVisibleTurnRetryGuard({\n    provider: params.provider,\n    modelId: params.modelId,\n    modelApi: params.modelApi,\n    executionContract: params.executionContract\n  }) || isZeroUsageEmptyStopAssistantTurn(assistant)) return EMPTY_RESPONSE_RETRY_INSTRUCTION;\n  return null;\n}',
    'function resolveEmptyResponseRetryInstruction(params) {\n  if (shouldSkipNonVisibleTurnRetry(params)) return null;\n  if (!isEmptyResponseAssistantTurn({\n    payloadCount: params.payloadCount,\n    attempt: params.attempt\n  })) return null;\n  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant ?? null;\n  if (assistant?.stopReason === "stop" && OLLAMA_INCOMPLETE_TURN_PROVIDER_ID_PATTERN.test(normalizeLowercaseStringOrEmpty(params.provider ?? "")) && !hasPositiveOutputTokenUsage(assistant)) return null;\n  if (shouldApplyNonVisibleTurnRetryGuard({\n    provider: params.provider,\n    modelId: params.modelId,\n    modelApi: params.modelApi,\n    executionContract: params.executionContract\n  }) || isZeroUsageEmptyStopAssistantTurn(assistant)) return EMPTY_RESPONSE_RETRY_INSTRUCTION;\n  return null;\n}\nfunction resolveZeroUsageVisibleStopRetryInstruction(params) {\n  if (params.timedOut) return null;\n  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant ?? null;\n  if (!isZeroUsageVisibleStopAssistantTurn(assistant)) return null;\n  if (hasOnlySilentAssistantReply(params.attempt.assistantTexts)) return null;\n  if (hasCommittedMessagingToolDeliveryEvidence(params.attempt)) return null;\n  if (hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns)) return null;\n  if (params.attempt.clientToolCalls || params.attempt.yieldDetected || params.attempt.didSendDeterministicApprovalPrompt || params.attempt.lastToolError || resolveAttemptReplayMetadata(params.attempt).hadPotentialSideEffects) return null;\n  if (!shouldApplyNonVisibleTurnRetryGuard({\n    provider: params.provider,\n    modelId: params.modelId,\n    modelApi: params.modelApi,\n    executionContract: params.executionContract\n  })) return null;\n  return "The previous attempt recorded a partial assistant sentence with zero or missing model token usage before taking the next action. Continue from the current state and perform the promised next action now. Do not restart from scratch, repeat completed work, or summarize instead of acting.";\n}',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    'function resolveZeroUsageVisibleStopRetryInstruction(params) {\n  if (params.aborted || params.timedOut) return null;\n  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant ?? null;\n  if (!isZeroUsageVisibleStopAssistantTurn(assistant)) return null;\n  if (hasOnlySilentAssistantReply(params.attempt.assistantTexts)) return null;\n  if (hasCommittedMessagingToolDeliveryEvidence(params.attempt)) return null;\n  if (hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns)) return null;\n  if (!shouldApplyNonVisibleTurnRetryGuard({\n    provider: params.provider,\n    modelId: params.modelId,\n    modelApi: params.modelApi,\n    executionContract: params.executionContract\n  })) return null;\n  return "The previous attempt recorded a partial assistant sentence with zero model token usage. Continue from the current state and perform the promised next action now. Do not restart from scratch, repeat completed work, or summarize instead of acting.";\n}',
    'function resolveZeroUsageVisibleStopRetryInstruction(params) {\n  if (params.timedOut) return null;\n  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant ?? null;\n  if (!isZeroUsageVisibleStopAssistantTurn(assistant)) return null;\n  if (hasOnlySilentAssistantReply(params.attempt.assistantTexts)) return null;\n  if (hasCommittedMessagingToolDeliveryEvidence(params.attempt)) return null;\n  if (hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns)) return null;\n  if (params.attempt.clientToolCalls || params.attempt.yieldDetected || params.attempt.didSendDeterministicApprovalPrompt || params.attempt.lastToolError || resolveAttemptReplayMetadata(params.attempt).hadPotentialSideEffects) return null;\n  if (!shouldApplyNonVisibleTurnRetryGuard({\n    provider: params.provider,\n    modelId: params.modelId,\n    modelApi: params.modelApi,\n    executionContract: params.executionContract\n  })) return null;\n  return "The previous attempt recorded a partial assistant sentence with zero or missing model token usage before taking the next action. Continue from the current state and perform the promised next action now. Do not restart from scratch, repeat completed work, or summarize instead of acting.";\n}',
  );
  content = result.content;
  changed ||= result.changed;

  result = collapseOnce(
    content,
    'function resolveZeroUsageVisibleStopRetryInstruction(params) {\n  if (params.timedOut) return null;\n  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant ?? null;\n  if (!isZeroUsageVisibleStopAssistantTurn(assistant)) return null;\n  if (hasOnlySilentAssistantReply(params.attempt.assistantTexts)) return null;\n  if (hasCommittedMessagingToolDeliveryEvidence(params.attempt)) return null;\n  if (hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns)) return null;\n  if (params.attempt.clientToolCalls || params.attempt.yieldDetected || params.attempt.didSendDeterministicApprovalPrompt || params.attempt.lastToolError || resolveAttemptReplayMetadata(params.attempt).hadPotentialSideEffects) return null;\n  if (!shouldApplyNonVisibleTurnRetryGuard({\n    provider: params.provider,\n    modelId: params.modelId,\n    modelApi: params.modelApi,\n    executionContract: params.executionContract\n  })) return null;\n  return "The previous attempt recorded a partial assistant sentence with zero or missing model token usage before taking the next action. Continue from the current state and perform the promised next action now. Do not restart from scratch, repeat completed work, or summarize instead of acting.";\n}\nfunction resolveZeroUsageVisibleStopRetryInstruction(params) {\n  if (params.aborted || params.timedOut) return null;\n  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant ?? null;\n  if (!isZeroUsageVisibleStopAssistantTurn(assistant)) return null;\n  if (hasOnlySilentAssistantReply(params.attempt.assistantTexts)) return null;\n  if (hasCommittedMessagingToolDeliveryEvidence(params.attempt)) return null;\n  if (hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns)) return null;\n  if (!shouldApplyNonVisibleTurnRetryGuard({\n    provider: params.provider,\n    modelId: params.modelId,\n    modelApi: params.modelApi,\n    executionContract: params.executionContract\n  })) return null;\n  return "The previous attempt recorded a partial assistant sentence with zero model token usage. Continue from the current state and perform the promised next action now. Do not restart from scratch, repeat completed work, or summarize instead of acting.";\n}',
    'function resolveZeroUsageVisibleStopRetryInstruction(params) {\n  if (params.timedOut) return null;\n  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant ?? null;\n  if (!isZeroUsageVisibleStopAssistantTurn(assistant)) return null;\n  if (hasOnlySilentAssistantReply(params.attempt.assistantTexts)) return null;\n  if (hasCommittedMessagingToolDeliveryEvidence(params.attempt)) return null;\n  if (hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns)) return null;\n  if (params.attempt.clientToolCalls || params.attempt.yieldDetected || params.attempt.didSendDeterministicApprovalPrompt || params.attempt.lastToolError || resolveAttemptReplayMetadata(params.attempt).hadPotentialSideEffects) return null;\n  if (!shouldApplyNonVisibleTurnRetryGuard({\n    provider: params.provider,\n    modelId: params.modelId,\n    modelApi: params.modelApi,\n    executionContract: params.executionContract\n  })) return null;\n  return "The previous attempt recorded a partial assistant sentence with zero or missing model token usage before taking the next action. Continue from the current state and perform the promised next action now. Do not restart from scratch, repeat completed work, or summarize instead of acting.";\n}',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '          if (!nextReasoningOnlyRetryInstruction && nextEmptyResponseRetryInstruction && emptyResponseRetryAttempts < maxEmptyResponseRetryAttempts) {\n            emptyResponseRetryAttempts += 1;\n            emptyResponseRetryInstruction = nextEmptyResponseRetryInstruction;\n            log41.warn(`empty response detected: runId=${params.runId} sessionId=${params.sessionId} provider=${activeErrorContext.provider}/${activeErrorContext.model} — retrying ${emptyResponseRetryAttempts}/${maxEmptyResponseRetryAttempts} with visible-answer continuation`);\n            continue;\n          }',
    '          const zeroUsageVisibleStopRetryInstruction = emptyAssistantReplyIsSilent ? null : resolveZeroUsageVisibleStopRetryInstruction({\n            provider: activeErrorContext.provider,\n            modelId: activeErrorContext.model,\n            modelApi: effectiveModel.api,\n            executionContract,\n            aborted: aborted3,\n            timedOut,\n            attempt\n          });\n          const emptyOrZeroUsageRetryInstruction = nextEmptyResponseRetryInstruction || zeroUsageVisibleStopRetryInstruction;\n          if (!nextReasoningOnlyRetryInstruction && emptyOrZeroUsageRetryInstruction && emptyResponseRetryAttempts < maxEmptyResponseRetryAttempts) {\n            emptyResponseRetryAttempts += 1;\n            emptyResponseRetryInstruction = emptyOrZeroUsageRetryInstruction;\n            log41.warn(`${zeroUsageVisibleStopRetryInstruction ? "zero/missing-usage visible stop" : "empty response"} detected: runId=${params.runId} sessionId=${params.sessionId} provider=${activeErrorContext.provider}/${activeErrorContext.model} — retrying ${emptyResponseRetryAttempts}/${maxEmptyResponseRetryAttempts} with visible-answer continuation`);\n            continue;\n          }',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '          if (!nextReasoningOnlyRetryInstruction && nextEmptyResponseRetryInstruction && emptyResponseRetryAttempts < maxEmptyResponseRetryAttempts) {\n            emptyResponseRetryAttempts += 1;\n            emptyResponseRetryInstruction = nextEmptyResponseRetryInstruction;\n            log41.warn(`empty response detected: runId=${params.runId} sessionId=${params.sessionId} provider=${activeErrorContext.provider}/${activeErrorContext.model} \\u2014 retrying ${emptyResponseRetryAttempts}/${maxEmptyResponseRetryAttempts} with visible-answer continuation`);\n            continue;\n          }',
    '          const zeroUsageVisibleStopRetryInstruction = emptyAssistantReplyIsSilent ? null : resolveZeroUsageVisibleStopRetryInstruction({\n            provider: activeErrorContext.provider,\n            modelId: activeErrorContext.model,\n            modelApi: effectiveModel.api,\n            executionContract,\n            aborted: aborted3,\n            timedOut,\n            attempt\n          });\n          const emptyOrZeroUsageRetryInstruction = nextEmptyResponseRetryInstruction || zeroUsageVisibleStopRetryInstruction;\n          if (!nextReasoningOnlyRetryInstruction && emptyOrZeroUsageRetryInstruction && emptyResponseRetryAttempts < maxEmptyResponseRetryAttempts) {\n            emptyResponseRetryAttempts += 1;\n            emptyResponseRetryInstruction = emptyOrZeroUsageRetryInstruction;\n            log41.warn(`${zeroUsageVisibleStopRetryInstruction ? "zero/missing-usage visible stop" : "empty response"} detected: runId=${params.runId} sessionId=${params.sessionId} provider=${activeErrorContext.provider}/${activeErrorContext.model} \\u2014 retrying ${emptyResponseRetryAttempts}/${maxEmptyResponseRetryAttempts} with visible-answer continuation`);\n            continue;\n          }',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '          if (\n            !nextReasoningOnlyRetryInstruction &&\n            nextEmptyResponseRetryInstruction &&\n            emptyResponseRetryAttempts < maxEmptyResponseRetryAttempts\n          ) {\n            emptyResponseRetryAttempts += 1;\n            emptyResponseRetryInstruction = nextEmptyResponseRetryInstruction;\n            log.warn(\n              `empty response detected: runId=${params.runId} sessionId=${params.sessionId} ` +\n                `provider=${activeErrorContext.provider}/${activeErrorContext.model} — retrying ${emptyResponseRetryAttempts}/${maxEmptyResponseRetryAttempts} ` +\n                `with visible-answer continuation`,\n            );\n            continue;\n          }',
    '          const zeroUsageVisibleStopRetryInstruction = emptyAssistantReplyIsSilent\n            ? null\n            : resolveZeroUsageVisibleStopRetryInstruction({\n                provider: activeErrorContext.provider,\n                modelId: activeErrorContext.model,\n                modelApi: effectiveModel.api,\n                executionContract,\n                aborted,\n                timedOut,\n                attempt,\n              });\n          const emptyOrZeroUsageRetryInstruction =\n            nextEmptyResponseRetryInstruction || zeroUsageVisibleStopRetryInstruction;\n          if (\n            !nextReasoningOnlyRetryInstruction &&\n            emptyOrZeroUsageRetryInstruction &&\n            emptyResponseRetryAttempts < maxEmptyResponseRetryAttempts\n          ) {\n            emptyResponseRetryAttempts += 1;\n            emptyResponseRetryInstruction = emptyOrZeroUsageRetryInstruction;\n            log.warn(\n              `${zeroUsageVisibleStopRetryInstruction ? "zero/missing-usage visible stop" : "empty response"} detected: runId=${params.runId} sessionId=${params.sessionId} ` +\n                `provider=${activeErrorContext.provider}/${activeErrorContext.model} — retrying ${emptyResponseRetryAttempts}/${maxEmptyResponseRetryAttempts} ` +\n                `with visible-answer continuation`,\n            );\n            continue;\n          }',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '	return hasMessagingToolDeliveryEvidence(result) || Array.isArray(result.acceptedSessionSpawns) && hasAcceptedSessionSpawn(result.acceptedSessionSpawns) || hasPositiveNumber(result.successfulCronAdds);',
    '	return hasMessagingToolDeliveryEvidence(result) || Array.isArray(result.acceptedSessionSpawns) && hasAcceptedSessionSpawn(result.acceptedSessionSpawns) || hasPositiveNumber(result.successfulCronAdds) || Array.isArray(result.meta?.toolSummary?.tools) && result.meta.toolSummary.tools.includes("sessions_yield");',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '  return hasMessagingToolDeliveryEvidence(result) || Array.isArray(result.acceptedSessionSpawns) && hasAcceptedSessionSpawn(result.acceptedSessionSpawns) || hasPositiveDeliveryCount(result.successfulCronAdds);',
    '  return hasMessagingToolDeliveryEvidence(result) || Array.isArray(result.acceptedSessionSpawns) && hasAcceptedSessionSpawn(result.acceptedSessionSpawns) || hasPositiveDeliveryCount(result.successfulCronAdds) || Array.isArray(result.meta?.toolSummary?.tools) && result.meta.toolSummary.tools.includes("sessions_yield");',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '	return hasMessagingToolDeliveryEvidence(result) || Array.isArray(result.acceptedSessionSpawns) && hasAcceptedSessionSpawn(result.acceptedSessionSpawns) || hasPositiveDeliveryCount(result.successfulCronAdds);',
    '	return hasMessagingToolDeliveryEvidence(result) || Array.isArray(result.acceptedSessionSpawns) && hasAcceptedSessionSpawn(result.acceptedSessionSpawns) || hasPositiveDeliveryCount(result.successfulCronAdds) || Array.isArray(result.meta?.toolSummary?.tools) && result.meta.toolSummary.tools.includes("sessions_yield");',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    'function getGatewayAgentCommandDeliveryFailure(response) {\n  const result = getGatewayAgentResult(response);\n  return result ? getAgentCommandDeliveryFailure(result) : void 0;\n}',
    'function getGatewayAgentCommandDeliveryFailure(response) {\n  if (hasIntentionalSilentGatewayAgentPayload(response)) return void 0;\n  const result = getGatewayAgentResult(response);\n  return result ? getAgentCommandDeliveryFailure(result) : void 0;\n}',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    'function getGatewayAgentCommandDeliveryFailure(response: unknown): string | undefined {\n  const result = getGatewayAgentResult(response);\n  return result ? getAgentCommandDeliveryFailure(result) : undefined;\n}',
    'function getGatewayAgentCommandDeliveryFailure(response: unknown): string | undefined {\n  if (hasIntentionalSilentGatewayAgentPayload(response)) return undefined;\n  const result = getGatewayAgentResult(response);\n  return result ? getAgentCommandDeliveryFailure(result) : undefined;\n}',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '    const acceptsIntentionalSilentCompletion = hasIntentionalSilentGatewayAgentPayload(directAnnounceResponse) && !isSubagentCompletion;',
    '    const acceptsIntentionalSilentCompletion = hasIntentionalSilentGatewayAgentPayload(directAnnounceResponse);',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '		const acceptsIntentionalSilentCompletion = hasIntentionalSilentGatewayAgentPayload(directAnnounceResponse) && !isSubagentCompletion;',
    '		const acceptsIntentionalSilentCompletion = hasIntentionalSilentGatewayAgentPayload(directAnnounceResponse);',
  );
  content = result.content;
  changed ||= result.changed;

  if (!changed) return false;
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function applyPatch(runtimeDir, options = {}) {
  const candidates = [
    path.join(runtimeDir, 'gateway-bundle.mjs'),
    ...walkJsFiles(path.join(runtimeDir, 'dist')),
  ].filter((filePath, index, arr) => fs.existsSync(filePath) && arr.indexOf(filePath) === index);

  const patched = [];
  for (const filePath of candidates) {
    if (patchFile(filePath)) patched.push(path.relative(runtimeDir, filePath));
  }

  const label = options.label || 'patch-openclaw-history-thinking-and-subagent-yield';
  if (patched.length > 0) {
    console.log(`[${label}] Patched history thinking/subagent yield: ${patched.join(', ')}`);
  } else if (options.verbose) {
    console.log(`[${label}] No history thinking/subagent yield patch needed.`);
  }

  return patched;
}

module.exports = { applyPatch };
