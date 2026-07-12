'use strict';

// Purpose: Preserve streamed thinking blocks after chat.history refreshes and
// treat sessions_yield completion handoffs as committed outbound delivery
// evidence for session-only subagent completion announcements.
// Affected OpenClaw version: v2026.6.11.
// Risk: Chat history may show thinking blocks that upstream currently projects
// out; subagent completion delivery may accept a sessions_yield side effect as
// successful even when the completion agent does not emit visible text.
// Remove when: OpenClaw preserves display thinking in chat.history and records
// sessions_yield handoffs as committed delivery evidence natively.
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
    '	return hasMessagingToolDeliveryEvidence(result) || Array.isArray(result.acceptedSessionSpawns) && hasAcceptedSessionSpawn(result.acceptedSessionSpawns) || hasPositiveNumber(result.successfulCronAdds);',
    '	return hasMessagingToolDeliveryEvidence(result) || Array.isArray(result.acceptedSessionSpawns) && hasAcceptedSessionSpawn(result.acceptedSessionSpawns) || hasPositiveNumber(result.successfulCronAdds) || Array.isArray(result.meta?.toolSummary?.tools) && result.meta.toolSummary.tools.includes("sessions_yield");',
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
