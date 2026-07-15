'use strict';

// Purpose: Skip a queued sibling subagent completion announce when that
// child's complete result is already visible in the parent session history.
// Affected OpenClaw version: v2026.6.11.
// Risk: A later announce can be credited as delivered when a prior assistant
// message contains the same sufficiently long normalized completion text.
// Remove when: OpenClaw coalesces sibling completion announces or natively
// credits a child whose result was included by an earlier parent announce.
// Upstream tracking: TODO(openclaw): report sibling completion announce
// duplication after sessions_yield batch completion.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

const MIN_VISIBLE_COMPLETION_CHARS = 16;

function normalizeVisibleCompletionText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function isVisibleCompletionTextMatch(expected, candidate) {
  const expectedText = normalizeVisibleCompletionText(expected);
  if (expectedText.length < MIN_VISIBLE_COMPLETION_CHARS) return false;
  return normalizeVisibleCompletionText(candidate).includes(expectedText);
}

function replaceOnce(content, from, to) {
  if (content.includes(to)) return { content, changed: false };
  if (!content.includes(from)) return { content, changed: false };
  return { content: content.replace(from, to), changed: true };
}

function replaceOnceAfter(content, marker, from, to) {
  if (content.includes(to)) return { content, changed: false };
  const markerIndex = content.indexOf(marker);
  if (markerIndex === -1) return { content, changed: false };
  const suffix = content.slice(markerIndex);
  if (!suffix.includes(from)) return { content, changed: false };
  return {
    content: content.slice(0, markerIndex) + suffix.replace(from, to),
    changed: true,
  };
}

function patchFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  let content = fs.readFileSync(filePath, 'utf8');
  if (
    content.includes('const hasPriorRequesterVisibleCompletion = async (entry)') &&
    content.includes('if (await hasPriorRequesterVisibleCompletion(entry)) return true')
  ) {
    return false;
  }

  const helperAnchor = '  const hasPriorRequesterDeliveryMirror = async (entry) => {';
  const helper = `  const hasPriorRequesterVisibleCompletion = async (entry) => {
    const hasDeliveredSibling = [...params.runs.values()].some((candidate) => candidate.runId !== entry.runId && candidate.requesterSessionKey === entry.requesterSessionKey && (candidate.delivery?.status === "delivered" || typeof candidate.delivery?.announcedAt === "number"));
    if (!hasDeliveredSibling) return false;
    const expectedText = extractTextFromChatContent(ensureCompletionState(entry).resultText, { joinWith: "" })?.replace(/\\s+/g, " ").trim();
    if (!expectedText || expectedText.length < ${MIN_VISIBLE_COMPLETION_CHARS}) return false;
    const notBefore = entry.startedAt ?? entry.createdAt;
    try {
      const messages = (await params.callGateway({
        method: "chat.history",
        params: {
          sessionKey: entry.requesterSessionKey,
          limit: 25,
          maxChars: DELIVERY_MIRROR_HISTORY_MAX_CHARS
        },
        timeoutMs: 5e3
      })).messages;
      return Array.isArray(messages) && messages.some((message2) => {
        if (!message2 || typeof message2 !== "object" || message2.role !== "assistant") return false;
        const timestamp = message2.timestamp;
        if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp < notBefore) return false;
        const candidateText = extractTextFromChatContent(message2.content, { joinWith: "" })?.replace(/\\s+/g, " ").trim();
        return typeof candidateText === "string" && candidateText.includes(expectedText);
      });
    } catch {
      return false;
    }
  };
${helperAnchor}`;

  let result = replaceOnce(content, helperAnchor, helper);
  if (!result.changed) return false;
  content = result.content;

  result = replaceOnce(
    content,
    '    params.runSubagentAnnounceFlow({',
    '    (async () => {\n      if (await hasPriorRequesterVisibleCompletion(entry)) return true;\n      return await params.runSubagentAnnounceFlow({',
  );
  if (!result.changed) return false;
  content = result.content;

  result = replaceOnceAfter(
    content,
    '    (async () => {\n      if (await hasPriorRequesterVisibleCompletion(entry)) return true;',
    '      }\n    }).then((didAnnounce) => {\n      finalizeAnnounceCleanup(didAnnounce);',
    '      }\n      });\n    })().then((didAnnounce) => {\n      finalizeAnnounceCleanup(didAnnounce);',
  );
  if (!result.changed) return false;
  content = result.content;

  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function applyPatch(runtimeDir, options = {}) {
  const filePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  const patched = patchFile(filePath) ? ['gateway-bundle.mjs'] : [];
  const label = options.label || 'patch-openclaw-dedupe-visible-subagent-announces';
  if (patched.length > 0) {
    console.log(`[${label}] Patched visible sibling subagent announce dedupe.`);
  } else if (options.verbose) {
    console.log(`[${label}] No visible sibling subagent announce patch needed.`);
  }
  return patched;
}

module.exports = {
  applyPatch,
  isVisibleCompletionTextMatch,
  normalizeVisibleCompletionText,
};
