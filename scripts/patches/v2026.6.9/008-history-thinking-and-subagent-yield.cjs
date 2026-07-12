'use strict';

// Purpose: Preserve streamed thinking blocks after chat.history refreshes and
// treat sessions_yield completion handoffs as delivered for session-only
// subagent completion announcements, and prevent thinking-only stop turns from
// being finalized as silent successful replies after an aborted provider stream.
// Affected OpenClaw version: v2026.6.9.
// Risk: Chat history may show thinking blocks that upstream currently projects
// out; subagent completion delivery may accept a session-yield side effect as
// successful even when the completion agent does not emit visible text. A
// thinking-only stop turn with no visible output is retried or surfaced as
// incomplete instead of marking the run completed.
// Remove when: OpenClaw preserves display thinking in chat.history and records
// sessions_yield handoffs as completion delivery evidence natively, and treats
// thinking-only stop turns as incomplete/non-silent.
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

function replaceOnce(content, from, to, label, filePath) {
  if (!content.includes(from)) {
    if (content.includes(to)) return { content, changed: false };
    return { content, changed: false };
  }
  return { content: content.replace(from, to), changed: true };
}

function patchFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  let content = fs.readFileSync(filePath, 'utf8');
  let changed = false;

  const mixedToolProjectionBefore = `function projectAssistantTextFromMixedToolContent(content, maxChars) {
  if (!content.some((block3) => {
    if (!block3 || typeof block3 !== "object") return false;
    return isToolHistoryBlockType(block3.type);
  })) return null;
  const textBlocks = [];
  for (const block3 of content) {
    if (!block3 || typeof block3 !== "object") continue;
    const entry = block3;
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
  if (!content.some((block3) => {
    if (!block3 || typeof block3 !== "object") return false;
    return isToolHistoryBlockType(block3.type);
  })) return null;
  const displayBlocks = [];
  for (const block3 of content) {
    if (!block3 || typeof block3 !== "object") continue;
    const entry = block3;
    if (entry.type === "thinking" || entry.type === "reasoning" || entry.type === "redacted_thinking") {
      displayBlocks.push(block3);
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

  let result = replaceOnce(
    content,
    mixedToolProjectionBefore,
    mixedToolProjectionAfter,
    'mixed tool-use thinking projection',
    filePath,
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    `    return type !== "thinking" && type !== "reasoning" && type !== "redacted_thinking";`,
    '    return true;',
    'assistant error thinking projection',
    filePath,
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    `  return hasMessagingToolDeliveryEvidence(result) || Array.isArray(result.acceptedSessionSpawns) && hasAcceptedSessionSpawn(result.acceptedSessionSpawns) || hasPositiveDeliveryCount(result.successfulCronAdds);
}`,
    `  return hasMessagingToolDeliveryEvidence(result) || Array.isArray(result.acceptedSessionSpawns) && hasAcceptedSessionSpawn(result.acceptedSessionSpawns) || hasPositiveDeliveryCount(result.successfulCronAdds) || Array.isArray(result.meta?.toolSummary?.tools) && result.meta.toolSummary.tools.includes("sessions_yield");
}`,
    'sessions_yield completion side-effect evidence',
    filePath,
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    `function isZeroUsageEmptyStopAssistantTurn(message2) {
  return Boolean(message2 && message2.stopReason === "stop" && Array.isArray(message2.content) && message2.content.length === 0 && hasZeroTokenUsageSnapshot(message2.usage));
}`,
    `function isZeroUsageEmptyStopAssistantTurn(message2) {
  return Boolean(message2 && message2.stopReason === "stop" && Array.isArray(message2.content) && (message2.content.length === 0 || hasOnlyAssistantReasoningContent(message2)) && hasZeroTokenUsageSnapshot(message2.usage));
}`,
    'zero-usage thinking-only stop retry',
    filePath,
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    `function isIncompleteTerminalAssistantTurn(params) {
  const stopReason = params.lastAssistant?.stopReason;
  return stopReason === "toolUse" || stopReason === "length" && !params.hasTerminalOutput;
}`,
    `function isIncompleteTerminalAssistantTurn(params) {
  const stopReason = params.lastAssistant?.stopReason;
  const thinkingOnlyStop = stopReason === "stop" && !params.hasTerminalOutput && !params.hasAssistantVisibleText && Boolean(params.lastAssistant && hasOnlyAssistantReasoningContent(params.lastAssistant));
  return stopReason === "toolUse" || stopReason === "length" && !params.hasTerminalOutput || thinkingOnlyStop;
}`,
    'thinking-only stop incomplete terminal detection',
    filePath,
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    `  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant;
  if (params.payloadCount === 0 && assistant?.stopReason !== "error" && hasOnlySilentAssistantReply(params.attempt.assistantTexts)) return true;`,
    `  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant;
  if (assistant && hasOnlyAssistantReasoningContent(assistant)) return false;
  if (params.payloadCount === 0 && assistant?.stopReason !== "error" && hasOnlySilentAssistantReply(params.attempt.assistantTexts)) return true;`,
    'thinking-only stop is not silent reply',
    filePath,
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
